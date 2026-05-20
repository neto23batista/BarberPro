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
const { logger, requestLogger } = require('./services/logger');
const { registerProcessAlertHandlers } = require('./services/alerts');
const { createReportCache } = require('./services/reportCache');
const { sanitizeBackupData } = require('./services/sanitizers');
const { buildHealthStatus } = require('./services/health');
const { startAutomaticBackups } = require('./services/automaticBackup');
const { sendPasswordResetEmail } = require('./services/email');
const { validateProductionRuntime, validateStrongPassword, isPlaceholder } = require('./services/runtimeConfig');
const {
  persistAppointmentMutation,
  persistStockMovementMutation,
  persistServiceMutation,
  persistProductMutation,
  persistCustomerMutation,
  persistBarberMutation,
  persistExpenseMutation,
  persistPromotionMutation,
  persistCouponMutation,
  persistWaitlistMutation,
  persistReviewMutation,
  persistAuthMutation,
  persistUserMutation,
  persistTenantMutation,
  persistSettingsMutation,
  persistAuditOnlyMutation,
  persistReconciliationMutation
} = require('./adapters/mysqlOperationalWrites');
const {
  DEFAULT_TENANT_ID,
  DEMO_RESET_CONFIRMATION,
  getStoreInfo,
  id,
  initializeStore,
  isoNow,
  PersistenceUnavailableError,
  readOperationalData,
  refreshStoreHealth,
  resetDemoData,
  mutateDataWithMysqlOperation,
  sanitizeUser
} = require('./store');

const app = express();
const PORT = Number(process.env.PORT || 3333);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET ? String(process.env.JWT_SECRET) : null;
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'barberpro_session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const BLOCKING_STATUSES = ['scheduled', 'confirmed', 'in_service'];
const TERMINAL_STATUSES = ['finished', 'cancelled', 'no_show'];
const ADMIN_ROLES = ['admin', 'owner', 'attendant'];
const OWNER_ROLES = ['admin', 'owner'];
const INVENTORY_ROLES = ['admin', 'owner', 'attendant'];
const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show'];
const RECONCILIATION_RULE_VERSION = 'expired-items-v1';
const APPOINTMENT_NO_SHOW_GRACE_MINUTES = 30;
const APPOINTMENT_FINISH_GRACE_MINUTES = 90;
const REMINDER_EXPIRATION_GRACE_MINUTES = 30;
const WAITLIST_MAX_AGE_DAYS = 14;
const MAX_SERVICE_PRICE = 10000;
const MAX_PRODUCT_PRICE = 100000;
const MAX_STOCK_QUANTITY = 100000;
const MAX_APPOINTMENT_DAYS_AHEAD = Number(process.env.MAX_APPOINTMENT_DAYS_AHEAD || 365);
const reportCache = createReportCache({ ttlMs: Number(process.env.REPORT_CACHE_TTL_MS || 60_000) });
const loginFailures = new Map();
const LOGIN_LOCK_WINDOW_MS = Number(process.env.LOGIN_LOCK_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_LOCK_MAX_FAILURES = Number(process.env.LOGIN_LOCK_MAX_FAILURES || 8);
const PASSWORD_RESET_TOKEN_BYTES = 32;
const PASSWORD_RESET_EXPIRES_MS = Number(process.env.PASSWORD_RESET_EXPIRES_MS || 60 * 60 * 1000);
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/me'
]);

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

validateProductionRuntime();

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET é obrigatório em produção.');
}

if (IS_PRODUCTION && isPlaceholder(JWT_SECRET)) {
  throw new Error('JWT_SECRET de producao nao pode usar valor padrao ou placeholder.');
}

if (IS_PRODUCTION) {
  if (JWT_SECRET.length < 48) {
    throw new Error('JWT_SECRET de producao deve ter pelo menos 48 caracteres.');
  }
  if (!process.env.CORS_ORIGIN) {
    throw new Error('CORS_ORIGIN e obrigatorio em producao.');
  }
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
        styleSrc: IS_PRODUCTION ? ["'self'"] : ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...allowedOrigins],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    hsts: IS_PRODUCTION
      ? {
          maxAge: 63072000,
          includeSubDomains: true,
          preload: true
        }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true
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
app.use(requestLogger);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas consultas pesadas. Aguarde alguns instantes e tente novamente.' }
});

app.use('/api/auth', authLimiter);

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

function isMoneyInRange(value, min = 0.01, max = MAX_SERVICE_PRICE) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function isInventoryQuantity(value, options = {}) {
  const number = Number(value);
  const min = options.allowZero ? 0 : 1;
  return Number.isInteger(number) && number >= min && number <= MAX_STOCK_QUANTITY;
}

function textLengthOk(value, maxLength) {
  return String(value || '').length <= maxLength;
}

function futureDateKey(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return dateKey(date);
}

function isValidAppointmentDate(value, options = {}) {
  if (!isValidDate(value)) return false;
  if (!options.allowPast && value < dateKey()) return false;
  return value <= futureDateKey(MAX_APPOINTMENT_DAYS_AHEAD);
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

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
  const payload = { error: message };
  if (details !== undefined) {
    payload.details = details;
    if (details && typeof details === 'object' && details.code) payload.code = details.code;
  }
  return res.status(status).json(payload);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function unsafeMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function bearerAuthRequest(req) {
  return String(req.headers.authorization || '').startsWith('Bearer ');
}

function csrfProtection(req, res, next) {
  if (!req.path.startsWith('/api') || !unsafeMethod(req.method) || bearerAuthRequest(req)) return next();

  const origin = req.get('origin');
  if (!origin) {
    if (!IS_PRODUCTION) return next();
    return sendError(res, 403, 'Origem da requisicao obrigatoria para esta acao.');
  }

  if (!allowedOrigins.includes(origin)) {
    return sendError(res, 403, 'Origem da requisicao nao permitida.');
  }

  return next();
}

app.use(csrfProtection);

function sendPersistenceError(res, error) {
  const persistence = getStoreInfo();
  return res.status(error.statusCode || 503).json({
    error: error.message,
    code: error.code || 'PERSISTENCE_UNAVAILABLE',
    persistence
  });
}

function loginFailureKey(email, req) {
  return `${String(email || '').trim().toLowerCase()}|${req.ip || 'unknown'}`;
}

function loginFailureState(email, req) {
  const key = loginFailureKey(email, req);
  const now = Date.now();
  const state = loginFailures.get(key);
  if (!state || state.expiresAt <= now) {
    const fresh = { count: 0, expiresAt: now + LOGIN_LOCK_WINDOW_MS };
    loginFailures.set(key, fresh);
    return fresh;
  }
  return state;
}

function isLoginLocked(email, req) {
  const state = loginFailureState(email, req);
  return state.count >= LOGIN_LOCK_MAX_FAILURES;
}

function recordLoginFailure(email, req) {
  const state = loginFailureState(email, req);
  state.count += 1;
  state.expiresAt = Date.now() + LOGIN_LOCK_WINDOW_MS;
}

function clearLoginFailures(email, req) {
  loginFailures.delete(loginFailureKey(email, req));
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
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    path: '/'
  });
}

function tenantIdOf(entity) {
  return entity?.tenantId || DEFAULT_TENANT_ID;
}

function cleanSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function tenantFromRequest(req, data) {
  const requested = req.get('x-tenant-id') || req.query.tenantId || req.query.tenant || req.query.slug || DEFAULT_TENANT_ID;
  const tenant = (data.tenants || []).find(
    (item) => item.status !== 'blocked' && (item.id === requested || item.slug === requested)
  );
  return tenant?.id || DEFAULT_TENANT_ID;
}

function sameTenant(user, entity) {
  return tenantIdOf(user) === tenantIdOf(entity);
}

function tenantScopedItems(data, collection, tenantId) {
  return (data[collection] || []).filter((item) => tenantIdOf(item) === tenantId);
}

function scopedDataForUser(data, user) {
  const tenantId = tenantIdOf(user);
  return {
    ...data,
    users: tenantScopedItems(data, 'users', tenantId),
    units: tenantScopedItems(data, 'units', tenantId),
    clients: tenantScopedItems(data, 'clients', tenantId),
    barbers: tenantScopedItems(data, 'barbers', tenantId),
    services: tenantScopedItems(data, 'services', tenantId),
    appointments: tenantScopedItems(data, 'appointments', tenantId),
    payments: [],
    commissions: tenantScopedItems(data, 'commissions', tenantId),
    reviews: tenantScopedItems(data, 'reviews', tenantId),
    products: tenantScopedItems(data, 'products', tenantId),
    stockMovements: tenantScopedItems(data, 'stockMovements', tenantId),
    expenses: tenantScopedItems(data, 'expenses', tenantId),
    promotions: tenantScopedItems(data, 'promotions', tenantId),
    coupons: tenantScopedItems(data, 'coupons', tenantId),
    waitlist: tenantScopedItems(data, 'waitlist', tenantId),
    notifications: tenantScopedItems(data, 'notifications', tenantId),
    auditLogs: tenantScopedItems(data, 'auditLogs', tenantId),
    settings: data.settings?.tenantId && data.settings.tenantId !== tenantId
      ? { ...data.settings, tenantId }
      : data.settings
  };
}

function audit(data, user, action, entity, entityId, details, req) {
  data.auditLogs.unshift({
    id: id('log'),
    tenantId: tenantIdOf(user),
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
      tenantId: tenantIdOf(user),
      role: user.role,
      clientId: user.clientId || null,
      barberId: user.barberId || null
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createPasswordResetToken() {
  const token = crypto.randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRES_MS).toISOString()
  };
}

function publicAppBaseUrl(req) {
  return String(
    process.env.VITE_PUBLIC_APP_URL ||
    req.get('origin') ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
}

function passwordResetUrl(req, token) {
  const url = new URL('/recuperar-senha', `${publicAppBaseUrl(req)}/`);
  url.searchParams.set('token', token);
  return url.toString();
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

async function authenticate(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return sendError(res, 401, 'Sessão obrigatória.');

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const data = await readOperationalData();
    const user = data.users.find(
      (item) =>
        item.id === payload.sub &&
        item.status === 'active' &&
        tenantIdOf(item) === (payload.tenantId || tenantIdOf(item))
    );
    if (!user) return sendError(res, 401, 'Usuário não encontrado ou inativo.');
    req.authUser = sanitizeUser(user);
    if (user.mustChangePassword && !canUseWithPendingPasswordChange(req)) {
      return sendError(res, 403, 'Troque sua senha provisoria antes de continuar.', {
        code: 'PASSWORD_CHANGE_REQUIRED'
      });
    }
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
  return data.clients.find((client) => sameTenant(user, client) && (client.id === user.clientId || client.userId === user.id)) || null;
}

function findBarberForUser(user, data) {
  if (!user) return null;
  return data.barbers.find((barber) => sameTenant(user, barber) && (barber.id === user.barberId || barber.userId === user.id)) || null;
}

function canUseWithPendingPasswordChange(req) {
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path);
}

function visiblePromotionsForUser(data, user) {
  return data.promotions.filter((promotion) => ADMIN_ROLES.includes(user.role) || promotion.active);
}

function visibleCouponsForUser(data, user) {
  if (ADMIN_ROLES.includes(user.role)) return data.coupons;
  if (user.role !== 'client') return [];
  const client = findClientForUser(user, data);
  return data.coupons.filter((coupon) => coupon.clientId === client?.id);
}

function visibleWaitlistForUser(data, user) {
  if (ADMIN_ROLES.includes(user.role)) return data.waitlist;
  if (user.role === 'client') {
    const client = findClientForUser(user, data);
    return data.waitlist.filter((item) => item.clientId === client?.id);
  }
  if (user.role === 'barber') {
    const barber = findBarberForUser(user, data);
    return data.waitlist.filter((item) => item.barberId === barber?.id);
  }
  return [];
}

function canSeeAppointment(user, appointment, data) {
  if (!sameTenant(user, appointment)) return false;
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

function appointmentView(appointment, data, user = null) {
  const client = data.clients.find((item) => item.id === appointment.clientId);
  const barber = data.barbers.find((item) => item.id === appointment.barberId);
  const service = data.services.find((item) => item.id === appointment.serviceId);
  const unit = data.units.find((item) => item.id === appointment.unitId);
  const review = data.reviews.find((item) => item.appointmentId === appointment.id);
  const clientCanReview = user?.role === 'client' && client && user.clientId === client.id;
  const staffCanGenerateReviewLink = user && ADMIN_ROLES.includes(user.role);
  const view = {
    ...appointment,
    client: clientView(client, user),
    barber: barberScopedView(barber, user),
    service,
    unit,
    review,
    reviewToken: appointment.status === 'finished' && !review && (clientCanReview || staffCanGenerateReviewLink)
      ? signReviewToken(appointment)
      : null,
    value: service?.price || 0
  };
  delete view.paymentStatus;
  delete view.paymentMethod;
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
    tenantId: tenantIdOf(appointment),
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
    options.auditUser || { id: 'public', tenantId: tenantIdOf(appointment) },
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
      description: `Agendamentos in_service vencidos ha mais de ${APPOINTMENT_FINISH_GRACE_MINUTES} minutos viram finished automaticamente.`
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
  appointment.updatedAt = nowIso;
  appendReconciliationMarker(
    appointment,
    nowIso,
    previousStatus,
    'Atendimento estava em andamento depois do horario final e foi finalizado operacionalmente.'
  );

  const existingCommission = data.commissions.find((item) => item.appointmentId === appointment.id);
  if (!existingCommission && barber && service) {
    data.commissions.push({
      id: id('com'),
      tenantId: tenantIdOf(appointment),
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
  appointment.updatedAt = nowIso;
  appendReconciliationMarker(
    appointment,
    nowIso,
    previousStatus,
    'Agendamento passou do horario final sem inicio/finalizacao e foi marcado como falta.'
  );

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
    if (options.user && !sameTenant(options.user, appointment)) continue;
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
    if (options.user && !sameTenant(options.user, notification)) continue;
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
    if (options.user && !sameTenant(options.user, item)) continue;
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
    const previousState = data.operationalReconciliation || {};
    const previousEvents = Array.isArray(data.operationalReconciliation?.events)
      ? data.operationalReconciliation.events
      : [];
    data.operationalReconciliation = {
      ruleVersion: RECONCILIATION_RULE_VERSION,
      lastRunAt: summary.totalUpdated > 0 ? nowIso : previousState.lastRunAt || nowIso,
      lastRunBy: summary.totalUpdated > 0 ? options.user?.id || 'system' : previousState.lastRunBy || options.user?.id || 'system',
      lastCheckedAt: nowIso,
      lastCheckedBy: options.user?.id || 'system',
      summary: summary.totalUpdated > 0 ? summary : previousState.summary || summary,
      lastCheckSummary: summary,
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
    lastCheckedAt: state?.lastCheckedAt || state?.lastRunAt || null,
    lastCheckedBy: state?.lastCheckedBy || state?.lastRunBy || null,
    summary,
    lastCheckSummary: state?.lastCheckSummary || null,
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
      operationalReconciliation: operationalReconciliationView((await readOperationalData()).operationalReconciliation, options.user)
    };
  }

  return mutateDataWithMysqlOperation((data) => reconcileOperationalData(data, options), persistReconciliationMutation);
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
  if (!isValidAppointmentDate(draft.date, { allowPast: options.allowPast })) {
    return { ok: false, message: `Data invalida. Agendamentos devem ficar entre hoje e ${MAX_APPOINTMENT_DAYS_AHEAD} dias a frente.` };
  }
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
    .filter((barber) => service.barberIds.includes(barber.id))
    .filter((barber) => (barberId ? barber.id === barberId : true));

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
  const finishedAppointments = data.appointments.filter((appointment) => appointment.status === 'finished');
  const activeAppointments = data.appointments.filter((appointment) => appointment.status !== 'cancelled');
  const serviceRevenueFor = (appointment) => {
    const service = data.services.find((item) => item.id === appointment.serviceId);
    return Number(service?.price || appointment.value || 0);
  };
  const revenueToday = finishedAppointments
    .filter((appointment) => appointment.date === today)
    .reduce((sum, appointment) => sum + serviceRevenueFor(appointment), 0);
  const revenueMonth = finishedAppointments
    .filter((appointment) => String(appointment.date || '').slice(0, 7) === currentMonth)
    .reduce((sum, appointment) => sum + serviceRevenueFor(appointment), 0);
  const totalRevenue = finishedAppointments.reduce((sum, appointment) => sum + serviceRevenueFor(appointment), 0);
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
        finishedAppointments
          .filter((appointment) => String(appointment.date || '').slice(0, 7) === month)
          .reduce((sum, appointment) => sum + serviceRevenueFor(appointment), 0)
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
      averageTicket: finishedAppointments.length ? money(totalRevenue / finishedAppointments.length) : 0,
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
  if (ADMIN_ROLES.includes(user.role)) {
    return reportCache.getOrSet(`reports:tenant:${tenantIdOf(user)}:admin`, () => calculateReports(data));
  }

  const appointments = data.appointments.filter((appointment) => canSeeAppointment(user, appointment, data));
  const appointmentIds = new Set(appointments.map((appointment) => appointment.id));
  const clientIds = new Set(appointments.map((appointment) => appointment.clientId));
  const barberIds = new Set(appointments.map((appointment) => appointment.barberId));

  return calculateReports({
    ...data,
    appointments,
    payments: [],
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
    barbers: ADMIN_ROLES.includes(user.role)
      ? data.barbers
      : data.barbers.map((barber) => barberScopedView(barber, user)),
    services: data.services,
    products: INVENTORY_ROLES.includes(user.role) ? data.products : [],
    stockMovements: INVENTORY_ROLES.includes(user.role) ? data.stockMovements : [],
    payments: [],
    expenses: ADMIN_ROLES.includes(user.role) ? data.expenses : [],
    commissions: ADMIN_ROLES.includes(user.role)
      ? data.commissions
      : data.commissions.filter((commission) => commission.barberId === user.barberId),
    reviews: ADMIN_ROLES.includes(user.role)
      ? data.reviews
      : data.reviews.filter(
          (review) => review.clientId === user.clientId || review.barberId === user.barberId
        ),
    promotions: visiblePromotionsForUser(data, user),
    coupons: visibleCouponsForUser(data, user),
    waitlist: visibleWaitlistForUser(data, user),
    units: data.units,
    settings: ADMIN_ROLES.includes(user.role) ? data.settings : publicSettingsView(data.settings),
    notifications: data.notifications.filter(
      (notification) => ADMIN_ROLES.includes(user.role) || notification.userId === user.id
    ),
    users: OWNER_ROLES.includes(user.role) ? data.users.map(sanitizeUser) : [],
    auditLogs: ADMIN_ROLES.includes(user.role) ? data.auditLogs.slice(0, 80) : [],
    operationalReconciliation: operationalReconciliationView(data.operationalReconciliation, user)
  };
}

app.get('/api/health', asyncRoute(async (req, res) => {
  const health = await buildHealthStatus({
    refreshStoreHealth,
    getStoreInfo,
    logger
  });
  res.status(health.ok ? 200 : 503).json(health);
}));

app.get('/api/public', asyncRoute(async (req, res) => {
  const rawData = await readOperationalData();
  const data = scopedDataForUser(rawData, { tenantId: tenantFromRequest(req, rawData) });
  res.json({
    persistence: getStoreInfo(),
    settings: publicSettingsView(data.settings),
    units: data.units.filter((unit) => unit.status === 'active'),
    services: data.services.filter((service) => service.active),
    barbers: data.barbers.filter((barber) => barber.status === 'active').map(publicBarberView),
    promotions: data.promotions.filter((promotion) => promotion.active)
  });
}));

app.get('/api/public/review-request', asyncRoute(async (req, res) => {
  const data = await readOperationalData();
  const result = verifyReviewToken(data, req.query.token);

  if (result.invalid || result.notFound) return sendError(res, 404, 'Link de avaliação inválido.');
  return res.json(publicReviewRequestView(result.appointment, data));
}));

app.post('/api/public/reviews', asyncRoute(async (req, res) => {
  const { token, rating, comment } = req.body || {};
  const result = await mutateDataWithMysqlOperation((data) => {
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
  }, persistReviewMutation);

  if (result.invalidToken) return sendError(res, 404, 'Link de avaliação inválido.');
  if (result.notFinished) return sendError(res, 409, 'Somente atendimentos finalizados podem ser avaliados.');
  if (result.invalidRating) return sendError(res, 400, 'Avaliação inválida.');
  if (result.duplicate) return sendError(res, 409, 'Este atendimento já foi avaliado.');
  return res.status(201).json(result);
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, email, phone, password, birthDate } = req.body || {};
  if (!name || !email || !phone || !password) {
    return sendError(res, 400, 'Informe nome, e-mail, telefone e senha.');
  }
  if (!isValidEmail(email)) return sendError(res, 400, 'Informe um e-mail válido.');
  if (birthDate && !isValidDate(birthDate)) return sendError(res, 400, 'Data de aniversário inválida.');
  const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
  if (!passwordPolicy.ok) return sendError(res, 400, passwordPolicy.errors.join(' '));

  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantFromRequest(req, data);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (data.users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
      return { duplicate: true };
    }

    const userId = id('usr');
    const clientId = id('client');
    const user = {
      id: userId,
      tenantId,
      role: 'client',
      name: String(name).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash: bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10),
      status: 'active',
      clientId,
      birthDate: birthDate || null,
      avatar: '',
      createdAt: isoNow()
    };
    const client = {
      id: clientId,
      tenantId,
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
  }, persistAuthMutation);

  if (result.duplicate) return sendError(res, 409, 'Já existe uma conta com este e-mail.');
  setSessionCookie(res, result.sessionToken);
  delete result.sessionToken;
  return res.status(201).json(result);
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return sendError(res, 400, 'Informe e-mail e senha.');
  if (isLoginLocked(email, req)) {
    return sendError(res, 429, 'Muitas tentativas para esta conta. Aguarde alguns minutos e tente novamente.');
  }

  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantSelector = req.get('x-tenant-id') || req.query.tenantId || req.query.tenant || req.query.slug;
    const requestedTenantId = tenantSelector ? tenantFromRequest(req, data) : null;
    const user = data.users.find(
      (item) =>
        item.email.toLowerCase() === String(email).trim().toLowerCase() &&
        item.status === 'active' &&
        (!requestedTenantId || tenantIdOf(item) === requestedTenantId)
    );
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) return { invalid: true };

    user.lastLoginAt = isoNow();
    audit(data, sanitizeUser(user), 'login', 'user', user.id, 'Login realizado.', req);
    return {
      user: sanitizeUser(user),
      sessionToken: signToken(user)
    };
  }, persistAuthMutation);

  if (result.invalid) {
    recordLoginFailure(email, req);
    return sendError(res, 401, 'E-mail ou senha inválidos.');
  }
  clearLoginFailures(email, req);
  setSessionCookie(res, result.sessionToken);
  delete result.sessionToken;
  res.json(result);
}));

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/recover', asyncRoute(async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const reset = createPasswordResetToken();
  const resetUrl = passwordResetUrl(req, reset.token);

  const result = await mutateDataWithMysqlOperation((data) => {
    const user = data.users.find((item) => item.email.toLowerCase() === normalizedEmail);
    if (user) {
      user.passwordResetTokenHash = reset.tokenHash;
      user.passwordResetExpiresAt = reset.expiresAt;
      data.notifications.unshift({
        id: id('ntf'),
        tenantId: tenantIdOf(user),
        userId: user.id,
        channel: 'email',
        title: 'Recuperação de senha',
        message: 'Link de recuperacao de senha enviado ao e-mail cadastrado.',
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null,
        metadata: {
          type: 'password_reset',
          expiresAt: reset.expiresAt
        }
      });
      audit(data, sanitizeUser(user), 'password_recovery_requested', 'user', user.id, 'Recuperação de senha solicitada.', req);
      return { userFound: true, userName: user.name };
    }
    return { userFound: false };
  }, persistAuthMutation);
  if (result.userFound) {
    try {
      const emailDelivery = await sendPasswordResetEmail({
        to: normalizedEmail,
        name: result.userName,
        resetUrl,
        expiresAt: reset.expiresAt,
        logger
      });
      if (emailDelivery.skipped) {
        logger.warn({ email: normalizedEmail }, 'password_reset_email_skipped');
      } else {
        logger.info({ email: normalizedEmail }, 'password_reset_email_sent');
      }
    } catch (error) {
      logger.error({ err: error, email: normalizedEmail }, 'password_reset_email_failed');
    }
  }

  if (result.userFound && !IS_PRODUCTION) {
    return res.json({
      ok: true,
      message: 'Se a conta existir, geraremos instrucoes de recuperacao.',
      devResetUrl: resetUrl,
      expiresAt: reset.expiresAt,
      email: normalizedEmail
    });
  }
  res.json({ ok: true, message: 'Se a conta existir, geraremos instrucoes de recuperacao.' });
}));

app.post('/api/auth/reset', asyncRoute(async (req, res) => {
  const { token: resetToken, password } = req.body || {};
  if (!resetToken || !password) return sendError(res, 400, 'Informe token e nova senha.');

  const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
  if (!passwordPolicy.ok) return sendError(res, 400, passwordPolicy.errors.join(' '));

  const tokenHash = hashResetToken(resetToken);
  const result = await mutateDataWithMysqlOperation((data) => {
    const now = Date.now();
    const user = data.users.find((item) =>
      item.status === 'active' &&
      item.passwordResetTokenHash === tokenHash &&
      item.passwordResetExpiresAt &&
      new Date(item.passwordResetExpiresAt).getTime() > now
    );
    if (!user) return { invalid: true };

    user.passwordHash = bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10);
    delete user.passwordResetToken;
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    delete user.passwordResetExpires;
    user.passwordChangedAt = isoNow();
    user.mustChangePassword = false;

    audit(data, sanitizeUser(user), 'password_reset_completed', 'user', user.id, 'Senha redefinida por token de recuperacao.', req);
    return { user: sanitizeUser(user) };
  }, persistAuthMutation);

  if (result.invalid) return sendError(res, 400, 'Token de recuperacao invalido ou expirado.');
  res.json({ ok: true, message: 'Senha redefinida com sucesso.' });
}));

app.post('/api/auth/change-password', authenticate, asyncRoute(async (req, res) => {
  const { currentPassword, password } = req.body || {};
  if (!currentPassword || !password) return sendError(res, 400, 'Informe a senha atual e a nova senha.');

  const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
  if (!passwordPolicy.ok) return sendError(res, 400, passwordPolicy.errors.join(' '));

  const result = await mutateDataWithMysqlOperation((data) => {
    const user = data.users.find((item) => item.id === req.authUser.id && sameTenant(req.authUser, item));
    if (!user || user.status !== 'active') return { notFound: true };
    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) return { invalidCurrentPassword: true };
    if (bcrypt.compareSync(password, user.passwordHash)) return { samePassword: true };

    user.passwordHash = bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10);
    user.mustChangePassword = false;
    delete user.passwordResetToken;
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    delete user.passwordResetExpires;
    user.passwordChangedAt = isoNow();
    audit(data, sanitizeUser(user), 'password_changed', 'user', user.id, 'Senha alterada pelo usuario autenticado.', req);
    return { user: sanitizeUser(user) };
  }, persistAuthMutation);

  if (result.notFound) return sendError(res, 404, 'Usuario nao encontrado.');
  if (result.invalidCurrentPassword) return sendError(res, 401, 'Senha atual invalida.');
  if (result.samePassword) return sendError(res, 400, 'A nova senha deve ser diferente da senha atual.');
  res.json({ ok: true, user: result.user });
}));

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.authUser });
});

app.get('/api/profile', authenticate, asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({
    user: req.authUser,
    client: clientView(findClientForUser(req.authUser, data), req.authUser),
    barber: barberScopedView(findBarberForUser(req.authUser, data), req.authUser)
  });
}));

app.patch('/api/profile', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const user = data.users.find((item) => item.id === req.authUser.id && sameTenant(req.authUser, item));
    if (!user || user.status !== 'active') return { notFound: true };

    const name = req.body.name !== undefined ? cleanText(req.body.name, 140) : undefined;
    const phone = req.body.phone !== undefined ? cleanText(req.body.phone, 32) : undefined;
    const birthDate = req.body.birthDate !== undefined ? req.body.birthDate || null : undefined;
    if (name !== undefined && !name) return { invalid: 'Nome e obrigatorio.' };
    if (phone !== undefined && !phone) return { invalid: 'Telefone e obrigatorio.' };
    if (birthDate && !isValidDate(birthDate)) return { invalid: 'Data de aniversario invalida.' };

    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (birthDate !== undefined) user.birthDate = birthDate;

    const client = findClientForUser(user, tenantData);
    if (client) {
      if (name !== undefined) client.name = name;
      if (phone !== undefined) client.phone = phone;
      if (birthDate !== undefined) client.birthDate = birthDate;
      if (req.body.preferredBarberId !== undefined) {
        const preferredBarberId = req.body.preferredBarberId || null;
        if (preferredBarberId && !tenantData.barbers.some((barber) => barber.id === preferredBarberId)) {
          return { invalid: 'Barbeiro preferido invalido.' };
        }
        client.preferredBarberId = preferredBarberId;
      }
    }

    const barber = findBarberForUser(user, tenantData);
    if (barber) {
      if (name !== undefined) barber.name = name;
      if (phone !== undefined) barber.phone = phone;
      if (req.body.bio !== undefined) barber.bio = cleanText(req.body.bio, 800);
    }

    const safeUser = sanitizeUser(user);
    audit(data, safeUser, 'profile_updated', 'user', user.id, 'Perfil atualizado pelo usuario autenticado.', req);
    return {
      user: safeUser,
      client: clientView(client, safeUser),
      barber: barberScopedView(barber, safeUser)
    };
  }, persistAuthMutation);

  if (result.notFound) return sendError(res, 404, 'Usuario nao encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.get('/api/users', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const users = scopedDataForUser(await readOperationalData(), req.authUser).users.map(sanitizeUser);
  res.json({ users });
}));

app.post('/api/users', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const role = ['admin', 'owner', 'barber', 'attendant', 'client'].includes(body.role) ? body.role : null;
  const name = cleanText(body.name, 140);
  const email = String(body.email || '').trim().toLowerCase();
  const phone = cleanText(body.phone, 32);
  const password = String(body.password || '');

  if (!role || !name || !email || !phone || !password) return sendError(res, 400, 'Informe perfil, nome, e-mail, telefone e senha.');
  if (!isValidEmail(email)) return sendError(res, 400, 'E-mail invalido.');
  if (req.authUser.role !== 'admin' && ['admin', 'owner'].includes(role)) {
    return sendError(res, 403, 'Somente administradores podem criar administradores ou donos.');
  }
  const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
  if (!passwordPolicy.ok) return sendError(res, 400, passwordPolicy.errors.join(' '));

  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const tenantData = scopedDataForUser(data, req.authUser);
    if (data.users.some((user) => String(user.email || '').toLowerCase() === email)) return { duplicate: true };

    const user = {
      id: id('usr'),
      tenantId,
      role,
      name,
      email,
      phone,
      passwordHash: bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10),
      mustChangePassword: body.mustChangePassword !== undefined ? Boolean(body.mustChangePassword) : true,
      status: body.status === 'inactive' ? 'inactive' : 'active',
      avatar: '',
      createdAt: isoNow()
    };

    if (role === 'barber') {
      let barber = body.barberId ? tenantData.barbers.find((item) => item.id === body.barberId) : null;
      if (!barber) {
        barber = {
          id: id('barber'),
          tenantId,
          userId: user.id,
          name,
          phone,
          email,
          bio: '',
          specialties: [],
          commissionRate: 0.4,
          rating: 5,
          goalMonthly: 0,
          unitIds: tenantData.units[0]?.id ? [tenantData.units[0].id] : [],
          status: 'active',
          blocks: []
        };
        data.barbers.push(barber);
      } else {
        barber.userId = user.id;
      }
      user.barberId = barber.id;
    }

    if (role === 'client') {
      let client = body.clientId ? tenantData.clients.find((item) => item.id === body.clientId) : null;
      if (!client) {
        client = {
          id: id('client'),
          tenantId,
          userId: user.id,
          name,
          phone,
          email,
          birthDate: body.birthDate || null,
          loyaltyPoints: 0,
          visits: 0,
          noShows: 0,
          preferredBarberId: null,
          notes: '',
          tags: ['novo cliente'],
          createdAt: isoNow()
        };
        data.clients.push(client);
      } else {
        client.userId = user.id;
      }
      user.clientId = client.id;
    }

    data.users.push(user);
    audit(data, req.authUser, 'user_created', 'user', user.id, `Usuario ${user.email} criado.`, req);
    return { user: sanitizeUser(user) };
  }, persistUserMutation);

  if (result.duplicate) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  res.status(201).json(result);
}));

app.patch('/api/users/:id', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const user = data.users.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!user) return { notFound: true };
    if (req.authUser.role !== 'admin' && ['admin', 'owner'].includes(user.role)) return { forbidden: true };

    const nextRole = req.body.role !== undefined && ['admin', 'owner', 'barber', 'attendant', 'client'].includes(req.body.role)
      ? req.body.role
      : user.role;
    if (req.authUser.role !== 'admin' && ['admin', 'owner'].includes(nextRole)) return { forbidden: true };
    const activeOwners = tenantData.users.filter((item) => ['admin', 'owner'].includes(item.role) && item.status === 'active');
    const wouldRemoveLastOwner =
      activeOwners.length <= 1 &&
      activeOwners[0]?.id === user.id &&
      ((req.body.status && req.body.status !== 'active') || !['admin', 'owner'].includes(nextRole));
    if (wouldRemoveLastOwner) return { lastOwner: true };

    if (req.body.name !== undefined) user.name = cleanText(req.body.name, 140) || user.name;
    if (req.body.phone !== undefined) user.phone = cleanText(req.body.phone, 32);
    if (req.body.email !== undefined) {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!isValidEmail(email)) return { invalid: 'E-mail invalido.' };
      if (data.users.some((item) => item.id !== user.id && String(item.email || '').toLowerCase() === email)) return { duplicate: true };
      user.email = email;
    }
    if (req.body.password !== undefined) {
      const passwordPolicy = validateStrongPassword(String(req.body.password || ''), { minLength: IS_PRODUCTION ? 10 : 8 });
      if (!passwordPolicy.ok) return { invalid: passwordPolicy.errors.join(' ') };
      user.passwordHash = bcrypt.hashSync(String(req.body.password), IS_PRODUCTION ? 12 : 10);
      user.passwordChangedAt = isoNow();
      user.mustChangePassword = false;
    }
    if (req.body.role !== undefined) user.role = nextRole;
    if (req.body.status !== undefined) {
      user.status = ['active', 'inactive', 'blocked'].includes(req.body.status) ? req.body.status : user.status;
    }
    if (req.body.mustChangePassword !== undefined) user.mustChangePassword = Boolean(req.body.mustChangePassword);

    const linkedClient = user.clientId ? data.clients.find((client) => client.id === user.clientId && sameTenant(req.authUser, client)) : null;
    if (linkedClient) {
      linkedClient.name = user.name;
      linkedClient.phone = user.phone;
      linkedClient.email = user.email;
    }
    const linkedBarber = user.barberId ? data.barbers.find((barber) => barber.id === user.barberId && sameTenant(req.authUser, barber)) : null;
    if (linkedBarber) {
      linkedBarber.name = user.name;
      linkedBarber.phone = user.phone;
      linkedBarber.email = user.email;
    }

    user.updatedAt = isoNow();
    audit(data, req.authUser, 'user_updated', 'user', user.id, `Usuario ${user.email} atualizado.`, req);
    return { user: sanitizeUser(user) };
  }, persistUserMutation);

  if (result.notFound) return sendError(res, 404, 'Usuario nao encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Seu perfil nao pode alterar este usuario.');
  if (result.lastOwner) return sendError(res, 409, 'Nao e possivel remover o ultimo administrador/dono ativo do tenant.');
  if (result.duplicate) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/users/:id', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const user = data.users.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!user) return { notFound: true };
    if (user.id === req.authUser.id) return { self: true };
    if (req.authUser.role !== 'admin' && ['admin', 'owner'].includes(user.role)) return { forbidden: true };
    const activeOwners = tenantData.users.filter((item) => ['admin', 'owner'].includes(item.role) && item.status === 'active');
    if (activeOwners.length <= 1 && activeOwners[0]?.id === user.id) return { lastOwner: true };

    user.status = 'inactive';
    user.deactivatedAt = isoNow();
    audit(data, req.authUser, 'user_deactivated', 'user', user.id, `Usuario ${user.email} desativado.`, req);
    return { user: sanitizeUser(user), deactivated: true };
  }, persistUserMutation);

  if (result.notFound) return sendError(res, 404, 'Usuario nao encontrado.');
  if (result.self) return sendError(res, 409, 'Voce nao pode desativar sua propria conta.');
  if (result.forbidden) return sendError(res, 403, 'Seu perfil nao pode desativar este usuario.');
  if (result.lastOwner) return sendError(res, 409, 'Nao e possivel desativar o ultimo administrador/dono ativo do tenant.');
  res.json(result);
}));

app.post('/api/tenants', authenticate, requireRoles('admin'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const tenantName = cleanText(body.name, 140);
  const slug = cleanSlug(body.slug || body.name);
  const ownerName = cleanText(body.ownerName, 140);
  const ownerEmail = String(body.ownerEmail || '').trim().toLowerCase();
  const ownerPhone = cleanText(body.ownerPhone, 32);
  const ownerPassword = String(body.ownerPassword || '');
  const unitName = cleanText(body.unitName || body.name, 140);

  if (!tenantName || !slug || !ownerName || !ownerEmail || !ownerPhone || !ownerPassword) {
    return sendError(res, 400, 'Informe nome da barbearia, slug, nome/e-mail/telefone/senha do dono.');
  }
  if (!isValidEmail(ownerEmail)) return sendError(res, 400, 'E-mail do dono invalido.');
  const passwordPolicy = validateStrongPassword(ownerPassword, { minLength: 10 });
  if (!passwordPolicy.ok) return sendError(res, 400, passwordPolicy.errors.join(' '));

  const result = await mutateDataWithMysqlOperation((data) => {
    data.tenants = data.tenants || [];
    if (data.tenants.some((tenant) => tenant.id === slug || tenant.slug === slug)) return { duplicateTenant: true };
    if (data.users.some((user) => String(user.email || '').toLowerCase() === ownerEmail)) return { duplicateEmail: true };

    const tenant = {
      id: `tenant_${slug.replace(/-/g, '_')}`,
      name: tenantName,
      slug,
      status: 'active',
      createdAt: isoNow()
    };
    const unit = {
      id: id('unit'),
      tenantId: tenant.id,
      name: unitName,
      phone: ownerPhone,
      whatsapp: cleanText(body.whatsapp || ownerPhone, 32),
      email: ownerEmail,
      address: cleanText(body.address, 500),
      status: 'active'
    };
    const ownerUser = {
      id: id('usr'),
      tenantId: tenant.id,
      role: 'owner',
      name: ownerName,
      email: ownerEmail,
      phone: ownerPhone,
      passwordHash: bcrypt.hashSync(ownerPassword, 12),
      mustChangePassword: true,
      status: 'active',
      avatar: '',
      createdAt: isoNow()
    };

    data.tenants.push(tenant);
    data.units.push(unit);
    data.users.push(ownerUser);
    audit(data, req.authUser, 'tenant_created', 'tenant', tenant.id, `Tenant ${tenant.name} criado.`, req);
    audit(data, ownerUser, 'owner_created', 'user', ownerUser.id, `Dono inicial de ${tenant.name} criado.`, req);
    return {
      tenant,
      unit,
      owner: sanitizeUser(ownerUser)
    };
  }, persistTenantMutation);

  if (result.duplicateTenant) return sendError(res, 409, 'Ja existe uma barbearia com este slug.');
  if (result.duplicateEmail) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  return res.status(201).json(result);
}));

app.get('/api/dashboard', heavyReadLimiter, authenticate, asyncRoute(async (req, res) => {
  if (ADMIN_ROLES.includes(req.authUser.role) || req.authUser.role === 'barber') {
    const reconciliation = await runOperationalReconciliation({ user: req.authUser, req });
    if (reconciliation.updated) reportCache.invalidate('operational_reconciliation');
  }
  const rawData = await readOperationalData();
  const data = scopedDataForUser(rawData, req.authUser);
  res.json({
    ...dashboardPayload(req.authUser, data),
    persistence: getStoreInfo()
  });
}));

app.post('/api/operations/reconcile', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await runOperationalReconciliation({ user: req.authUser, req, recordRun: true });
  if (result.updated) reportCache.invalidate('operational_reconciliation');
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({
    ...result,
    operationalReconciliation: operationalReconciliationView(data.operationalReconciliation, req.authUser),
    persistence: getStoreInfo()
  });
}));

app.get('/api/availability', asyncRoute(async (req, res) => {
  const rawData = await readOperationalData();
  const data = scopedDataForUser(rawData, { tenantId: tenantFromRequest(req, rawData) });
  res.json({ availability: availabilityFor(data, req.query) });
}));

app.get('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
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
}));

app.post('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const result = await mutateDataWithMysqlOperation((data) => {
    const user = req.authUser;
    const tenantId = tenantIdOf(user);
    const tenantData = scopedDataForUser(data, user);
    if (user.role === 'barber') return { forbidden: true };
    if (!textLengthOk(body.notes, 500) || !textLengthOk(body.internalNotes, 500)) {
      return { invalid: 'Observacoes devem ter no maximo 500 caracteres.' };
    }
    const client = user.role === 'client' ? findClientForUser(user, tenantData) : tenantData.clients.find((item) => item.id === body.clientId);
    const allowFitIn = Boolean(body.allowFitIn && ADMIN_ROLES.includes(user.role));
    const service = tenantData.services.find((item) => item.id === body.serviceId);
    const status = ADMIN_ROLES.includes(user.role) && APPOINTMENT_STATUSES.includes(body.status)
      ? body.status
      : 'scheduled';
    const draft = {
      clientId: client?.id,
      barberId: body.barberId,
      serviceId: body.serviceId,
      unitId: body.unitId || tenantData.settings.defaultUnitId,
      date: body.date,
      startTime: body.startTime,
      endTime: service ? endTime(body.startTime, service.durationMinutes) : body.endTime
    };
    const validation = validateSchedule(tenantData, draft, { allowFitIn, viewer: user });
    if (!validation.ok) return { error: validation };

    const appointment = {
      id: id('apt'),
      tenantId,
      code: `BP-${String(data.appointments.length + 1001).padStart(4, '0')}`,
      clientId: draft.clientId,
      barberId: draft.barberId,
      serviceId: draft.serviceId,
      unitId: draft.unitId,
      date: draft.date,
      startTime: draft.startTime,
      endTime: validation.endTime,
      status,
      notes: cleanText(body.notes, 500),
      internalNotes: ADMIN_ROLES.includes(user.role) ? cleanText(body.internalNotes, 500) : '',
      isFitIn: Boolean(validation.conflict && allowFitIn),
      createdAt: isoNow(),
      updatedAt: isoNow()
    };

    data.appointments.push(appointment);
    reportCache.invalidate('appointment_created');
    data.notifications.push(
      {
        id: id('ntf'),
        tenantId,
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
        tenantId,
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
  }, persistAppointmentMutation);

  if (result.forbidden) return sendError(res, 403, 'Barbeiros não podem criar agendamentos para outros clientes.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  if (result.error) return sendError(res, result.error.conflict ? 409 : 400, result.error.message, result.error.conflict);
  res.status(201).json(result);
}));

app.post('/api/appointments/:id/status', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!APPOINTMENT_STATUSES.includes(status)) return sendError(res, 400, 'Status inválido.');

  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const appointment = data.appointments.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!appointment) return { notFound: true };
    if (req.authUser.role === 'barber' && appointment.barberId !== req.authUser.barberId) return { forbidden: true };
    if (TERMINAL_STATUSES.includes(appointment.status) && appointment.status !== status && !OWNER_ROLES.includes(req.authUser.role)) {
      return { locked: true };
    }

    const previousStatus = appointment.status;
    appointment.status = status;
    appointment.updatedAt = isoNow();
    const service = tenantData.services.find((item) => item.id === appointment.serviceId);
    const barber = tenantData.barbers.find((item) => item.id === appointment.barberId);
    const commission = data.commissions.find((item) => item.appointmentId === appointment.id && sameTenant(req.authUser, item));
    if (commission) {
      commission.status = 'cancelled';
    }
    const client = tenantData.clients.find((item) => item.id === appointment.clientId);

    if (status === 'finished') {
      const existingCommission = data.commissions.find((item) => item.appointmentId === appointment.id);
      if (!existingCommission && barber && service) {
        data.commissions.push({
          id: id('com'),
          tenantId: tenantIdOf(req.authUser),
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

    reportCache.invalidate('appointment_status_changed');
    audit(data, req.authUser, 'appointment_status_changed', 'appointment', appointment.id, `Status alterado para ${status}.`, req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  }, persistAppointmentMutation);

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Este agendamento pertence a outro barbeiro.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser alterados por este perfil.');
  res.json(result);
}));

app.post('/api/appointments/:id/reschedule', authenticate, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const appointment = data.appointments.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
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
    const draftService = tenantData.services.find((item) => item.id === draft.serviceId);
    draft.endTime = draftService ? endTime(draft.startTime, draftService.durationMinutes) : appointment.endTime;
    const validation = validateSchedule(tenantData, draft, {
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
      tenantId: tenantIdOf(req.authUser),
      userId: validation.client.userId,
      channel: 'whatsapp',
      title: 'Agendamento remarcado',
      message: `Seu atendimento foi remarcado para ${appointment.date} às ${appointment.startTime}.`,
      status: 'queued',
      scheduledFor: isoNow(),
      sentAt: null
    });
    reportCache.invalidate('appointment_rescheduled');
    audit(data, req.authUser, 'appointment_rescheduled', 'appointment', appointment.id, 'Agendamento remarcado.', req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  }, persistAppointmentMutation);

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode remarcar este atendimento.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser remarcados.');
  if (result.error) return sendError(res, result.error.conflict ? 409 : 400, result.error.message, result.error.conflict);
  res.json(result);
}));

app.post('/api/appointments/:id/cancel', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    if (!textLengthOk(req.body?.reason, 300)) return { invalid: 'Motivo do cancelamento deve ter no maximo 300 caracteres.' };
    const tenantData = scopedDataForUser(data, req.authUser);
    const appointment = data.appointments.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
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
    appointment.cancellationReason = cleanText(req.body?.reason, 300) || 'Cancelado pelo usuário.';
    appointment.updatedAt = isoNow();
    const client = tenantData.clients.find((item) => item.id === appointment.clientId);
    if (client?.userId) {
      data.notifications.unshift({
        id: id('ntf'),
        tenantId: tenantIdOf(req.authUser),
        userId: client.userId,
        channel: 'whatsapp',
        title: 'Agendamento cancelado',
        message: `O atendimento ${appointment.code} foi cancelado.`,
        status: 'queued',
        scheduledFor: isoNow(),
        sentAt: null
      });
    }
    reportCache.invalidate('appointment_cancelled');
    audit(data, req.authUser, 'appointment_cancelled', 'appointment', appointment.id, appointment.cancellationReason, req);
    return { appointment: appointmentView(appointment, data, req.authUser) };
  }, persistAppointmentMutation);

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode cancelar este atendimento.');
  if (result.locked) return sendError(res, 409, 'Agendamentos finalizados, cancelados ou marcados como falta não podem ser cancelados.');
  if (result.tooLate) return sendError(res, 409, 'O prazo para cancelamento pelo cliente foi encerrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.post('/api/reviews', authenticate, asyncRoute(async (req, res) => {
  const { appointmentId, rating, comment } = req.body || {};
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const appointment = data.appointments.find((item) => item.id === appointmentId && sameTenant(req.authUser, item));
    if (!appointment) return { notFound: true };
    const client = findClientForUser(req.authUser, tenantData);
    if (req.authUser.role !== 'client' || !client || appointment.clientId !== client.id) return { forbidden: true };
    return createAppointmentReview(data, appointment, rating, comment, {
      auditUser: req.authUser,
      req
    });
  }, persistReviewMutation);

  if (result.notFound) return sendError(res, 404, 'Agendamento não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode avaliar este atendimento.');
  if (result.notFinished) return sendError(res, 409, 'Somente atendimentos finalizados podem ser avaliados.');
  if (result.invalidRating) return sendError(res, 400, 'Avaliação inválida.');
  if (result.duplicate) return sendError(res, 409, 'Este atendimento já foi avaliado.');
  res.status(201).json(result);
}));

app.get('/api/services', authenticate, asyncRoute(async (req, res) => {
  res.json({ services: scopedDataForUser(await readOperationalData(), req.authUser).services });
}));

app.post('/api/services', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const tenantData = scopedDataForUser(data, req.authUser);
    if (!isMoneyInRange(req.body.price, 0.01, MAX_SERVICE_PRICE)) {
      return { invalid: `Preco deve ficar entre R$ 0,01 e R$ ${MAX_SERVICE_PRICE}.` };
    }
    if (!cleanText(req.body.name, 120)) return { invalid: 'Nome do serviço é obrigatório.' };
    if (!isPositiveNumber(req.body.price)) return { invalid: 'Preço inválido.' };
    if (!Number.isInteger(Number(req.body.durationMinutes)) || Number(req.body.durationMinutes) <= 0) {
      return { invalid: 'Duração inválida.' };
    }
    const barberIds = Array.isArray(req.body.barberIds)
      ? req.body.barberIds.filter((barberId) => tenantData.barbers.some((barber) => barber.id === barberId))
      : [];
    const service = {
      id: id('srv'),
      tenantId,
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
    reportCache.invalidate('service_created');
    audit(data, req.authUser, 'service_created', 'service', service.id, service.name, req);
    return { service };
  }, persistServiceMutation);
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/services/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const service = data.services.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!service) return { notFound: true };
    if (req.body.name !== undefined) service.name = cleanText(req.body.name, 120);
    if (req.body.description !== undefined) service.description = cleanText(req.body.description, 800);
    if (req.body.price !== undefined) {
      if (!isMoneyInRange(req.body.price, 0.01, MAX_SERVICE_PRICE)) {
        return { invalid: `Preco deve ficar entre R$ 0,01 e R$ ${MAX_SERVICE_PRICE}.` };
      }
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
        ? req.body.barberIds.filter((barberId) => tenantData.barbers.some((barber) => barber.id === barberId))
        : service.barberIds;
    }
    if (req.body.active !== undefined) service.active = Boolean(req.body.active);
    reportCache.invalidate('service_updated');
    audit(data, req.authUser, 'service_updated', 'service', service.id, service.name, req);
    return { service };
  }, persistServiceMutation);
  if (result.notFound) return sendError(res, 404, 'Serviço não encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/services/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.services.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const service = data.services[index];
    const hasAppointments = data.appointments.some((appointment) => appointment.serviceId === service.id && sameTenant(req.authUser, appointment));
    if (hasAppointments) {
      service.active = false;
      service.archivedAt = isoNow();
      audit(data, req.authUser, 'service_archived', 'service', service.id, service.name, req);
      reportCache.invalidate('service_archived');
      return { service, archived: true };
    }

    data.services.splice(index, 1);
    audit(data, req.authUser, 'service_deleted', 'service', service.id, service.name, req);
    reportCache.invalidate('service_deleted');
    return { service, deleted: true };
  }, persistServiceMutation);
  if (result.notFound) return sendError(res, 404, 'Servico nao encontrado.');
  res.json(result);
}));

app.get('/api/customers', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  const term = String(req.query.search || '').toLowerCase();
  const customers = data.clients.filter((client) =>
    [client.name, client.email, client.phone, ...(client.tags || [])].join(' ').toLowerCase().includes(term)
  );
  res.json({ customers });
}));

app.post('/api/customers', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const tenantData = scopedDataForUser(data, req.authUser);
    const name = cleanText(req.body.name, 140);
    const phone = cleanText(req.body.phone, 32);
    const email = cleanText(req.body.email, 180).toLowerCase();
    if (!name || !phone) return { invalid: 'Informe nome e telefone do cliente.' };
    if (email && !isValidEmail(email)) return { invalid: 'E-mail invalido.' };
    if (email && data.users.some((user) => String(user.email || '').toLowerCase() === email)) return { duplicate: true };
    if (req.body.birthDate && !isValidDate(req.body.birthDate)) return { invalid: 'Data de aniversario invalida.' };

    const client = {
      id: id('client'),
      tenantId,
      userId: null,
      name,
      phone,
      email,
      birthDate: req.body.birthDate || null,
      loyaltyPoints: 0,
      visits: 0,
      noShows: 0,
      preferredBarberId: tenantData.barbers.some((barber) => barber.id === req.body.preferredBarberId)
        ? req.body.preferredBarberId
        : null,
      notes: cleanText(req.body.notes, 1000),
      tags: Array.isArray(req.body.tags) ? req.body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 12) : [],
      createdAt: isoNow()
    };

    if (req.body.createUser) {
      const password = String(req.body.password || '');
      if (!email || !password) return { invalid: 'Para criar acesso, informe e-mail e senha.' };
      const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
      if (!passwordPolicy.ok) return { invalid: passwordPolicy.errors.join(' ') };
      const user = {
        id: id('usr'),
        tenantId,
        role: 'client',
        name,
        email,
        phone,
        passwordHash: bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10),
        mustChangePassword: true,
        status: 'active',
        clientId: client.id,
        birthDate: client.birthDate,
        avatar: '',
        createdAt: isoNow()
      };
      client.userId = user.id;
      data.users.push(user);
    }

    data.clients.push(client);
    audit(data, req.authUser, 'customer_created', 'client', client.id, client.name, req);
    return { client };
  }, persistCustomerMutation);

  if (result.duplicate) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/customers/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    if (!textLengthOk(req.body.notes, 1000)) return { invalid: 'Notas do cliente devem ter no maximo 1000 caracteres.' };
    const tenantData = scopedDataForUser(data, req.authUser);
    const client = data.clients.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!client) return { notFound: true };
    const linkedUser = client.userId ? data.users.find((user) => user.id === client.userId && sameTenant(req.authUser, user)) : null;
    if (req.body.name !== undefined) {
      client.name = cleanText(req.body.name, 140);
      if (linkedUser) linkedUser.name = client.name;
    }
    if (req.body.phone !== undefined) {
      client.phone = cleanText(req.body.phone, 32);
      if (linkedUser) linkedUser.phone = client.phone;
    }
    if (req.body.email !== undefined) {
      if (req.body.email && !isValidEmail(req.body.email)) return { invalid: 'E-mail inválido.' };
      const nextEmail = cleanText(req.body.email, 180).toLowerCase();
      if (
        nextEmail &&
        data.users.some((user) => user.id !== linkedUser?.id && String(user.email || '').toLowerCase() === nextEmail)
      ) {
        return { invalid: 'Ja existe usuario com este e-mail.' };
      }
      client.email = nextEmail;
      if (linkedUser) linkedUser.email = nextEmail;
    }
    if (req.body.birthDate !== undefined) {
      if (req.body.birthDate && !isValidDate(req.body.birthDate)) return { invalid: 'Data de aniversário inválida.' };
      client.birthDate = req.body.birthDate || null;
    }
    if (req.body.preferredBarberId !== undefined) {
      client.preferredBarberId = tenantData.barbers.some((barber) => barber.id === req.body.preferredBarberId)
        ? req.body.preferredBarberId
        : null;
    }
    if (req.body.notes !== undefined) client.notes = cleanText(req.body.notes, 1000);
    if (Array.isArray(req.body.tags)) client.tags = req.body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 12);
    audit(data, req.authUser, 'customer_updated', 'client', client.id, client.name, req);
    return { client };
  }, persistCustomerMutation);
  if (result.notFound) return sendError(res, 404, 'Cliente não encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/customers/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.clients.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const client = data.clients[index];
    const hasHistory = data.appointments.some((appointment) => appointment.clientId === client.id && sameTenant(req.authUser, appointment));
    const linkedUser = client.userId ? data.users.find((user) => user.id === client.userId && sameTenant(req.authUser, user)) : null;
    if (hasHistory) {
      client.status = 'inactive';
      client.archivedAt = isoNow();
      if (linkedUser) linkedUser.status = 'inactive';
      audit(data, req.authUser, 'customer_archived', 'client', client.id, client.name, req);
      return { client, archived: true };
    }

    if (linkedUser) data.users = data.users.filter((user) => user.id !== linkedUser.id);
    data.clients.splice(index, 1);
    audit(data, req.authUser, 'customer_deleted', 'client', client.id, client.name, req);
    return { client, deleted: true };
  }, persistCustomerMutation);

  if (result.notFound) return sendError(res, 404, 'Cliente nao encontrado.');
  res.json(result);
}));

app.get('/api/barbers', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  res.json({ barbers: scopedDataForUser(await readOperationalData(), req.authUser).barbers });
}));

app.post('/api/barbers', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const tenantData = scopedDataForUser(data, req.authUser);
    const name = cleanText(req.body.name, 140);
    const email = cleanText(req.body.email, 180).toLowerCase();
    const phone = cleanText(req.body.phone, 32);
    if (!name) return { invalid: 'Nome do barbeiro e obrigatorio.' };
    if (email && !isValidEmail(email)) return { invalid: 'E-mail invalido.' };
    if (email && data.users.some((user) => String(user.email || '').toLowerCase() === email)) return { duplicate: true };

    const unitIds = Array.isArray(req.body.unitIds)
      ? req.body.unitIds.filter((unitId) => tenantData.units.some((unit) => unit.id === unitId))
      : tenantData.units[0]?.id ? [tenantData.units[0].id] : [];
    const barber = {
      id: id('barber'),
      tenantId,
      userId: null,
      name,
      phone,
      email,
      bio: cleanText(req.body.bio, 800),
      specialties: Array.isArray(req.body.specialties)
        ? req.body.specialties.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 12)
        : [],
      commissionRate: Math.min(1, Math.max(0, numberValue(req.body.commissionRate, 0.4))),
      rating: Math.min(5, Math.max(0, numberValue(req.body.rating, 5))),
      goalMonthly: Math.max(0, numberValue(req.body.goalMonthly, 0)),
      unitIds,
      status: req.body.status === 'inactive' ? 'inactive' : 'active',
      blocks: [],
      createdAt: isoNow()
    };

    if (req.body.createUser) {
      const password = String(req.body.password || '');
      if (!email || !password) return { invalid: 'Para criar acesso, informe e-mail e senha.' };
      const passwordPolicy = validateStrongPassword(password, { minLength: IS_PRODUCTION ? 10 : 8 });
      if (!passwordPolicy.ok) return { invalid: passwordPolicy.errors.join(' ') };
      const user = {
        id: id('usr'),
        tenantId,
        role: 'barber',
        name,
        email,
        phone,
        passwordHash: bcrypt.hashSync(password, IS_PRODUCTION ? 12 : 10),
        mustChangePassword: true,
        status: 'active',
        barberId: barber.id,
        avatar: '',
        createdAt: isoNow()
      };
      barber.userId = user.id;
      data.users.push(user);
    }

    data.barbers.push(barber);
    if (Array.isArray(req.body.serviceIds)) {
      for (const service of data.services.filter((item) => sameTenant(req.authUser, item))) {
        service.barberIds = service.barberIds || [];
        if (req.body.serviceIds.includes(service.id) && !service.barberIds.includes(barber.id)) {
          service.barberIds.push(barber.id);
        }
      }
    }
    audit(data, req.authUser, 'barber_created', 'barber', barber.id, barber.name, req);
    return { barber };
  }, persistBarberMutation);

  if (result.duplicate) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/barbers/:id', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const barber = data.barbers.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!barber) return { notFound: true };
    if (req.authUser.role === 'barber' && req.authUser.barberId !== barber.id) return { forbidden: true };
    const canManage = ADMIN_ROLES.includes(req.authUser.role);

    if (req.body.name !== undefined) barber.name = cleanText(req.body.name, 140) || barber.name;
    if (req.body.phone !== undefined) barber.phone = cleanText(req.body.phone, 32);
    if (req.body.email !== undefined) {
      const email = cleanText(req.body.email, 180).toLowerCase();
      if (email && !isValidEmail(email)) return { invalid: 'E-mail invalido.' };
      const linkedUser = barber.userId ? data.users.find((user) => user.id === barber.userId) : null;
      if (email && data.users.some((user) => user.id !== linkedUser?.id && String(user.email || '').toLowerCase() === email)) {
        return { duplicate: true };
      }
      barber.email = email;
    }
    if (req.body.bio !== undefined) barber.bio = cleanText(req.body.bio, 800);
    if (Array.isArray(req.body.specialties)) {
      barber.specialties = req.body.specialties.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 12);
    }
    if (canManage && req.body.commissionRate !== undefined) barber.commissionRate = Math.min(1, Math.max(0, numberValue(req.body.commissionRate, barber.commissionRate)));
    if (canManage && req.body.goalMonthly !== undefined) barber.goalMonthly = Math.max(0, numberValue(req.body.goalMonthly, barber.goalMonthly));
    if (canManage && req.body.unitIds !== undefined) {
      barber.unitIds = Array.isArray(req.body.unitIds)
        ? req.body.unitIds.filter((unitId) => tenantData.units.some((unit) => unit.id === unitId))
        : barber.unitIds;
    }
    if (canManage && req.body.status !== undefined) {
      barber.status = ['active', 'inactive', 'blocked'].includes(req.body.status) ? req.body.status : barber.status;
    }
    if (canManage && Array.isArray(req.body.serviceIds)) {
      for (const service of data.services.filter((item) => sameTenant(req.authUser, item))) {
        service.barberIds = (service.barberIds || []).filter((barberId) => barberId !== barber.id);
        if (req.body.serviceIds.includes(service.id)) service.barberIds.push(barber.id);
      }
    }

    const linkedUser = barber.userId ? data.users.find((user) => user.id === barber.userId && sameTenant(req.authUser, user)) : null;
    if (linkedUser) {
      linkedUser.name = barber.name;
      linkedUser.phone = barber.phone;
      linkedUser.email = barber.email;
      if (canManage) linkedUser.status = barber.status === 'active' ? 'active' : 'inactive';
    }

    barber.updatedAt = isoNow();
    audit(data, req.authUser, 'barber_updated', 'barber', barber.id, barber.name, req);
    return { barber };
  }, persistBarberMutation);

  if (result.notFound) return sendError(res, 404, 'Barbeiro nao encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Voce nao pode alterar este barbeiro.');
  if (result.duplicate) return sendError(res, 409, 'Ja existe usuario com este e-mail.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/barbers/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.barbers.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const barber = data.barbers[index];
    const hasHistory = data.appointments.some((appointment) => appointment.barberId === barber.id && sameTenant(req.authUser, appointment));
    const linkedUser = barber.userId ? data.users.find((user) => user.id === barber.userId && sameTenant(req.authUser, user)) : null;
    if (hasHistory) {
      barber.status = 'inactive';
      barber.archivedAt = isoNow();
      if (linkedUser) linkedUser.status = 'inactive';
      audit(data, req.authUser, 'barber_archived', 'barber', barber.id, barber.name, req);
      return { barber, archived: true };
    }

    for (const service of data.services) {
      service.barberIds = (service.barberIds || []).filter((barberId) => barberId !== barber.id);
    }
    if (linkedUser) data.users = data.users.filter((user) => user.id !== linkedUser.id);
    data.barbers.splice(index, 1);
    audit(data, req.authUser, 'barber_deleted', 'barber', barber.id, barber.name, req);
    return { barber, deleted: true };
  }, persistBarberMutation);

  if (result.notFound) return sendError(res, 404, 'Barbeiro nao encontrado.');
  res.json(result);
}));

app.post('/api/barbers/:id/blocks', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const barber = data.barbers.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
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
  }, persistBarberMutation);
  if (result.notFound) return sendError(res, 404, 'Barbeiro não encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Você não pode bloquear a agenda deste barbeiro.');
  if (result.invalid) return sendError(res, 400, 'Informe data e horarios validos para o bloqueio.');
  if (result.conflict) return sendError(res, 409, 'Ja existe bloqueio para este intervalo.');
  res.status(201).json(result);
}));

app.get('/api/products', authenticate, requireRoles(...INVENTORY_ROLES), asyncRoute(async (req, res) => {
  res.json({ products: scopedDataForUser(await readOperationalData(), req.authUser).products });
}));

app.post('/api/products', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    if (!isInventoryQuantity(req.body.quantity, { allowZero: true })) return { invalid: `Quantidade deve ser inteiro entre 0 e ${MAX_STOCK_QUANTITY}.` };
    if (!isMoneyInRange(req.body.purchasePrice || 0, 0, MAX_PRODUCT_PRICE)) return { invalid: `Valor de compra deve ficar entre R$ 0 e R$ ${MAX_PRODUCT_PRICE}.` };
    if (!isMoneyInRange(req.body.salePrice || 0, 0, MAX_PRODUCT_PRICE)) return { invalid: `Valor de venda deve ficar entre R$ 0 e R$ ${MAX_PRODUCT_PRICE}.` };
    if (!cleanText(req.body.name, 140)) return { invalid: 'Nome do produto é obrigatório.' };
    if (!Number.isInteger(Number(req.body.quantity)) || Number(req.body.quantity) < 0) return { invalid: 'Quantidade inválida.' };
    if (!Number.isFinite(Number(req.body.purchasePrice)) || Number(req.body.purchasePrice) < 0) return { invalid: 'Valor de compra inválido.' };
    if (!Number.isFinite(Number(req.body.salePrice)) || Number(req.body.salePrice) < 0) return { invalid: 'Valor de venda inválido.' };
    if (!Number.isInteger(Number(req.body.minStock)) || Number(req.body.minStock) < 0) return { invalid: 'Estoque mínimo inválido.' };
    const product = {
      id: id('prd'),
      tenantId,
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
    reportCache.invalidate('product_created');
    audit(data, req.authUser, 'product_created', 'product', product.id, product.name, req);
    return { product };
  }, persistProductMutation);
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/products/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const product = data.products.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!product) return { notFound: true };

    if (req.body.name !== undefined) {
      const name = cleanText(req.body.name, 140);
      if (!name) return { invalid: 'Nome do produto e obrigatorio.' };
      product.name = name;
    }
    if (req.body.category !== undefined) product.category = cleanText(req.body.category, 100) || 'Geral';
    if (req.body.quantity !== undefined) {
      if (!isInventoryQuantity(req.body.quantity, { allowZero: true })) return { invalid: `Quantidade deve ser inteiro entre 0 e ${MAX_STOCK_QUANTITY}.` };
      product.quantity = Number(req.body.quantity);
    }
    if (req.body.purchasePrice !== undefined) {
      if (!isMoneyInRange(req.body.purchasePrice, 0, MAX_PRODUCT_PRICE)) return { invalid: `Valor de compra deve ficar entre R$ 0 e R$ ${MAX_PRODUCT_PRICE}.` };
      product.purchasePrice = Number(req.body.purchasePrice);
    }
    if (req.body.salePrice !== undefined) {
      if (!isMoneyInRange(req.body.salePrice, 0, MAX_PRODUCT_PRICE)) return { invalid: `Valor de venda deve ficar entre R$ 0 e R$ ${MAX_PRODUCT_PRICE}.` };
      product.salePrice = Number(req.body.salePrice);
    }
    if (req.body.minStock !== undefined) {
      if (!isInventoryQuantity(req.body.minStock, { allowZero: true })) return { invalid: 'Estoque minimo invalido.' };
      product.minStock = Number(req.body.minStock);
    }
    if (req.body.sku !== undefined) product.sku = cleanText(req.body.sku, 80) || product.sku;
    if (req.body.active !== undefined) product.active = Boolean(req.body.active);
    product.updatedAt = isoNow();

    reportCache.invalidate('product_updated');
    audit(data, req.authUser, 'product_updated', 'product', product.id, product.name, req);
    return { product };
  }, persistProductMutation);
  if (result.notFound) return sendError(res, 404, 'Produto nao encontrado.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/products/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.products.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const product = data.products[index];
    const hasMovements = data.stockMovements.some((movement) => movement.productId === product.id && sameTenant(req.authUser, movement));
    if (hasMovements) {
      product.active = false;
      product.archivedAt = isoNow();
      audit(data, req.authUser, 'product_archived', 'product', product.id, product.name, req);
      reportCache.invalidate('product_archived');
      return { product, archived: true };
    }

    data.products.splice(index, 1);
    audit(data, req.authUser, 'product_deleted', 'product', product.id, product.name, req);
    reportCache.invalidate('product_deleted');
    return { product, deleted: true };
  }, persistProductMutation);
  if (result.notFound) return sendError(res, 404, 'Produto nao encontrado.');
  res.json(result);
}));

app.post('/api/products/:id/movements', authenticate, requireRoles(...INVENTORY_ROLES), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const product = data.products.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!product) return { notFound: true };
    const quantity = Number(req.body.quantity || 0);
    const type = req.body.type || 'adjustment';
    if (!['purchase', 'sale', 'usage', 'loss', 'adjustment'].includes(type)) return { invalid: true };
    if (!isInventoryQuantity(quantity, { allowZero: type === 'adjustment' })) return { invalid: true };
    if (!Number.isInteger(quantity) || quantity < (type === 'adjustment' ? 0 : 1)) return { invalid: true };
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
      tenantId,
      productId: product.id,
      type,
      quantity,
      unitValue,
      reason: cleanText(req.body.reason, 300) || 'Movimentação manual',
      createdAt: isoNow(),
      userId: req.authUser.id
    };
    data.stockMovements.unshift(movement);
    reportCache.invalidate('stock_movement_created');
    if (product.quantity <= product.minStock) {
      data.notifications.unshift({
        id: id('ntf'),
        tenantId,
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
  }, persistStockMovementMutation);

  if (result.notFound) return sendError(res, 404, 'Produto não encontrado.');
  if (result.invalid) return sendError(res, 400, 'Tipo de movimentação inválido.');
  if (result.insufficientStock) return sendError(res, 409, 'Estoque insuficiente para esta movimentacao.');
  res.status(201).json(result);
}));

app.get('/api/promotions', authenticate, asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({ promotions: visiblePromotionsForUser(data, req.authUser) });
}));

app.post('/api/promotions', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantId = tenantIdOf(req.authUser);
    const tenantData = scopedDataForUser(data, req.authUser);
    const title = cleanText(req.body.title, 140);
    const code = cleanText(req.body.code || id('cupom'), 50).toUpperCase();
    const discountType = ['percent', 'fixed'].includes(req.body.discountType) ? req.body.discountType : null;
    const discountValue = Number(req.body.discountValue || 0);
    const startsAt = req.body.startsAt || dateKey();
    const endsAt = req.body.endsAt || dateKey();
    if (!title || !code || !discountType || !Number.isFinite(discountValue) || discountValue <= 0) return { invalid: true };
    if (!isValidDate(startsAt) || !isValidDate(endsAt) || startsAt > endsAt) return { invalid: true };
    if (discountType === 'percent' && discountValue > 100) return { invalid: true };
    if (tenantData.promotions.some((item) => String(item.code || '').toUpperCase() === code)) return { duplicate: true };
    const promotion = {
      id: id('promo'),
      tenantId,
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
  }, persistPromotionMutation);
  if (result.invalid) return sendError(res, 400, 'Dados da promocao invalidos.');
  if (result.duplicate) return sendError(res, 409, 'Ja existe promocao com este cupom.');
  res.status(201).json(result);
}));

app.patch('/api/promotions/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const promotion = data.promotions.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!promotion) return { notFound: true };

    if (req.body.title !== undefined) {
      const title = cleanText(req.body.title, 140);
      if (!title) return { invalid: true };
      promotion.title = title;
    }
    if (req.body.description !== undefined) promotion.description = cleanText(req.body.description, 800);
    if (req.body.code !== undefined) {
      const code = cleanText(req.body.code, 50).toUpperCase();
      if (!code) return { invalid: true };
      if (tenantData.promotions.some((item) => item.id !== promotion.id && String(item.code || '').toUpperCase() === code)) {
        return { duplicate: true };
      }
      promotion.code = code;
    }
    if (req.body.discountType !== undefined) {
      if (!['percent', 'fixed'].includes(req.body.discountType)) return { invalid: true };
      promotion.discountType = req.body.discountType;
    }
    if (req.body.discountValue !== undefined) {
      const value = Number(req.body.discountValue);
      if (!Number.isFinite(value) || value <= 0 || (promotion.discountType === 'percent' && value > 100)) return { invalid: true };
      promotion.discountValue = value;
    }
    if (req.body.startsAt !== undefined) {
      if (!isValidDate(req.body.startsAt)) return { invalid: true };
      promotion.startsAt = req.body.startsAt;
    }
    if (req.body.endsAt !== undefined) {
      if (!isValidDate(req.body.endsAt)) return { invalid: true };
      promotion.endsAt = req.body.endsAt;
    }
    if (promotion.startsAt > promotion.endsAt) return { invalid: true };
    if (req.body.audience !== undefined) promotion.audience = cleanText(req.body.audience, 80) || 'all';
    if (req.body.active !== undefined) promotion.active = Boolean(req.body.active);
    promotion.updatedAt = isoNow();

    audit(data, req.authUser, 'promotion_updated', 'promotion', promotion.id, promotion.title, req);
    return { promotion };
  }, persistPromotionMutation);
  if (result.notFound) return sendError(res, 404, 'Promocao nao encontrada.');
  if (result.duplicate) return sendError(res, 409, 'Ja existe promocao com este cupom.');
  if (result.invalid) return sendError(res, 400, 'Dados da promocao invalidos.');
  res.json(result);
}));

app.delete('/api/promotions/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.promotions.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const promotion = data.promotions[index];
    const hasCoupons = data.coupons.some((coupon) => coupon.promotionId === promotion.id && sameTenant(req.authUser, coupon));
    if (hasCoupons) {
      promotion.active = false;
      promotion.archivedAt = isoNow();
      audit(data, req.authUser, 'promotion_archived', 'promotion', promotion.id, promotion.title, req);
      return { promotion, archived: true };
    }

    data.promotions.splice(index, 1);
    audit(data, req.authUser, 'promotion_deleted', 'promotion', promotion.id, promotion.title, req);
    return { promotion, deleted: true };
  }, persistPromotionMutation);
  if (result.notFound) return sendError(res, 404, 'Promocao nao encontrada.');
  res.json(result);
}));

app.get('/api/expenses', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  const status = req.query.status;
  const expenses = data.expenses
    .filter((expense) => (!status ? true : expense.status === status))
    .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
  res.json({ expenses });
}));

app.post('/api/expenses', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const category = cleanText(req.body.category, 100) || 'Geral';
    const description = cleanText(req.body.description, 220);
    const amount = Number(req.body.amount || 0);
    const dueDate = req.body.dueDate || dateKey();
    if (!description) return { invalid: 'Descricao da despesa e obrigatoria.' };
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return { invalid: 'Valor da despesa invalido.' };
    if (!isValidDate(dueDate)) return { invalid: 'Data de vencimento invalida.' };
    const status = ['pending', 'paid', 'overdue', 'cancelled'].includes(req.body.status) ? req.body.status : 'pending';
    const expense = {
      id: id('exp'),
      tenantId: tenantIdOf(req.authUser),
      category,
      description,
      amount,
      dueDate,
      status,
      paidAt: status === 'paid' ? isoNow() : null,
      createdAt: isoNow()
    };
    data.expenses.unshift(expense);
    reportCache.invalidate('expense_created');
    audit(data, req.authUser, 'expense_created', 'expense', expense.id, expense.description, req);
    return { expense };
  }, persistExpenseMutation);

  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/expenses/:id', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const expense = data.expenses.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!expense) return { notFound: true };
    if (req.body.category !== undefined) expense.category = cleanText(req.body.category, 100) || expense.category;
    if (req.body.description !== undefined) {
      const description = cleanText(req.body.description, 220);
      if (!description) return { invalid: 'Descricao da despesa e obrigatoria.' };
      expense.description = description;
    }
    if (req.body.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return { invalid: 'Valor da despesa invalido.' };
      expense.amount = amount;
    }
    if (req.body.dueDate !== undefined) {
      if (!isValidDate(req.body.dueDate)) return { invalid: 'Data de vencimento invalida.' };
      expense.dueDate = req.body.dueDate;
    }
    if (req.body.status !== undefined) {
      if (!['pending', 'paid', 'overdue', 'cancelled'].includes(req.body.status)) return { invalid: 'Status da despesa invalido.' };
      expense.status = req.body.status;
      expense.paidAt = req.body.status === 'paid' ? expense.paidAt || isoNow() : null;
    }
    expense.updatedAt = isoNow();
    reportCache.invalidate('expense_updated');
    audit(data, req.authUser, 'expense_updated', 'expense', expense.id, expense.description, req);
    return { expense };
  }, persistExpenseMutation);

  if (result.notFound) return sendError(res, 404, 'Despesa nao encontrada.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.json(result);
}));

app.delete('/api/expenses/:id', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.expenses.findIndex((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (index === -1) return { notFound: true };
    const expense = data.expenses[index];
    if (expense.status === 'paid') {
      expense.status = 'cancelled';
      expense.cancelledAt = isoNow();
      audit(data, req.authUser, 'expense_cancelled', 'expense', expense.id, expense.description, req);
      reportCache.invalidate('expense_cancelled');
      return { expense, cancelled: true };
    }
    data.expenses.splice(index, 1);
    audit(data, req.authUser, 'expense_deleted', 'expense', expense.id, expense.description, req);
    reportCache.invalidate('expense_deleted');
    return { expense, deleted: true };
  }, persistExpenseMutation);

  if (result.notFound) return sendError(res, 404, 'Despesa nao encontrada.');
  res.json(result);
}));

app.get('/api/coupons', authenticate, asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({ coupons: visibleCouponsForUser(data, req.authUser) });
}));

app.post('/api/coupons', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const code = cleanText(req.body.code || id('cupom'), 50).toUpperCase();
    const client = req.body.clientId ? tenantData.clients.find((item) => item.id === req.body.clientId) : null;
    const promotion = req.body.promotionId ? tenantData.promotions.find((item) => item.id === req.body.promotionId) : null;
    const discountType = ['percent', 'fixed'].includes(req.body.discountType || promotion?.discountType)
      ? req.body.discountType || promotion?.discountType
      : 'fixed';
    const discountValue = Number(req.body.discountValue ?? promotion?.discountValue ?? 0);
    const expiresAt = req.body.expiresAt || promotion?.endsAt || futureDateKey(30);
    if (!code || !Number.isFinite(discountValue) || discountValue <= 0) return { invalid: true };
    if (discountType === 'percent' && discountValue > 100) return { invalid: true };
    if (!isValidDate(expiresAt)) return { invalid: true };
    if (tenantData.coupons.some((coupon) => String(coupon.code || '').toUpperCase() === code)) return { duplicate: true };

    const coupon = {
      id: id('cupom'),
      tenantId: tenantIdOf(req.authUser),
      promotionId: promotion?.id || null,
      clientId: client?.id || null,
      code,
      discountType,
      discountValue,
      expiresAt,
      usedAt: null,
      status: 'active',
      createdAt: isoNow()
    };
    data.coupons.unshift(coupon);
    audit(data, req.authUser, 'coupon_created', 'coupon', coupon.id, coupon.code, req);
    return { coupon };
  }, persistCouponMutation);

  if (result.duplicate) return sendError(res, 409, 'Ja existe cupom com este codigo.');
  if (result.invalid) return sendError(res, 400, 'Dados do cupom invalidos.');
  res.status(201).json(result);
}));

app.post('/api/coupons/:id/redeem', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const coupon = data.coupons.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!coupon) return { notFound: true };
    const client = req.authUser.role === 'client'
      ? findClientForUser(req.authUser, scopedDataForUser(data, req.authUser))
      : null;
    if (req.authUser.role === 'client' && coupon.clientId && coupon.clientId !== client?.id) return { forbidden: true };
    if (coupon.status !== 'active' || coupon.usedAt) return { unavailable: true };
    if (coupon.expiresAt && coupon.expiresAt < dateKey()) return { expired: true };
    coupon.status = 'used';
    coupon.usedAt = isoNow();
    coupon.usedByAppointmentId = req.body?.appointmentId || null;
    audit(data, req.authUser, 'coupon_redeemed', 'coupon', coupon.id, coupon.code, req);
    return { coupon };
  }, persistCouponMutation);

  if (result.notFound) return sendError(res, 404, 'Cupom nao encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Este cupom pertence a outro cliente.');
  if (result.unavailable) return sendError(res, 409, 'Cupom indisponivel para uso.');
  if (result.expired) return sendError(res, 409, 'Cupom expirado.');
  res.json(result);
}));

app.delete('/api/coupons/:id', authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const coupon = data.coupons.find((item) => item.id === req.params.id && sameTenant(req.authUser, item));
    if (!coupon) return { notFound: true };
    coupon.status = 'cancelled';
    coupon.cancelledAt = isoNow();
    audit(data, req.authUser, 'coupon_cancelled', 'coupon', coupon.id, coupon.code, req);
    return { coupon, cancelled: true };
  }, persistCouponMutation);

  if (result.notFound) return sendError(res, 404, 'Cupom nao encontrado.');
  res.json(result);
}));

app.get('/api/waitlist', authenticate, asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({ waitlist: visibleWaitlistForUser(data, req.authUser) });
}));

app.post('/api/waitlist', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const client = req.authUser.role === 'client'
      ? findClientForUser(req.authUser, tenantData)
      : tenantData.clients.find((item) => item.id === req.body.clientId);
    const service = tenantData.services.find((item) => item.id === req.body.serviceId);
    const barber = req.body.barberId ? tenantData.barbers.find((item) => item.id === req.body.barberId) : null;
    if (!client || !service) return { invalid: 'Cliente e servico sao obrigatorios.' };
    if (req.body.preferredDate && !isValidAppointmentDate(req.body.preferredDate)) return { invalid: 'Data preferida invalida.' };
    if (req.authUser.role === 'barber') return { forbidden: true };

    const item = {
      id: id('wait'),
      tenantId: tenantIdOf(req.authUser),
      clientId: client.id,
      serviceId: service.id,
      barberId: barber?.id || null,
      preferredDate: req.body.preferredDate || null,
      period: cleanText(req.body.period, 80) || 'Qualquer horario',
      status: 'waiting',
      createdAt: isoNow()
    };
    data.waitlist.unshift(item);
    audit(data, req.authUser, 'waitlist_created', 'waitlist', item.id, item.period, req);
    return { item };
  }, persistWaitlistMutation);

  if (result.forbidden) return sendError(res, 403, 'Barbeiros nao podem criar fila de espera para clientes.');
  if (result.invalid) return sendError(res, 400, result.invalid);
  res.status(201).json(result);
}));

app.patch('/api/waitlist/:id', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const tenantData = scopedDataForUser(data, req.authUser);
    const item = data.waitlist.find((entry) => entry.id === req.params.id && sameTenant(req.authUser, entry));
    if (!item) return { notFound: true };
    const client = findClientForUser(req.authUser, tenantData);
    const canManage = ADMIN_ROLES.includes(req.authUser.role);
    if (!canManage && item.clientId !== client?.id) return { forbidden: true };
    if (req.body.preferredDate !== undefined) {
      if (req.body.preferredDate && !isValidAppointmentDate(req.body.preferredDate)) return { invalid: true };
      item.preferredDate = req.body.preferredDate || null;
    }
    if (req.body.period !== undefined) item.period = cleanText(req.body.period, 80) || item.period;
    if (canManage && req.body.barberId !== undefined) {
      item.barberId = tenantData.barbers.some((barber) => barber.id === req.body.barberId) ? req.body.barberId : null;
    }
    if (canManage && req.body.status !== undefined) {
      if (!['waiting', 'notified', 'converted', 'expired', 'cancelled'].includes(req.body.status)) return { invalid: true };
      item.status = req.body.status;
      if (req.body.status === 'expired') item.expiredAt = isoNow();
    }
    item.updatedAt = isoNow();
    audit(data, req.authUser, 'waitlist_updated', 'waitlist', item.id, item.status, req);
    return { item };
  }, persistWaitlistMutation);

  if (result.notFound) return sendError(res, 404, 'Item da fila nao encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Voce nao pode alterar este item da fila.');
  if (result.invalid) return sendError(res, 400, 'Dados da fila invalidos.');
  res.json(result);
}));

app.delete('/api/waitlist/:id', authenticate, asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    const index = data.waitlist.findIndex((entry) => entry.id === req.params.id && sameTenant(req.authUser, entry));
    if (index === -1) return { notFound: true };
    const item = data.waitlist[index];
    const client = findClientForUser(req.authUser, scopedDataForUser(data, req.authUser));
    if (!ADMIN_ROLES.includes(req.authUser.role) && item.clientId !== client?.id) return { forbidden: true };
    data.waitlist.splice(index, 1);
    audit(data, req.authUser, 'waitlist_deleted', 'waitlist', item.id, item.status, req);
    return { item, deleted: true };
  }, persistWaitlistMutation);

  if (result.notFound) return sendError(res, 404, 'Item da fila nao encontrado.');
  if (result.forbidden) return sendError(res, 403, 'Voce nao pode remover este item da fila.');
  res.json(result);
}));

app.get('/api/reports/summary', heavyReadLimiter, authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  res.json({ reports: scopedReportsForUser(req.authUser, data) });
}));

app.get('/api/reports/export', heavyReadLimiter, authenticate, requireRoles('admin', 'owner', 'attendant'), asyncRoute(async (req, res) => {
  const data = scopedDataForUser(await readOperationalData(), req.authUser);
  const reports = reportCache.getOrSet(`reports:tenant:${tenantIdOf(req.authUser)}:admin`, () => calculateReports(data));
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
}));

app.get('/api/backup', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  const result = await mutateDataWithMysqlOperation((data) => {
    audit(data, req.authUser, 'backup_downloaded', 'system', 'backup', 'Backup exportado.', req);
    return { data: sanitizeBackupData(scopedDataForUser(data, req.authUser)) };
  }, persistAuditOnlyMutation);
  res.setHeader('Content-Disposition', `attachment; filename="barberpro-backup-${dateKey()}.json"`);
  res.json(result.data);
}));

app.post('/api/demo/reset', authenticate, requireRoles('admin', 'owner'), asyncRoute(async (req, res) => {
  if (IS_PRODUCTION || process.env.DEMO_RESET_ENABLED !== 'true') {
    return sendError(res, 403, 'Reset da demonstracao esta desabilitado neste ambiente.');
  }

  const expectedResetKey = process.env.DEMO_RESET_KEY || '';
  if (!expectedResetKey || req.get('x-demo-reset-key') !== expectedResetKey) {
    return sendError(res, 403, 'Header X-Demo-Reset-Key invalido ou ausente.');
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
  const result = await mutateDataWithMysqlOperation((data) => {
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
  }, persistSettingsMutation);
  if (result.invalid) return sendError(res, 400, 'Configuracoes invalidas.');
  res.json(result);
}));

app.use((error, req, res, next) => {
  if (error instanceof PersistenceUnavailableError || error.code === 'PERSISTENCE_UNAVAILABLE') {
    return sendPersistenceError(res, error);
  }
  logger.error({
    requestId: req.id,
    userId: req.authUser?.id || null,
    method: req.method,
    route: req.originalUrl,
    error: error.message,
    stack: error.stack
  }, 'route_failed');
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
      logger.info({ totalUpdated: reconciliation.summary.totalUpdated }, 'operational_reconciliation_completed');
    }
  }
  startAutomaticBackups({
    readData: readOperationalData,
    getStoreInfo,
    mutateData: (mutator) => mutateDataWithMysqlOperation(mutator, persistAuditOnlyMutation),
    logger
  });
  app.listen(PORT, () => {
    const target = storeInfo.mode === 'mysql'
      ? `MySQL ${storeInfo.database} em ${storeInfo.host}:${storeInfo.port}`
      : `JSON local em ${storeInfo.file}`;
    logger.info({ port: PORT, target, storeInfo }, 'barberpro_api_started');
    if (!storeInfo.writable) logger.warn({ storeInfo }, 'persistence_not_writable');
  });
}

if (require.main === module) {
  registerProcessAlertHandlers({ logger });
  startServer().catch((error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'barberpro_start_failed');
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  validateSchedule,
  calculateReports,
  reconcileOperationalData,
  overlaps,
  sanitizeUser
};
