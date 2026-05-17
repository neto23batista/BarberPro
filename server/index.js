require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const {
  DEMO_RESET_CONFIRMATION,
  getStoreInfo,
  id,
  initializeStore,
  isoNow,
  PersistenceUnavailableError,
  readData,
  refreshStoreHealth,
  resetDemoData,
  mutateData,
  sanitizeUser
} = require('./store');

const app = express();
const PORT = Number(process.env.PORT || 3333);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? null : 'barberpro-dev-secret-change-me');
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'barberpro_session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const BLOCKING_STATUSES = ['scheduled', 'confirmed', 'in_service'];
const TERMINAL_STATUSES = ['finished', 'cancelled', 'no_show'];
const ADMIN_ROLES = ['admin', 'owner', 'attendant'];
const OWNER_ROLES = ['admin', 'owner'];
const INVENTORY_ROLES = ['admin', 'owner', 'attendant'];
const PAYMENT_METHODS = ['cash', 'card', 'pix', 'online'];
const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show'];
const RECONCILIATION_RULE_VERSION = 'expired-items-v1';
const APPOINTMENT_NO_SHOW_GRACE_MINUTES = 30;
const APPOINTMENT_FINISH_GRACE_MINUTES = 90;
const REMINDER_EXPIRATION_GRACE_MINUTES = 30;
const WAITLIST_MAX_AGE_DAYS = 14;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET é obrigatório em produção.');
}

if (IS_PRODUCTION && /(troque|change|secret|dev|barberpro)/i.test(JWT_SECRET)) {
  throw new Error('JWT_SECRET de producao nao pode usar valor padrao ou placeholder.');
}

const allowedOrigins = Array.from(
  new Set(
    [
      ...(process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3333')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`
    ]
  )
);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...allowedOrigins],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origem não permitida pelo CORS.'));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

function toMinutes(time) {
  const [hours, minutes] = String(time || '00:00')
    .split(':')
    .map(Number);
  return hours * 60 + minutes;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function fromMinutes(total) {
  if (!Number.isFinite(total) || total < 0 || total > 24 * 60) return null;
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function overlaps(startA, endA, startB, endB) {
  return toMinutes(startA) < toMinutes(endB) && toMinutes(endA) > toMinutes(startB);
}

function endTime(startTime, durationMinutes) {
  return fromMinutes(toMinutes(startTime) + Number(durationMinutes || 0));
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function dateKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function hoursUntil(date, time) {
  const target = new Date(`${date}T${time || '00:00'}:00`);
  return (target.getTime() - Date.now()) / (60 * 60 * 1000);
}

function combineLocalDateTime(date, time = '00:00') {
  if (!isValidDate(date) || !isValidTime(time)) return null;
  const value = new Date(`${date}T${time}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function minutesAfter(date, time, nowDate = new Date()) {
  const target = combineLocalDateTime(date, time);
  if (!target) return Number.NEGATIVE_INFINITY;
  return (nowDate.getTime() - target.getTime()) / (60 * 1000);
}

function daysAfterDate(date, nowDate = new Date()) {
  if (!isValidDate(date)) return Number.NEGATIVE_INFINITY;
  const target = new Date(`${date}T00:00:00`);
  const today = new Date(`${dateKey(nowDate)}T00:00:00`);
  return Math.floor((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
}

function isIsoBeforeGrace(value, graceMinutes, nowDate = new Date()) {
  if (!value) return false;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return false;
  return nowDate.getTime() - target.getTime() > graceMinutes * 60 * 1000;
}

function sendError(res, status, message, details) {
  return res.status(status).json({ error: message, details });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendPersistenceError(res, error) {
  const persistence = getStoreInfo();
  return res.status(error.statusCode || 503).json({
    error: error.message,
    code: error.code || 'PERSISTENCE_UNAVAILABLE',
    persistence
  });
}

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function getAuthToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/'
  });
}

function audit(data, user, action, entity, entityId, details, req) {
  data.auditLogs.unshift({
    id: id('log'),
    userId: user?.id || 'public',
    action,
    entity,
    entityId,
    details,
    createdAt: isoNow(),
    ip: req?.ip || 'local'
  });
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      clientId: user.clientId || null,
      barberId: user.barberId || null
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function reviewTokenPayload(appointment) {
  return [
    appointment.id,
    appointment.clientId,
    appointment.barberId,
    appointment.createdAt || ''
  ].join(':');
}

function reviewTokenSignature(appointment) {
  return crypto
    .createHmac('sha256', JWT_SECRET)
    .update(reviewTokenPayload(appointment))
    .digest('base64url');
}

function signReviewToken(appointment) {
  return `${appointment.id}.${reviewTokenSignature(appointment)}`;
}

function verifyReviewToken(data, token) {
  const [appointmentId, signature, extra] = String(token || '').split('.');
  if (!appointmentId || !signature || extra !== undefined) return { invalid: true };

  const appointment = data.appointments.find((item) => item.id === appointmentId);
  if (!appointment) return { notFound: true };

  const expectedSignature = reviewTokenSignature(appointment);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return { invalid: true };
  }

  return { appointment };
}

function authenticate(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return sendError(res, 401, 'Sessão obrigatória.');

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const data = readData();
    const user = data.users.find((item) => item.id === payload.sub && item.status === 'active');
    if (!user) return sendError(res, 401, 'Usuário não encontrado ou inativo.');
    req.authUser = sanitizeUser(user);
    next();
  } catch (error) {
    return sendError(res, 401, 'Sessão inválida ou expirada.');
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.authUser.role)) {
      return sendError(res, 403, 'Seu perfil não tem permissão para esta ação.');
    }
    next();
  };
}

function findClientForUser(user, data) {
  if (!user) return null;
  return data.clients.find((client) => client.id === user.clientId || client.userId === user.id) || null;
}

function findBarberForUser(user, data) {
  if (!user) return null;
  return data.barbers.find((barber) => barber.id === user.barberId || barber.userId === user.id) || null;
}

function canSeeAppointment(user, appointment, data) {
  if (ADMIN_ROLES.includes(user.role)) return true;
  if (user.role === 'barber') return appointment.barberId === user.barberId;
  if (user.role === 'client') {
    const client = findClientForUser(user, data);
    return client && appointment.clientId === client.id;
  }
  return false;
}

function clientView(client, user) {
  if (!client) return null;
  if (user && (ADMIN_ROLES.includes(user.role) || user.clientId === client.id)) return client;
  if (user?.role === 'barber') {
    return {
      id: client.id,
      name: client.name,
      phone: client.phone,
      tags: client.tags || []
    };
  }
  return {
    id: client.id,
    name: client.name
  };
}

function barberScopedView(barber, user) {
  if (!barber) return null;
  if (user && (ADMIN_ROLES.includes(user.role) || user.barberId === barber.id)) return barber;
  return publicBarberView(barber);
}

function paymentView(payment, user) {
  if (!payment) return null;
  const base = {
    id: payment.id,
    appointmentId: payment.appointmentId,
    amount: payment.amount,
    method: payment.method,
    status: payment.status,
    paidAt: payment.paidAt || null
  };
  if (user && ADMIN_ROLES.includes(user.role)) return payment;
  return base;
}

function appointmentView(appointment, data, user = null) {
  const client = data.clients.find((item) => item.id === appointment.clientId);
  const barber = data.barbers.find((item) => item.id === appointment.barberId);
  const service = data.services.find((item) => item.id === appointment.serviceId);
  const unit = data.units.find((item) => item.id === appointment.unitId);
  const payment = data.payments.find((item) => item.appointmentId === appointment.id);
  const review = data.reviews.find((item) => item.appointmentId === appointment.id);
  const view = {
    ...appointment,
    client: clientView(client, user),
    barber: barberScopedView(barber, user),
    service,
    unit,
    payment: paymentView(payment, user),
    review,
    reviewToken: appointment.status === 'finished' && !review ? signReviewToken(appointment) : null,
    value: service?.price || payment?.amount || 0
  };
  if (!user || !ADMIN_ROLES.includes(user.role)) {
    delete view.internalNotes;
  }
  return view;
}

function publicReviewRequestView(appointment, data) {
  const client = data.clients.find((item) => item.id === appointment.clientId);
  const barber = data.barbers.find((item) => item.id === appointment.barberId);
  const service = data.services.find((item) => item.id === appointment.serviceId);
  const unit = data.units.find((item) => item.id === appointment.unitId);
  const review = data.reviews.find((item) => item.appointmentId === appointment.id);

  return {
    appointment: {
      code: appointment.code,
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      status: appointment.status,
      clientName: client?.name || 'Cliente',
      barber: barber ? publicBarberView(barber) : null,
      service: service
        ? {
            id: service.id,
            name: service.name,
            durationMinutes: service.durationMinutes,
            price: service.price,
            color: service.color
          }
        : null,
      unit: unit
        ? {
            id: unit.id,
            name: unit.name,
            address: unit.address
          }
        : null,
      alreadyReviewed: Boolean(review),
      canReview: appointment.status === 'finished' && !review
    },
    review: review
      ? {
          rating: review.rating,
          createdAt: review.createdAt
        }
      : null
  };
}

function createAppointmentReview(data, appointment, rating, comment, options = {}) {
  if (appointment.status !== 'finished') return { notFinished: true };
  if (data.reviews.some((item) => item.appointmentId === appointment.id)) return { duplicate: true };

  const normalizedRating = Number(rating);
  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) return { invalidRating: true };

  const review = {
    id: id('rev'),
    appointmentId: appointment.id,
    clientId: appointment.clientId,
    barberId: appointment.barberId,
    rating: normalizedRating,
    comment: cleanText(comment, 600),
    createdAt: isoNow()
  };
  data.reviews.unshift(review);
  audit(
    data,
    options.auditUser || null,
    options.auditAction || 'review_created',
    'review',
    review.id,
    'Avaliação registrada.',
    options.req
  );
  return { review };
}

function operationalReconciliationRules() {
  return [
    {
      key: 'appointment_no_show',
      label: 'Agendamentos sem atendimento',
      description: `Agendamentos scheduled/confirmed vencidos ha mais de ${APPOINTMENT_NO_SHOW_GRACE_MINUTES} minutos viram no_show.`
    },
    {
      key: 'appointment_finished',
      label: 'Atendimentos esquecidos em execucao',
      description: `Agendamentos in_service vencidos ha mais de ${APPOINTMENT_FINISH_GRACE_MINUTES} minutos viram finished com pagamento pendente quando necessario.`
    },
    {
      key: 'reminder_expired',
      label: 'Lembretes vencidos',
      description: `Notificacoes scheduled com horario passado ha mais de ${REMINDER_EXPIRATION_GRACE_MINUTES} minutos viram expired.`
    },
    {
      key: 'waitlist_expired',
      label: 'Fila de espera antiga',
      description: `Itens waiting expiram quando a data preferida passou ou quando ficam mais de ${WAITLIST_MAX_AGE_DAYS} dias sem data preferida.`
    }
  ];
}

function emptyReconciliationSummary() {
  return {
    totalUpdated: 0,
    appointmentsFinished: 0,
    appointmentsNoShow: 0,
    remindersExpired: 0,
    waitlistExpired: 0
  };
}

function appendReconciliationMarker(entity, nowIso, previousStatus, reason) {
  entity.reconciledAt = nowIso;
  entity.reconciliationRule = RECONCILIATION_RULE_VERSION;
  entity.reconciliationPreviousStatus = previousStatus;
  entity.reconciliationReason = reason;
}

function reconciliationEvent(type, entity, previousStatus, nextStatus, message, nowIso, extra = {}) {
  return {
    id: id('rec'),
    type,
    entity,
    entityId: extra.entityId,
    label: extra.label,
    previousStatus,
    nextStatus,
    message,
    createdAt: nowIso
  };
}

function finishStaleAppointment(data, appointment, nowIso) {
  const previousStatus = appointment.status;
  const service = data.services.find((item) => item.id === appointment.serviceId);
  const barber = data.barbers.find((item) => item.id === appointment.barberId);
  const client = data.clients.find((item) => item.id === appointment.clientId);

  appointment.status = 'finished';
  appointment.paymentStatus = appointment.paymentStatus === 'paid' ? 'paid' : 'pending';
  appointment.updatedAt = nowIso;
  appendReconciliationMarker(
    appointment,
    nowIso,
    previousStatus,
    'Atendimento estava em andamento depois do horario final e foi finalizado operacionalmente.'
  );

  const existingPayment = data.payments.find((item) => item.appointmentId === appointment.id);
  if (existingPayment) {
    existingPayment.method = existingPayment.method || appointment.paymentMethod || 'pix';
    if (existingPayment.status !== 'paid') existingPayment.status = 'pending';
    if (existingPayment.status === 'paid' && !existingPayment.paidAt) existingPayment.paidAt = nowIso;
    existingPayment.updatedAt = nowIso;
  } else {
    data.payments.push({
      id: id('pay'),
      appointmentId: appointment.id,
      clientId: appointment.clientId,
      barberId: appointment.barberId,
      amount: service?.price || 0,
      method: appointment.paymentMethod || 'pix',
      status: appointment.paymentStatus === 'paid' ? 'paid' : 'pending',
      paidAt: appointment.paymentStatus === 'paid' ? nowIso : null,
      gatewayReference: null,
      createdAt: nowIso
    });
  }

  const existingCommission = data.commissions.find((item) => item.appointmentId === appointment.id);
  if (!existingCommission && barber && service) {
    data.commissions.push({
      id: id('com'),
      appointmentId: appointment.id,
      barberId: barber.id,
      amount: money(service.price * barber.commissionRate),
      rate: barber.commissionRate,
      status: 'available',
      date: appointment.date
    });
  }

  if (client && previousStatus !== 'finished') {
    client.visits = Number(client.visits || 0) + 1;
    client.loyaltyPoints = Number(client.loyaltyPoints || 0) + Math.round((service?.price || 0) * data.loyaltyRules.pointsPerCurrency);
  }
}

function markStaleAppointmentNoShow(data, appointment, nowIso) {
  const previousStatus = appointment.status;
  const client = data.clients.find((item) => item.id === appointment.clientId);
  appointment.status = 'no_show';
  if (appointment.paymentStatus !== 'paid') appointment.paymentStatus = 'cancelled';
  appointment.updatedAt = nowIso;
  appendReconciliationMarker(
    appointment,
    nowIso,
    previousStatus,
    'Agendamento passou do horario final sem inicio/finalizacao e foi marcado como falta.'
  );

  const payment = data.payments.find((item) => item.appointmentId === appointment.id);
  if (payment && payment.status !== 'paid') {
    payment.status = 'cancelled';
    payment.updatedAt = nowIso;
  }

  const commission = data.commissions.find((item) => item.appointmentId === appointment.id);
  if (commission) commission.status = 'cancelled';
  if (client && previousStatus !== 'no_show') client.noShows = Number(client.noShows || 0) + 1;
}

function shouldExpireWaitlistItem(item, nowDate) {
  if (item.status !== 'waiting') return false;
  if (item.preferredDate && daysAfterDate(item.preferredDate, nowDate) > 0) return true;
  if (!item.preferredDate && item.createdAt) {
    const createdAt = new Date(item.createdAt);
    if (!Number.isNaN(createdAt.getTime())) {
      return daysAfterDate(dateKey(createdAt), nowDate) > WAITLIST_MAX_AGE_DAYS;
    }
  }
  return false;
}

function reconcileOperationalData(data, options = {}) {
  const nowDate = options.nowDate || new Date();
  const nowIso = isoNow(nowDate);
  const summary = emptyReconciliationSummary();
  const events = [];

  for (const appointment of data.appointments || []) {
    if (appointment.status === 'in_service' && minutesAfter(appointment.date, appointment.endTime, nowDate) > APPOINTMENT_FINISH_GRACE_MINUTES) {
      finishStaleAppointment(data, appointment, nowIso);
      summary.appointmentsFinished += 1;
      events.push(
        reconciliationEvent(
          'appointment_finished',
          'appointment',
          'in_service',
          'finished',
          'Atendimento em andamento foi finalizado por vencimento operacional.',
          nowIso,
          { entityId: appointment.id, label: appointment.code }
        )
      );
      continue;
    }

    if (['scheduled', 'confirmed'].includes(appointment.status) && minutesAfter(appointment.date, appointment.endTime, nowDate) > APPOINTMENT_NO_SHOW_GRACE_MINUTES) {
      const previousStatus = appointment.status;
      markStaleAppointmentNoShow(data, appointment, nowIso);
      summary.appointmentsNoShow += 1;
      events.push(
        reconciliationEvent(
          'appointment_no_show',
          'appointment',
          previousStatus,
          'no_show',
          'Agendamento passado foi marcado como falta.',
          nowIso,
          { entityId: appointment.id, label: appointment.code }
        )
      );
    }
  }

  for (const notification of data.notifications || []) {
    if (notification.status === 'scheduled' && isIsoBeforeGrace(notification.scheduledFor, REMINDER_EXPIRATION_GRACE_MINUTES, nowDate)) {
      const previousStatus = notification.status;
      notification.status = 'expired';
      notification.expiredAt = nowIso;
      appendReconciliationMarker(
        notification,
        nowIso,
        previousStatus,
        'Lembrete passou do horario agendado sem registro de envio.'
      );
      summary.remindersExpired += 1;
      events.push(
        reconciliationEvent(
          'reminder_expired',
          'notification',
          previousStatus,
          'expired',
          'Lembrete vencido foi retirado da fila ativa.',
          nowIso,
          { entityId: notification.id, label: notification.title }
        )
      );
    }
  }

  for (const item of data.waitlist || []) {
    if (shouldExpireWaitlistItem(item, nowDate)) {
      const previousStatus = item.status;
      item.status = 'expired';
      item.expiredAt = nowIso;
      appendReconciliationMarker(
        item,
        nowIso,
        previousStatus,
        'Item da fila de espera passou da data preferida ou ficou antigo demais.'
      );
      summary.waitlistExpired += 1;
      events.push(
        reconciliationEvent(
          'waitlist_expired',
          'waitlist',
          previousStatus,
          'expired',
          'Item antigo da fila de espera foi expirado.',
          nowIso,
          { entityId: item.id, label: item.period || item.preferredDate || item.id }
        )
      );
    }
  }

  summary.totalUpdated =
    summary.appointmentsFinished +
    summary.appointmentsNoShow +
    summary.remindersExpired +
    summary.waitlistExpired;

  if (summary.totalUpdated > 0 || options.recordRun) {
    const previousEvents = Array.isArray(data.operationalReconciliation?.events)
      ? data.operationalReconciliation.events
      : [];
    data.operationalReconciliation = {
      ruleVersion: RECONCILIATION_RULE_VERSION,
      lastRunAt: nowIso,
      lastRunBy: options.user?.id || 'system',
      summary,
      rules: operationalReconciliationRules(),
      events: [...events, ...previousEvents].slice(0, 40)
    };
    if (summary.totalUpdated > 0) {
      audit(
        data,
        options.user || { id: 'system' },
        'operational_reconciliation',
        'system',
        'expired-items',
        `Reconciliacao operacional atualizou ${summary.totalUpdated} item(ns).`,
        options.req
      );
    }
  }

  return {
    updated: summary.totalUpdated > 0,
    summary,
    events,
    operationalReconciliation: operationalReconciliationView(data.operationalReconciliation, options.user)
  };
}

function operationalReconciliationView(state, user = null) {
  const summary = state?.summary || emptyReconciliationSummary();
  const canSeeEvents = !user || ADMIN_ROLES.includes(user.role);
  return {
    ruleVersion: state?.ruleVersion || RECONCILIATION_RULE_VERSION,
    lastRunAt: state?.lastRunAt || null,
    lastRunBy: state?.lastRunBy || null,
    summary,
    rules: state?.rules || operationalReconciliationRules(),
    events: canSeeEvents ? (state?.events || []) : []
  };
}

async function runOperationalReconciliation(options = {}) {
  const persistence = getStoreInfo();
  if (!persistence.writable || persistence.readOnly) {
    return {
      skipped: true,
      reason: persistence.message,
      summary: emptyReconciliationSummary(),
      operationalReconciliation: operationalReconciliationView(readData().operationalReconciliation, options.user)
    };
  }

  return mutateData((data) => reconcileOperationalData(data, options));
}

function businessWindow(data, date) {
  const dateAtNoon = new Date(`${date}T12:00:00`);
  const weekday = dateAtNoon.getDay();
  const holiday = data.settings.holidays.find((item) => item.date === date);
  const day = data.settings.businessHours[weekday];

  if (!day || day.closed || holiday) {
    return {
      closed: true,
      reason: holiday?.reason || day?.label || 'Fechado'
    };
  }

  return {
    closed: false,
    open: day.open,
    close: day.close,
    label: day.label
  };
}

function validateSchedule(data, draft, options = {}) {
  const service = data.services.find((item) => item.id === draft.serviceId && item.active);
  const barber = data.barbers.find((item) => item.id === draft.barberId && item.status === 'active');
  const client = data.clients.find((item) => item.id === draft.clientId);
  const unit = data.units.find((item) => item.id === draft.unitId && item.status === 'active');

  if (!service) return { ok: false, message: 'Serviço não encontrado ou inativo.' };
  if (!barber) return { ok: false, message: 'Barbeiro não encontrado ou inativo.' };
  if (!client) return { ok: false, message: 'Cliente não encontrado.' };
  if (!unit) return { ok: false, message: 'Unidade não encontrada ou inativa.' };
  if (!isValidDate(draft.date)) return { ok: false, message: 'Data inválida.' };
  if (!isValidTime(draft.startTime)) return { ok: false, message: 'Horário inicial inválido.' };
  if (!options.allowPast && draft.date < dateKey()) return { ok: false, message: 'Nao e permitido agendar em datas passadas.' };
  if (!service.barberIds.includes(barber.id)) {
    return { ok: false, message: 'O barbeiro selecionado não realiza este serviço.' };
  }

  if (Array.isArray(barber.unitIds) && barber.unitIds.length > 0 && !barber.unitIds.includes(unit.id)) {
    return { ok: false, message: 'O barbeiro selecionado nao atende nesta unidade.' };
  }

  const startTime = draft.startTime;
  const finishTime = draft.endTime || endTime(startTime, service.durationMinutes);
  if (!isValidTime(finishTime)) return { ok: false, message: 'Horário final inválido para a duração do serviço.' };
  if (toMinutes(startTime) >= toMinutes(finishTime)) return { ok: false, message: 'Horario final deve ser maior que o inicial.' };
  const window = businessWindow(data, draft.date);

  if (window.closed && !options.allowFitIn) {
    return { ok: false, message: `A barbearia está fechada nesta data: ${window.reason}.` };
  }

  if (!window.closed && !options.allowFitIn) {
    if (toMinutes(startTime) < toMinutes(window.open) || toMinutes(finishTime) > toMinutes(window.close)) {
      return { ok: false, message: `Horário fora do funcionamento (${window.open} às ${window.close}).` };
    }
  }

  const blocked = (barber.blocks || []).find(
    (block) =>
      block.date === draft.date && overlaps(startTime, finishTime, block.startTime, block.endTime)
  );
  if (blocked && !options.allowFitIn) {
    return { ok: false, message: `Barbeiro indisponível: ${blocked.reason}.` };
  }

  const conflict = data.appointments.find(
    (appointment) =>
      appointment.id !== options.ignoreAppointmentId &&
      appointment.barberId === barber.id &&
      appointment.date === draft.date &&
      BLOCKING_STATUSES.includes(appointment.status) &&
      overlaps(startTime, finishTime, appointment.startTime, appointment.endTime)
  );

  if (conflict && !options.allowFitIn) {
    return {
      ok: false,
      message: 'Este horário já está ocupado.',
      conflict: appointmentView(conflict, data, options.viewer || null)
    };
  }

  return {
    ok: true,
    service,
    barber,
    client,
    endTime: finishTime,
    conflict: conflict ? appointmentView(conflict, data, options.viewer || null) : null
  };
}

function availabilityFor(data, query) {
  const { date, serviceId, barberId } = query;
  const service = data.services.find((item) => item.id === serviceId && item.active);
  if (!isValidDate(date) || !service) return [];

  const barbers = data.barbers
    .filter((barber) => barber.status === 'active')
    .filter((barber) => (barberId ? barber.id === barberId : service.barberIds.includes(barber.id)));

  const window = businessWindow(data, date);
  if (window.closed) {
    return barbers.map((barber) => ({
      barberId: barber.id,
      barberName: barber.name,
      closed: true,
      reason: window.reason,
      slots: []
    }));
  }

  const interval = data.settings.appointmentRules.slotIntervalMinutes || 30;

  return barbers.map((barber) => {
    const slots = [];
    for (
      let cursor = toMinutes(window.open);
      cursor + service.durationMinutes <= toMinutes(window.close);
      cursor += interval
    ) {
      const startTime = fromMinutes(cursor);
      const finishTime = endTime(startTime, service.durationMinutes);
      const conflict = data.appointments.find(
        (appointment) =>
          appointment.barberId === barber.id &&
          appointment.date === date &&
          BLOCKING_STATUSES.includes(appointment.status) &&
          overlaps(startTime, finishTime, appointment.startTime, appointment.endTime)
      );
      const blocked = (barber.blocks || []).find(
        (block) => block.date === date && overlaps(startTime, finishTime, block.startTime, block.endTime)
      );

      slots.push({
        startTime,
        endTime: finishTime,
        available: !conflict && !blocked,
        reason: conflict ? 'ocupado' : blocked ? blocked.reason : null
      });
    }

    return {
      barberId: barber.id,
      barberName: barber.name,
      closed: false,
      open: window.open,
      close: window.close,
      slots
    };
  });
}

function calculateReports(data) {
  const today = dateKey();
  const currentMonth = today.slice(0, 7);
  const paidPayments = data.payments.filter((payment) => payment.status === 'paid');
  const finishedAppointments = data.appointments.filter((appointment) => appointment.status === 'finished');
  const activeAppointments = data.appointments.filter((appointment) => appointment.status !== 'cancelled');
  const revenueToday = paidPayments
    .filter((payment) => String(payment.paidAt || '').slice(0, 10) === today)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const revenueMonth = paidPayments
    .filter((payment) => String(payment.paidAt || '').slice(0, 7) === currentMonth)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const totalRevenue = paidPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const paidExpenses = data.expenses
    .filter((expense) => expense.status === 'paid')
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const stockCost = data.stockMovements
    .filter((movement) => movement.type === 'usage' || movement.type === 'loss')
    .reduce((sum, movement) => sum + Number(movement.unitValue || 0) * Number(movement.quantity || 0), 0);

  const serviceMap = new Map();
  finishedAppointments.forEach((appointment) => {
    const service = data.services.find((item) => item.id === appointment.serviceId);
    if (!service) return;
    const item = serviceMap.get(service.id) || { name: service.name, total: 0, revenue: 0 };
    item.total += 1;
    item.revenue += Number(service.price || 0);
    serviceMap.set(service.id, item);
  });

  const barberPerformance = data.barbers.map((barber) => {
    const appointments = finishedAppointments.filter((appointment) => appointment.barberId === barber.id);
    const revenue = appointments.reduce((sum, appointment) => {
      const service = data.services.find((item) => item.id === appointment.serviceId);
      return sum + Number(service?.price || 0);
    }, 0);
    const reviews = data.reviews.filter((review) => review.barberId === barber.id);
    const rating =
      reviews.length > 0
        ? money(reviews.reduce((sum, review) => sum + Number(review.rating), 0) / reviews.length)
        : barber.rating;
    return {
      name: barber.name,
      appointments: appointments.length,
      revenue: money(revenue),
      goal: barber.goalMonthly,
      rating
    };
  });

  const busyHours = Array.from({ length: 14 }, (_, index) => {
    const hour = index + 8;
    const label = `${String(hour).padStart(2, '0')}:00`;
    return {
      hour: label,
      total: activeAppointments.filter((appointment) => appointment.startTime.startsWith(String(hour).padStart(2, '0'))).length
    };
  });

  const monthlyRevenue = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (5 - index));
    const month = date.toISOString().slice(0, 7);
    return {
      month,
      revenue: money(
        paidPayments
          .filter((payment) => String(payment.paidAt || '').slice(0, 7) === month)
          .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
      ),
      appointments: data.appointments.filter((appointment) => appointment.date.slice(0, 7) === month).length
    };
  });

  const productSales = data.stockMovements
    .filter((movement) => movement.type === 'sale')
    .reduce((acc, movement) => {
      const product = data.products.find((item) => item.id === movement.productId);
      const key = product?.name || 'Produto';
      acc[key] = (acc[key] || 0) + Number(movement.quantity || 0);
      return acc;
    }, {});

  return {
    kpis: {
      revenueToday: money(revenueToday),
      revenueMonth: money(revenueMonth),
      totalRevenue: money(totalRevenue),
      estimatedProfit: money(totalRevenue - paidExpenses - stockCost),
      totalAppointments: data.appointments.length,
      averageTicket: paidPayments.length ? money(totalRevenue / paidPayments.length) : 0,
      cancellationRate: data.appointments.length
        ? money((data.appointments.filter((item) => item.status === 'cancelled').length / data.appointments.length) * 100)
        : 0,
      noShowRate: data.appointments.length
        ? money((data.appointments.filter((item) => item.status === 'no_show').length / data.appointments.length) * 100)
        : 0,
      lowStock: data.products.filter((product) => product.quantity <= product.minStock).length
    },
    serviceRanking: Array.from(serviceMap.values()).sort((a, b) => b.total - a.total),
    barberPerformance,
    frequentClients: [...data.clients].sort((a, b) => b.visits - a.visits).slice(0, 8),
    busyHours,
    monthlyRevenue,
    productSales: Object.entries(productSales).map(([name, total]) => ({ name, total })),
    lowStockProducts: data.products.filter((product) => product.quantity <= product.minStock)
  };
}

function publicBarberView(barber) {
  if (!barber) return null;
  return {
    id: barber.id,
    name: barber.name,
    bio: barber.bio,
    specialties: barber.specialties,
    rating: barber.rating,
    unitIds: barber.unitIds,
    status: barber.status
  };
}

function publicSettingsView(settings) {
  return {
    barbershopName: settings.barbershopName,
    defaultUnitId: settings.defaultUnitId,
    timezone: settings.timezone,
    currency: settings.currency,
    whatsappNumber: settings.whatsappNumber,
    appointmentRules: {
      slotIntervalMinutes: settings.appointmentRules.slotIntervalMinutes,
      cancellationLimitHours: settings.appointmentRules.cancellationLimitHours,
      allowClientReschedule: settings.appointmentRules.allowClientReschedule
    },
    businessHours: settings.businessHours,
    holidays: settings.holidays
  };
}

function scopedReportsForUser(user, data) {
  if (ADMIN_ROLES.includes(user.role)) return calculateReports(data);

  const appointments = data.appointments.filter((appointment) => canSeeAppointment(user, appointment, data));
  const appointmentIds = new Set(appointments.map((appointment) => appointment.id));
  const clientIds = new Set(appointments.map((appointment) => appointment.clientId));
  const barberIds = new Set(appointments.map((appointment) => appointment.barberId));

  return calculateReports({
    ...data,
    appointments,
    payments: data.payments.filter((payment) => appointmentIds.has(payment.appointmentId)),
    commissions: data.commissions.filter((commission) => user.role === 'barber' && commission.barberId === user.barberId),
    reviews: data.reviews.filter((review) => appointmentIds.has(review.appointmentId)),
    clients: data.clients.filter((client) => clientIds.has(client.id) || client.id === user.clientId),
    barbers: data.barbers.filter((barber) => barberIds.has(barber.id) || barber.id === user.barberId),
    products: [],
    stockMovements: [],
    expenses: []
  });
}

function dashboardPayload(user, data) {
  const reports = scopedReportsForUser(user, data);
  const appointments = data.appointments
    .filter((appointment) => canSeeAppointment(user, appointment, data))
    .map((appointment) => appointmentView(appointment, data, user))
    .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`));

  return {
    user,
    reports,
    appointments,
    clients: ADMIN_ROLES.includes(user.role)
      ? data.clients
      : data.clients.filter((client) => client.id === user.clientId).map((client) => clientView(client, user)),
    barbers: ADMIN_ROLES.includes(user.role) || user.role === 'barber'
      ? data.barbers
      : data.barbers.map(publicBarberView),
    services: data.services,
    products: INVENTORY_ROLES.includes(user.role) ? data.products : [],
    stockMovements: INVENTORY_ROLES.includes(user.role) ? data.stockMovements : [],
    payments: ADMIN_ROLES.includes(user.role)
      ? data.payments
      : data.payments
          .filter((payment) => payment.clientId === user.clientId || payment.barberId === user.barberId)
          .map((payment) => paymentView(payment, user)),
    expenses: ADMIN_ROLES.includes(user.role) ? data.expenses : [],
    commissions: ADMIN_ROLES.includes(user.role)
      ? data.commissions
      : data.commissions.filter((commission) => commission.barberId === user.barberId),
    reviews: ADMIN_ROLES.includes(user.role)
      ? data.reviews
      : data.reviews.filter(
          (review) => review.clientId === user.clientId || review.barberId === user.barberId
        ),
    promotions: data.promotions.filter((promotion) => promotion.active || ADMIN_ROLES.includes(user.role)),
    coupons: data.coupons.filter((coupon) => ADMIN_ROLES.includes(user.role) || coupon.clientId === user.clientId),
    waitlist: ADMIN_ROLES.includes(user.role)
      ? data.waitlist
      : data.waitlist.filter((item) => item.clientId === user.clientId || item.barberId === user.barberId),
    units: data.units,
    settings: ADMIN_ROLES.includes(user.role) ? data.settings : publicSettingsView(data.settings),
    notifications: data.notifications.filter(
      (notification) => ADMIN_ROLES.includes(user.role) || notification.userId === user.id
    ),
    auditLogs: ADMIN_ROLES.includes(user.role) ? data.auditLogs.slice(0, 80) : [],
    operationalReconciliation: operationalReconciliationView(data.operationalReconciliation, user)
  };
}

app.get('/api/health', asyncRoute(async (req, res) => {
  const persistence = await refreshStoreHealth();
  res.status(persistence.writable ? 200 : 503).json({
    ok: persistence.writable,
    name: 'BarberPro API',
    version: '1.0.0',
    persistence,
    time: isoNow()
  });
}));

app.get('/api/public', (req, res) => {
  const data = readData();
  res.json({
    persistence: getStoreInfo(),
    settings: publicSettingsView(data.settings),
    units: data.units.filter((unit) => unit.status === 'active'),
    services: data.services.filter((service) => service.active),
    barbers: data.barbers.filter((barber) => barber.status === 'active').map(publicBarberView),
    promotions: data.promotions.filter((promotion) => promotion.active)
  });
});

app.get('/api/public/review-request', (req, res) => {
  const data = readData();
  const result = verifyReviewToken(data, req.query.token);

  if (result.invalid || result.notFound) return sendError(res, 404, 'Link de avaliação inválido.');
  return res.json(publicReviewRequestView(result.appointment, data));
});

app.post('/api/public/reviews', asyncRoute(async (req, res) => {
  const { token, rating, comment } = req.body || {};
  const result = await mutateData((data) => {
    const tokenResult = verifyReviewToken(data, token);
    if (tokenResult.invalid || tokenResult.notFound) return { invalidToken: true };

    const reviewResult = createAppointmentReview(data, tokenResult.appointment, rating, comment, {
      auditAction: 'review_created_public',
      req
    });
    if (!reviewResult.review) return reviewResult;

    return {
      ...publicReviewRequestView(tokenResult.appointment, data),
      review: reviewResult.review
    };
  });

  if (result.invalidToken) return sendError(res, 404, 'Link de avaliação inválido.');
  if (result.notFinished) return sendError(res, 409, 'Somente atendimentos finalizados podem ser avaliados.');
  if (result.invalidRating) return sendError(res, 400, 'Avaliação inválida.');
  if (result.duplicate) return sendError(res, 409, 'Este atendimento já foi avaliado.');
  return res.status(201).json(result);
}));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const { name, email, phone, password, birthDate } = req.body || {};
  if (!name || !email || !phone || !password) {
    return sendError(res, 400, 'Informe nome, e-mail, telefone e senha.');
  }
  if (!isValidEmail(email)) return sendError(res, 400, 'Informe um e-mail válido.');
  if (birthDate && !isValidDate(birthDate)) return sendError(res, 400, 'Data de aniversário inválida.');
  if (String(password).length < 6) return sendError(res, 400, 'A senha precisa ter pelo menos 6 caracteres.');

  const result = await mutateData((data) => {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (data.users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
      return { duplicate: true };
    }

    const userId = id('usr');
    const clientId = id('client');
    const user = {
      id: userId,
      role: 'client',
      name: String(name).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash: bcrypt.hashSync(password, 10),
      status: 'active',
      clientId,
      birthDate: birthDate || null,
      avatar: '',
      createdAt: isoNow()
    };
    const client = {
      id: clientId,
      userId,
      name: user.name,
      phone: user.phone,
      email: user.email,
      birthDate: birthDate || null,
      loyaltyPoints: 0,
      visits: 0,
      noShows: 0,
      preferredBarberId: null,
      notes: '',
      tags: ['novo cliente'],
      createdAt: isoNow()
    };

    data.users.push(user);
    data.clients.push(client);
    audit(data, sanitizeUser(user), 'register', 'client', clientId, 'Cliente cadastrado pelo portal.', req);
    return { user: sanitizeUser(user), sessionToken: signToken(user) };
  });

  if (result.duplicate) return sendError(res, 409, 'Já existe uma conta com este e-mail.');
  setSessionCookie(res, result.sessionToken);
  delete result.sessionToken;
  return res.status(201).json(result);
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return sendError(res, 400, 'Informe e-mail e senha.');

  const result = await mutateData((data) => {
    const user = data.users.find(
      (item) => item.email.toLowerCase() === String(email).trim().toLowerCase() && item.status === 'active'
    );
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) return { invalid: true };

    user.lastLoginAt = isoNow();
    audit(data, sanitizeUser(user), 'login', 'user', user.id, 'Login realizado.', req);
    return {
      user: sanitizeUser(user),
      sessionToken: signToken(user)
    };
  });

  if (result.invalid) return sendError(res, 401, 'E-mail ou senha inválidos.');
  setSessionCookie(res, result.sessionToken);
  delete result.sessionToken;
  res.json(result);
}));

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/recover', authLimiter, asyncRoute(async (req, res) => {
  const { email } = req.body || {};
  await mutateData((data) => {
    const user = data.users.find((item) => item.email.toLowerCase() === String(email || '').toLowerCase());
    if (user) {
      data.notifications.unshift({
        id: id('ntf'),
        userId: user.id,
        channel: 'email',
        title: 'Recuperação de senha',
        message: 'Link de recuperação gerado. Integre seu provedor de e-mail em produção.',
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null
      });
      audit(data, sanitizeUser(user), 'password_recovery_requested', 'user', user.id, 'Recuperação de senha solicitada.', req);
    }
  });
  res.json({ ok: true, message: 'Se o e-mail existir, enviaremos instruções de recuperação.' });
}));

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.authUser });
});

app.get('/api/dashboard', authenticate, asyncRoute(async (req, res) => {
  if (ADMIN_ROLES.includes(req.authUser.role) || req.authUser.role === 'barber') {
    await runOperationalReconciliation({ user: req.authUser, req });
  }
  const data = readData();
  res.json({
    ...dashboardPayload(req.authUser, data),
    persistence: getStoreInfo()
  });
}));

app.post('/api/operations/reconcile', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await runOperationalReconciliation({ user: req.authUser, req, recordRun: true });
  const data = readData();
  res.json({
    ...result,
    operationalReconciliation: operationalReconciliationView(data.operationalReconciliation, req.authUser),
    persistence: getStoreInfo()
  });
}));

app.get('/api/availability', (req, res) => {
  const data = readData();
  res.json({ availability: availabilityFor(data, req.query) });
});

app.get('/api/appointments', authenticate, (req, res) => {
  const data = readData();
  const { date, status, serviceId, barberId, clientId } = req.query;
  const appointments = data.appointments
    .filter((appointment) => canSeeAppointment(req.authUser, appointment, data))
    .filter((appointment) => (!date ? true : appointment.date === date))
    .filter((appointment) => (!status ? true : appointment.status === status))
    .filter((appointment) => (!serviceId ? true : appointment.serviceId === serviceId))
    .filter((appointment) => (!barberId ? true : appointment.barberId === barberId))
    .filter((appointment) => (!clientId ? true : appointment.clientId === clientId))
    .map((appointment) => appointmentView(appointment, data, req.authUser))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));

  res.json({ appointments });
});

app.post('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const result = await mutateData((data) => {
    const user = req.authUser;
    if (user.role === 'barber') return { forbidden: true };
    const client = user.role === 'client' ? findClientForUser(user, data) : data.clients.find((item) => item.id === body.clientId);
    const allowFitIn = Boolean(body.allowFitIn && ADMIN_ROLES.includes(user.role));
    const service = data.services.find((item) => item.id === body.serviceId);
    const status = ADMIN_ROLES.includes(user.role) && APPOINTMENT_STATUSES.includes(body.status)
      ? body.status
      : 'scheduled';
    const paymentMethod = PAYMENT_METHODS.includes(body.paymentMethod) ? body.paymentMethod : 'pix';
    const draft = {
      clientId: client?.id,
      barberId: body.barberId,
      serviceId: body.serviceId,
      unitId: body.unitId || data.settings.defaultUnitId,
      date: body.date,
      startTime: body.startTime,
      endTime: service ? endTime(body.startTime, service.durationMinutes) : body.endTime
    };
    const validation = validateSchedule(data, draft, { allowFitIn, viewer: user });
    if (!validation.ok) return { error: validation };

    const appointment = {
      id: id('apt'),
      code: `BP-${String(data.appointments.length + 1001).padStart(4, '0')}`,
      clientId: draft.clientId,
      barberId: draft.barberId,
      serviceId: draft.serviceId,
      unitId: draft.unitId,
      date: draft.date,
      startTime: draft.startTime,
      endTime: validation.endTime,
      status,
      paymentStatus: 'pending',
      paymentMethod,
      notes: cleanText(body.notes, 500),
      internalNotes: ADMIN_ROLES.includes(user.role) ? cleanText(body.internalNotes, 500) : '',
      isFitIn: Boolean(validation.conflict && allowFitIn),
      createdAt: isoNow(),
      updatedAt: isoNow()
    };

    data.appointments.push(appointment);
    data.notifications.push(
      {
        id: id('ntf'),
        userId: validation.client.userId,
        channel: 'whatsapp',
        title: 'Agendamento confirmado',
        message: `${validation.client.name}, seu horário foi agendado para ${appointment.date} às ${appointment.startTime}.`,
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null
      },
      {
        id: id('ntf'),
        userId: validation.client.userId,
        channel: 'whatsapp',
        title: 'Lembrete automático',
        message: `Lembrete BarberPro: atendimento ${appointment.code} em breve.`,
        status: 'scheduled',
        scheduledFor: `${appointment.date}T${appointment.startTime}:00.000Z`,
        sentAt: null
      }
    );
    audit(data, user, 'appointment_created', 'appointment', appointment.id, 'Agendamento criado.', req);
    return { appointment: appointmentView(appointment, data, user) };
  });

  if (result.forbidden) return sendError(res, 403, 'Barbeiros não podem criar agendamentos para outros clientes.');
  if (result.error) return sendError(res, result.error.conflict ? 409 : 400, result.error.message, result.error.conflict);
  res.status(201).json(result);
}));

app.post('/api/appointments/:id/status', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const { status, paymentStatus, paymentMethod } = req.body || {};
  if (!APPOINTMENT_STATUSES.includes(status)) return sendError(res, 400, 'Status inválido.');
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) return sendError(res, 400, 'Forma de pagamento inválida.');

  const result = await mutateData((data) => {
    const appointment = data.appointments.find((item) => item.id === req.params.id);
    if (!appointment) return { notFound: true };
    if (req.authUser.role === 'barber' && appointment.barberId !== req.authUser.barberId) return { forbidden: true };
    if (TERMINAL_STATUSES.includes(appointment.status) && appointment.status !== status && !OWNER_ROLES.includes(req.authUser.role)) {
      return { locked: true };
    }

    const previousStatus = appointment.status;
    appointment.status = status;
    appointment.updatedAt = isoNow();
    if (paymentStatus && ['pending', 'paid', 'cancelled', 'refunded'].includes(paymentStatus)) appointment.paymentStatus = paymentStatus;
    if (paymentMethod) appointment.paymentMethod = paymentMethod;

    const service = data.services.find((item) => item.id === appointment.serviceId);
    const barber = data.barbers.find((item) => item.id === appointment.barberId);
    const payment = data.payments.find((item) => item.appointmentId === appointment.id);
    if (payment) {
      payment.status = payment.status === 'paid' ? 'refunded' : 'cancelled';
      payment.updatedAt = isoNow();
    }
    const commission = data.commissions.find((item) => item.appointmentId === appointment.id);
    if (commission) {
      commission.status = 'cancelled';
    }
    const client = data.clients.find((item) => item.id === appointment.clientId);

    if (status === 'finished') {
      appointment.paymentStatus = paymentStatus || appointment.paymentStatus || 'paid';
      const existingPayment = data.payments.find((item) => item.appointmentId === appointment.id);
      if (existingPayment) {
        existingPayment.method = paymentMethod || existingPayment.method || appointment.paymentMethod || 'pix';
        existingPayment.status = appointment.paymentStatus === 'paid' ? 'paid' : 'pending';
        if (existingPayment.status === 'paid' && !existingPayment.paidAt) existingPayment.paidAt = isoNow();
      } else {
        data.payments.push({
          id: id('pay'),
          appointmentId: appointment.id,
          clientId: appointment.clientId,
          barberId: appointment.barberId,
          amount: service?.price || 0,
          method: paymentMethod || appointment.paymentMethod || 'pix',
          status: appointment.paymentStatus === 'paid' ? 'paid' : 'pending',
          paidAt: appointment.paymentStatus === 'paid' ? isoNow() : null,
          gatewayReference: null,
          createdAt: isoNow()
        });
      }
      const existingCommission = data.commissions.find((item) => item.appointmentId === appointment.id);
      if (!existingCommission && barber && service) {
        data.commissions.push({
          id: id('com'),
          appointmentId: appointment.id,
          barberId: barber.id,
          amount: money(service.price * barber.commissionRate),
          rate: barber.commissionRate,
          status: 'available',
          date: appointment.date
        });
      }
      if (client && previousStatus !== 'finished') {
        client.visits += 1;
        client.loyaltyPoints += Math.round((service?.price || 0) * data.loyaltyRules.pointsPerCurrency);
      }
    }

    if (status === 'no_show' && client && previousStatus !== 'no_show') client.noShows += 1;
    if (status !== 'no_show' && client && previousStatus === 'no_show') client.noShows = Math.max(0, client.noShows - 1);

    audit(data, req.authUser, 'appointment_status_changed', 'appointment', appointment.id, `Status alterado para ${status}.`, req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  });

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Este agendamento pertence a outro barbeiro.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser alterados por este perfil.');
  res.json(result);
}));

app.post('/api/appointments/:id/reschedule', authenticate, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const result = await mutateData((data) => {
    const appointment = data.appointments.find((item) => item.id === req.params.id);
    if (!appointment) return { notFound: true };
    if (!canSeeAppointment(req.authUser, appointment, data)) return { forbidden: true };
    if (TERMINAL_STATUSES.includes(appointment.status)) return { locked: true };
    if (req.authUser.role === 'client' && !data.settings.appointmentRules.allowClientReschedule) return { forbidden: true };
    if (req.authUser.role === 'barber' && body.barberId && body.barberId !== req.authUser.barberId) return { forbidden: true };

    const draft = {
      ...appointment,
      barberId: body.barberId || appointment.barberId,
      serviceId: body.serviceId || appointment.serviceId,
      date: body.date || appointment.date,
      startTime: body.startTime || appointment.startTime
    };
    const validation = validateSchedule(data, draft, {
      ignoreAppointmentId: appointment.id,
      allowFitIn: Boolean(body.allowFitIn && ADMIN_ROLES.includes(req.authUser.role)),
      viewer: req.authUser
    });
    if (!validation.ok) return { error: validation };

    appointment.barberId = draft.barberId;
    appointment.serviceId = draft.serviceId;
    appointment.date = draft.date;
    appointment.startTime = draft.startTime;
    appointment.endTime = validation.endTime;
    appointment.status = 'scheduled';
    appointment.updatedAt = isoNow();

    data.notifications.unshift({
      id: id('ntf'),
      userId: validation.client.userId,
      channel: 'whatsapp',
      title: 'Agendamento remarcado',
      message: `Seu atendimento foi remarcado para ${appointment.date} às ${appointment.startTime}.`,
      status: 'queued',
      scheduledFor: isoNow(),
      sentAt: null
    });
    audit(data, req.authUser, 'appointment_rescheduled', 'appointment', appointment.id, 'Agendamento remarcado.', req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  });

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode remarcar este atendimento.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser remarcados.');
  if (result.error) return sendError(res, result.error.conflict ? 409 : 400, result.error.message, result.error.conflict);
  res.json(result);
}));

app.post('/api/appointments/:id/cancel', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const appointment = data.appointments.find((item) => item.id === req.params.id);
    if (!appointment) return { notFound: true };
    if (!canSeeAppointment(req.authUser, appointment, data)) return { forbidden: true };
    if (TERMINAL_STATUSES.includes(appointment.status)) return { locked: true };
    if (req.authUser.role === 'client' && !['scheduled', 'confirmed'].includes(appointment.status)) return { forbidden: true };
    if (
      req.authUser.role === 'client' &&
      hoursUntil(appointment.date, appointment.startTime) < Number(data.settings.appointmentRules.cancellationLimitHours || 0)
    ) {
      return { tooLate: true };
    }

    appointment.status = 'cancelled';
    appointment.paymentStatus = appointment.paymentStatus === 'paid' ? 'refunded' : 'cancelled';
    appointment.cancellationReason = cleanText(req.body?.reason, 300) || 'Cancelado pelo usuário.';
    appointment.updatedAt = isoNow();
    const client = data.clients.find((item) => item.id === appointment.clientId);
    if (client?.userId) {
      data.notifications.unshift({
        id: id('ntf'),
        userId: client.userId,
        channel: 'whatsapp',
        title: 'Agendamento cancelado',
        message: `O atendimento ${appointment.code} foi cancelado.`,
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null
      });
    }
    audit(data, req.authUser, 'appointment_cancelled', 'appointment', appointment.id, appointment.cancellationReason, req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  });

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode cancelar este atendimento.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser cancelados.');
  if (result.tooLate) return sendError(res, 409, 'O prazo para cancelamento pelo cliente foi encerrado.');
  res.json(result);
}));

app.post('/api/reviews', authenticate, asyncRoute(async (req, res) => {
  const { appointmentId, rating, comment } = req.body || {};
  const result = await mutateData((data) => {
    const appointment = data.appointments.find((item) => item.id === appointmentId);
    if (!appointment) return { notFound: true };
    const client = findClientForUser(req.authUser, data);
    if (req.authUser.role !== 'client' || !client || appointment.clientId !== client.id) return { forbidden: true };
    return createAppointmentReview(data, appointment, rating, comment, {
      auditUser: req.authUser,
      req
    });
  });

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode avaliar este atendimento.');
  if (result.notFinished) return sendError(res, 409, 'Somente atendimentos finalizados podem ser avaliados.');
  if (result.invalidRating) return sendError(res, 400, 'Avaliação inválida.');
  if (result.duplicate) return sendError(res, 409, 'Este atendimento já foi avaliado.');
  res.status(201).json(result);
}));

app.get('/api/services', authenticate, (req, res) => {
  res.json({ services: readData().services });
});

app.post('/api/services', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    if (!cleanText(req.body.name, 120)) return { invalid: 'Nome do serviço é obrigatório.' };
    if (!isPositiveNumber(req.body.price)) return { invalid: 'Preço inválido.' };
    if (!Number.isInteger(Number(req.body.durationMinutes)) || Number(req.body.durationMinutes) <= 0) {
      return { invalid: 'Duração inválida.' };
    }
    const barberIds = Array.isArray(req.body.barberIds)
      ? req.body.barberIds.filter((barberId) => data.barbers.some((barber) => barber.id === barberId))
      : [];
    const service = {
      id: id('srv'),
      name: cleanText(req.body.name, 120),
      description: cleanText(req.body.description, 800),
      price: Number(req.body.price || 0),
      durationMinutes: Number(req.body.durationMinutes || 30),
      icon: cleanText(req.body.icon, 80) || 'Scissors',
      color: cleanText(req.body.color, 20) || '#d5a84f',
      barberIds,
      active: req.body.active !== false
    };
    data.services.push(service);
    audit(data, req.authUser, 'service_created', 'service', service.id, service.name, req);
    return { service };
  });
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/services/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const service = data.services.find((item) => item.id === req.params.id);
    if (!service) return { notFound: true };
    if (req.body.name !== undefined) service.name = cleanText(req.body.name, 120);
    if (req.body.description !== undefined) service.description = cleanText(req.body.description, 800);
    if (req.body.price !== undefined) {
      if (!isPositiveNumber(req.body.price)) return { invalid: 'Preço inválido.' };
      service.price = Number(req.body.price);
    }
    if (req.body.durationMinutes !== undefined) {
      if (!Number.isInteger(Number(req.body.durationMinutes)) || Number(req.body.durationMinutes) <= 0) {
        return { invalid: 'Duração inválida.' };
      }
      service.durationMinutes = Number(req.body.durationMinutes);
    }
    if (req.body.icon !== undefined) service.icon = cleanText(req.body.icon, 80);
    if (req.body.color !== undefined) service.color = cleanText(req.body.color, 20);
    if (req.body.barberIds !== undefined) {
      service.barberIds = Array.isArray(req.body.barberIds)
        ? req.body.barberIds.filter((barberId) => data.barbers.some((barber) => barber.id === barberId))
        : service.barberIds;
    }
    if (req.body.active !== undefined) service.active = Boolean(req.body.active);
    audit(data, req.authUser, 'service_updated', 'service', service.id, service.name, req);
    return { service };
  });
  if (result.notFound) return sendError(res, 404, 'Serviço não encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.get('/api/customers', authenticate, requireRoles('admin', 'owner', 'attendant'), (req, res) => {
  const data = readData();
  const term = String(req.query.search || '').toLowerCase();
  const customers = data.clients.filter((client) =>
    [client.name, client.email, client.phone, ...(client.tags || [])].join(' ').toLowerCase().includes(term)
  );
  res.json({ customers });
});

app.patch('/api/customers/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const client = data.clients.find((item) => item.id === req.params.id);
    if (!client) return { notFound: true };
    if (req.body.name !== undefined) client.name = cleanText(req.body.name, 140);
    if (req.body.phone !== undefined) client.phone = cleanText(req.body.phone, 32);
    if (req.body.email !== undefined) {
      if (req.body.email && !isValidEmail(req.body.email)) return { invalid: 'E-mail inválido.' };
      client.email = cleanText(req.body.email, 180);
    }
    if (req.body.birthDate !== undefined) {
      if (req.body.birthDate && !isValidDate(req.body.birthDate)) return { invalid: 'Data de aniversário inválida.' };
      client.birthDate = req.body.birthDate || null;
    }
    if (req.body.preferredBarberId !== undefined) {
      client.preferredBarberId = data.barbers.some((barber) => barber.id === req.body.preferredBarberId)
        ? req.body.preferredBarberId
        : null;
    }
    if (req.body.notes !== undefined) client.notes = cleanText(req.body.notes, 1000);
    if (Array.isArray(req.body.tags)) client.tags = req.body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 12);
    audit(data, req.authUser, 'customer_updated', 'client', client.id, client.name, req);
    return { client };
  });
  if (result.notFound) return sendError(res, 404, 'Cliente não encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.post('/api/barbers/:id/blocks', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const barber = data.barbers.find((item) => item.id === req.params.id);
    if (!barber) return { notFound: true };
    if (req.authUser.role === 'barber' && req.authUser.barberId !== barber.id) return { forbidden: true };
    if (!isValidDate(req.body.date) || !isValidTime(req.body.startTime) || !isValidTime(req.body.endTime)) return { invalid: true };
    if (toMinutes(req.body.startTime) >= toMinutes(req.body.endTime)) return { invalid: true };
    const existingBlock = (barber.blocks || []).find(
      (block) => block.date === req.body.date && overlaps(req.body.startTime, req.body.endTime, block.startTime, block.endTime)
    );
    if (existingBlock) return { conflict: true };

    const block = {
      id: id('block'),
      date: req.body.date,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      reason: req.body.reason || 'Indisponível'
    };
    block.reason = cleanText(block.reason, 220) || 'Indisponivel';
    barber.blocks = barber.blocks || [];
    barber.blocks.push(block);
    audit(data, req.authUser, 'barber_block_created', 'barber', barber.id, block.reason, req);
    return { block, barber };
  });
  if (result.notFound) return sendError(res, 404, 'Barbeiro não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode bloquear a agenda deste barbeiro.');
  if (result.invalid) return sendError(res, 400, 'Informe data e horarios validos para o bloqueio.');
  if (result.conflict) return sendError(res, 409, 'Ja existe bloqueio para este intervalo.');
  res.status(201).json(result);
}));

app.get('/api/products', authenticate, requireRoles(...INVENTORY_ROLES), (req, res) => {
  res.json({ products: readData().products });
});

app.post('/api/products', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    if (!cleanText(req.body.name, 140)) return { invalid: 'Nome do produto é obrigatório.' };
    if (!Number.isInteger(Number(req.body.quantity)) || Number(req.body.quantity) < 0) return { invalid: 'Quantidade inválida.' };
    if (!Number.isFinite(Number(req.body.purchasePrice)) || Number(req.body.purchasePrice) < 0) return { invalid: 'Valor de compra inválido.' };
    if (!Number.isFinite(Number(req.body.salePrice)) || Number(req.body.salePrice) < 0) return { invalid: 'Valor de venda inválido.' };
    if (!Number.isInteger(Number(req.body.minStock)) || Number(req.body.minStock) < 0) return { invalid: 'Estoque mínimo inválido.' };
    const product = {
      id: id('prd'),
      name: cleanText(req.body.name, 140),
      category: cleanText(req.body.category, 100) || 'Geral',
      quantity: Number(req.body.quantity || 0),
      purchasePrice: Number(req.body.purchasePrice || 0),
      salePrice: Number(req.body.salePrice || 0),
      minStock: Number(req.body.minStock || 1),
      sku: cleanText(req.body.sku, 80) || id('sku'),
      active: req.body.active !== false
    };
    data.products.push(product);
    audit(data, req.authUser, 'product_created', 'product', product.id, product.name, req);
    return { product };
  });
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.post('/api/products/:id/movements', authenticate, requireRoles(...INVENTORY_ROLES), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const product = data.products.find((item) => item.id === req.params.id);
    if (!product) return { notFound: true };
    const quantity = Number(req.body.quantity || 0);
    const type = req.body.type || 'adjustment';
    if (!['purchase', 'sale', 'usage', 'loss', 'adjustment'].includes(type)) return { invalid: true };
    if (!Number.isInteger(quantity) || quantity <= 0) return { invalid: true };
    const unitValue = req.body.unitValue === undefined
      ? (type === 'sale' ? product.salePrice : product.purchasePrice)
      : Number(req.body.unitValue);
    if (!Number.isFinite(unitValue) || unitValue < 0) return { invalid: true };
    if (['sale', 'usage', 'loss'].includes(type) && product.quantity < quantity) return { insufficientStock: true };

    if (type === 'purchase') product.quantity += quantity;
    if (['sale', 'usage', 'loss'].includes(type)) product.quantity -= quantity;
    if (type === 'adjustment') product.quantity = quantity;

    const movement = {
      id: id('mov'),
      productId: product.id,
      type,
      quantity,
      unitValue,
      reason: cleanText(req.body.reason, 300) || 'Movimentação manual',
      createdAt: isoNow(),
      userId: req.authUser.id
    };
    data.stockMovements.unshift(movement);
    if (product.quantity <= product.minStock) {
      data.notifications.unshift({
        id: id('ntf'),
        userId: 'usr_owner',
        channel: 'system',
        title: 'Estoque baixo',
        message: `${product.name} atingiu ${product.quantity} unidade(s).`,
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null
      });
    }
    audit(data, req.authUser, 'stock_movement_created', 'product', product.id, movement.reason, req);
    return { product, movement };
  });

  if (result.notFound) return sendError(res, 404, 'Produto não encontrado.');
  if (result.invalid) return sendError(res, 400, 'Tipo de movimentação inválido.');
  if (result.insufficientStock) return sendError(res, 409, 'Estoque insuficiente para esta movimentacao.');
  res.status(201).json(result);
}));

app.get('/api/promotions', authenticate, (req, res) => {
  res.json({ promotions: readData().promotions });
});

app.post('/api/promotions', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const title = cleanText(req.body.title, 140);
    const code = cleanText(req.body.code || id('cupom'), 50).toUpperCase();
    const discountType = ['percent', 'fixed'].includes(req.body.discountType) ? req.body.discountType : null;
    const discountValue = Number(req.body.discountValue || 0);
    const startsAt = req.body.startsAt || dateKey();
    const endsAt = req.body.endsAt || dateKey();
    if (!title || !code || !discountType || !Number.isFinite(discountValue) || discountValue <= 0) return { invalid: true };
    if (!isValidDate(startsAt) || !isValidDate(endsAt) || startsAt > endsAt) return { invalid: true };
    if (discountType === 'percent' && discountValue > 100) return { invalid: true };
    if (data.promotions.some((item) => String(item.code || '').toUpperCase() === code)) return { duplicate: true };
    const promotion = {
      id: id('promo'),
      title,
      description: cleanText(req.body.description, 800),
      code,
      discountType,
      discountValue,
      startsAt,
      endsAt,
      audience: cleanText(req.body.audience, 80) || 'all',
      active: req.body.active !== false
    };
    data.promotions.unshift(promotion);
    audit(data, req.authUser, 'promotion_created', 'promotion', promotion.id, promotion.title, req);
    return { promotion };
  });
  if (result.invalid) return sendError(res, 400, 'Dados da promocao invalidos.');
  if (result.duplicate) return sendError(res, 409, 'Ja existe promocao com este cupom.');
  res.status(201).json(result);
}));

app.get('/api/reports/summary', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), (req, res) => {
  const data = readData();
  res.json({ reports: scopedReportsForUser(req.authUser, data) });
});

app.get('/api/reports/export', authenticate, requireRoles('admin', 'owner', 'attendant'), (req, res) => {
  const data = readData();
  const reports = calculateReports(data);
  const format = req.query.format || 'excel';

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="barberpro-relatorio.pdf"');
    const doc = new PDFDocument({ margin: 48 });
    doc.pipe(res);
    doc.fontSize(20).text('BarberPro - Relatório executivo');
    doc.moveDown();
    Object.entries(reports.kpis).forEach(([key, value]) => {
      doc.fontSize(11).text(`${key}: ${value}`);
    });
    doc.moveDown();
    doc.fontSize(14).text('Desempenho por barbeiro');
    reports.barberPerformance.forEach((barber) => {
      doc.fontSize(10).text(`${barber.name} - ${barber.appointments} atendimentos - R$ ${barber.revenue}`);
    });
    doc.end();
    return;
  }

  const rows = [
    ['Indicador', 'Valor'],
    ...Object.entries(reports.kpis).map(([key, value]) => [key, value])
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="barberpro-relatorio.csv"');
  res.send(`\uFEFF${csv}`);
});

app.get('/api/backup', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    audit(data, req.authUser, 'backup_downloaded', 'system', 'backup', 'Backup exportado.', req);
    return { data };
  });
  res.setHeader('Content-Disposition', `attachment; filename="barberpro-backup-${dateKey()}.json"`);
  res.json(result.data);
}));

app.post('/api/demo/reset', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  if (IS_PRODUCTION) {
    return sendError(res, 403, 'Reset da demonstracao nao esta disponivel em producao.');
  }

  if (req.body?.confirm !== DEMO_RESET_CONFIRMATION) {
    return sendError(res, 400, `Confirme com "${DEMO_RESET_CONFIRMATION}" para restaurar a demonstracao.`);
  }

  const result = await resetDemoData({
    userId: req.authUser.id,
    ip: req.ip || 'local'
  });

  res.json({
    ok: true,
    demo: result.demo,
    persistence: getStoreInfo()
  });
}));

app.patch('/api/settings', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateData((data) => {
    const rules = req.body.appointmentRules || {};
    const appointmentRules = {};
    if (rules.slotIntervalMinutes !== undefined) {
      const value = Number(rules.slotIntervalMinutes);
      if (!Number.isInteger(value) || value < 5 || value > 240) return { invalid: true };
      appointmentRules.slotIntervalMinutes = value;
    }
    if (rules.reminderMinutesBefore !== undefined) {
      const value = Number(rules.reminderMinutesBefore);
      if (!Number.isInteger(value) || value < 0 || value > 10080) return { invalid: true };
      appointmentRules.reminderMinutesBefore = value;
    }
    if (rules.cancellationLimitHours !== undefined) {
      const value = Number(rules.cancellationLimitHours);
      if (!Number.isInteger(value) || value < 0 || value > 168) return { invalid: true };
      appointmentRules.cancellationLimitHours = value;
    }
    if (rules.allowClientReschedule !== undefined) appointmentRules.allowClientReschedule = Boolean(rules.allowClientReschedule);
    if (rules.requirePaymentConfirmation !== undefined) appointmentRules.requirePaymentConfirmation = Boolean(rules.requirePaymentConfirmation);

    const businessHours = {};
    for (const [day, config] of Object.entries(req.body.businessHours || {})) {
      if (!/^[0-6]$/.test(day) || !config) return { invalid: true };
      if (!isValidTime(config.open) || !isValidTime(config.close) || toMinutes(config.open) >= toMinutes(config.close)) return { invalid: true };
      businessHours[day] = {
        label: cleanText(config.label, 40) || data.settings.businessHours[day]?.label || day,
        open: config.open,
        close: config.close,
        closed: Boolean(config.closed)
      };
    }

    req.body = {
      ...(req.body.barbershopName !== undefined ? { barbershopName: cleanText(req.body.barbershopName, 140) } : {}),
      ...(req.body.timezone !== undefined ? { timezone: cleanText(req.body.timezone, 80) } : {}),
      ...(req.body.currency !== undefined ? { currency: cleanText(req.body.currency, 8) } : {}),
      ...(req.body.whatsappNumber !== undefined ? { whatsappNumber: cleanText(req.body.whatsappNumber, 32) } : {}),
      appointmentRules,
      businessHours
    };
    data.settings = {
      ...data.settings,
      ...(req.body.barbershopName !== undefined ? { barbershopName: req.body.barbershopName } : {}),
      ...(req.body.timezone !== undefined ? { timezone: req.body.timezone } : {}),
      ...(req.body.currency !== undefined ? { currency: req.body.currency } : {}),
      ...(req.body.whatsappNumber !== undefined ? { whatsappNumber: req.body.whatsappNumber } : {}),
      appointmentRules: {
        ...data.settings.appointmentRules,
        ...(req.body.appointmentRules || {})
      },
      security: {
        ...data.settings.security
      },
      businessHours: {
        ...data.settings.businessHours,
        ...(req.body.businessHours || {})
      }
    };
    audit(data, req.authUser, 'settings_updated', 'settings', 'global', 'Configurações alteradas.', req);
    return { settings: data.settings };
  });
  if (result.invalid) return sendError(res, 400, 'Configuracoes invalidas.');
  res.json(result);
}));

app.use((error, req, res, next) => {
  if (error instanceof PersistenceUnavailableError || error.code === 'PERSISTENCE_UNAVAILABLE') {
    return sendPersistenceError(res, error);
  }
  console.error(`Falha na rota ${req.method} ${req.originalUrl}: ${error.stack || error.message}`);
  return sendError(res, 500, 'Falha interna no servidor.');
});

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return sendError(res, 404, 'Rota não encontrada.');
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  if (require('fs').existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(200).send('BarberPro API ativa. Rode "npm run dev" para abrir a interface React.');
});

async function startServer() {
  const storeInfo = await initializeStore();
  app.locals.storeInfo = storeInfo;
  if (storeInfo.writable && !storeInfo.readOnly) {
    const reconciliation = await runOperationalReconciliation({
      user: { id: 'system', role: 'admin', name: 'Sistema' }
    });
    if (reconciliation.updated) {
      console.log(`Reconciliacao operacional: ${reconciliation.summary.totalUpdated} item(ns) vencido(s) atualizados.`);
    }
  }
  app.listen(PORT, () => {
    const target = storeInfo.mode === 'mysql'
      ? `MySQL ${storeInfo.database} em ${storeInfo.host}:${storeInfo.port}`
      : `JSON local em ${storeInfo.file}`;
    console.log(`BarberPro API rodando em http://localhost:${PORT}`);
    console.log(`Persistencia ativa: ${target} (${storeInfo.status}, writable=${storeInfo.writable})`);
    if (!storeInfo.writable) console.warn(storeInfo.message);
  });
}

startServer().catch((error) => {
  console.error(`Falha ao iniciar BarberPro: ${error.message}`);
  process.exit(1);
});
