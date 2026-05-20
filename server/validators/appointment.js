const { overlaps, endTime, toMinutes, businessWindow } = require('../services/scheduler');

const BLOCKING_STATUSES = ['scheduled', 'confirmed', 'in_service'];

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function todayKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function validateAppointmentDate(value, options = {}) {
  const maxDaysAhead = Number(options.maxDaysAhead || 365);
  if (!isValidDate(value)) return false;
  if (!options.allowPast && value < todayKey()) return false;
  return value <= todayKey(maxDaysAhead);
}

function validateSchedule(data, draft, options = {}) {
  const service = data.services.find((item) => item.id === draft.serviceId && item.active);
  const barber = data.barbers.find((item) => item.id === draft.barberId && item.status === 'active');
  const client = data.clients.find((item) => item.id === draft.clientId);
  const unit = data.units.find((item) => item.id === draft.unitId && item.status === 'active');

  if (!service) return { ok: false, message: 'Servico nao encontrado ou inativo.' };
  if (!barber) return { ok: false, message: 'Barbeiro nao encontrado ou inativo.' };
  if (!client) return { ok: false, message: 'Cliente nao encontrado.' };
  if (!unit) return { ok: false, message: 'Unidade nao encontrada ou inativa.' };
  if (!validateAppointmentDate(draft.date, options)) return { ok: false, message: 'Data de agendamento invalida.' };
  if (!isValidTime(draft.startTime)) return { ok: false, message: 'Horario inicial invalido.' };
  if (!service.barberIds.includes(barber.id)) return { ok: false, message: 'O barbeiro selecionado nao realiza este servico.' };
  if (Array.isArray(barber.unitIds) && barber.unitIds.length > 0 && !barber.unitIds.includes(unit.id)) {
    return { ok: false, message: 'O barbeiro selecionado nao atende nesta unidade.' };
  }

  const startTime = draft.startTime;
  const finishTime = draft.endTime || endTime(startTime, service.durationMinutes);
  if (!isValidTime(finishTime)) return { ok: false, message: 'Horario final invalido para a duracao do servico.' };
  if (toMinutes(startTime) >= toMinutes(finishTime)) return { ok: false, message: 'Horario final deve ser maior que o inicial.' };

  const window = businessWindow(data, draft.date);
  if (window.closed && !options.allowFitIn) return { ok: false, message: `A barbearia esta fechada nesta data: ${window.reason}.` };
  if (!window.closed && !options.allowFitIn) {
    if (toMinutes(startTime) < toMinutes(window.open) || toMinutes(finishTime) > toMinutes(window.close)) {
      return { ok: false, message: `Horario fora do funcionamento (${window.open} as ${window.close}).` };
    }
  }

  const blocked = (barber.blocks || []).find(
    (block) => block.date === draft.date && overlaps(startTime, finishTime, block.startTime, block.endTime)
  );
  if (blocked && !options.allowFitIn) return { ok: false, message: `Barbeiro indisponivel: ${blocked.reason}.` };

  const conflict = data.appointments.find(
    (appointment) =>
      appointment.id !== options.ignoreAppointmentId &&
      appointment.barberId === barber.id &&
      appointment.date === draft.date &&
      BLOCKING_STATUSES.includes(appointment.status) &&
      overlaps(startTime, finishTime, appointment.startTime, appointment.endTime)
  );
  if (conflict && !options.allowFitIn) return { ok: false, message: 'Este horario ja esta ocupado.', conflict };

  return {
    ok: true,
    service,
    barber,
    client,
    unit,
    endTime: finishTime,
    conflict: conflict || null
  };
}

module.exports = {
  validateSchedule,
  validateAppointmentDate,
  isValidDate,
  isValidTime
};
