const express = require('express');
const { validateSchedule } = require('../validators/appointment');

const ADMIN_ROLES = ['admin', 'owner', 'attendant'];
const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show'];

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function createAppointmentsRouter(deps) {
  const {
    authenticate,
    requireRoles,
    mutateData,
    id,
    isoNow,
    audit,
    appointmentView,
    canSeeAppointment,
    findClientForUser,
    endTime,
    reportCache,
    sendError
  } = deps;

  const router = express.Router();

  router.get('/', authenticate, (req, res) => {
    const data = deps.readData();
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

  router.post('/', authenticate, async (req, res, next) => {
    try {
      const body = req.body || {};
      const result = await mutateData((data) => {
        const user = req.authUser;
        if (user.role === 'barber') return { forbidden: true };
        if (String(body.notes || '').length > 500 || String(body.internalNotes || '').length > 500) {
          return { invalid: 'Observacoes devem ter no maximo 500 caracteres.' };
        }

        const client = user.role === 'client'
          ? findClientForUser(user, data)
          : data.clients.find((item) => item.id === body.clientId);
        const allowFitIn = Boolean(body.allowFitIn && ADMIN_ROLES.includes(user.role));
        const service = data.services.find((item) => item.id === body.serviceId);
        const status = ADMIN_ROLES.includes(user.role) && APPOINTMENT_STATUSES.includes(body.status)
          ? body.status
          : 'scheduled';
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
          notes: cleanText(body.notes, 500),
          internalNotes: ADMIN_ROLES.includes(user.role) ? cleanText(body.internalNotes, 500) : '',
          isFitIn: Boolean(validation.conflict && allowFitIn),
          createdAt: isoNow(),
          updatedAt: isoNow()
        };

        data.appointments.push(appointment);
        reportCache?.invalidate('appointment_created');
        audit(data, user, 'appointment_created', 'appointment', appointment.id, 'Agendamento criado.', req);
        return { appointment: appointmentView(appointment, data, user) };
      });

      if (result.forbidden) return sendError(res, 403, 'Barbeiros nao podem criar agendamentos para outros clientes.');
      if (result.invalid) return sendError(res, 400, result.invalid);
      if (result.error) return sendError(res, result.error.conflict ? 409 : 400, result.error.message, result.error.conflict);
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/status', authenticate, requireRoles('admin', 'owner', 'attendant', 'barber'), async (req, res, next) => {
    try {
      const { status } = req.body || {};
      if (!APPOINTMENT_STATUSES.includes(status)) return sendError(res, 400, 'Status invalido.');
      const result = await mutateData((data) => {
        const appointment = data.appointments.find((item) => item.id === req.params.id);
        if (!appointment) return { notFound: true };
        if (req.authUser.role === 'barber' && appointment.barberId !== req.authUser.barberId) return { forbidden: true };
        appointment.status = status;
        appointment.updatedAt = isoNow();
        reportCache?.invalidate('appointment_status_changed');
        audit(data, req.authUser, 'appointment_status_changed', 'appointment', appointment.id, `Status alterado para ${status}.`, req);
        return { appointment: appointmentView(appointment, data, req.authUser) };
      });

      if (result.notFound) return sendError(res, 404, 'Agendamento nao encontrado.');
      if (result.forbidden) return sendError(res, 403, 'Este agendamento pertence a outro barbeiro.');
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createAppointmentsRouter
};
