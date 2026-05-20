import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useDashboard } from '../hooks/useDashboard';
import { apiRequest } from '../services/api';

const adminRoles = ['admin', 'owner', 'attendant'];

function todayKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function BookingPage() {
  const { token, user } = useAuth();
  const { data, refreshDashboard, setToast } = useDashboard();
  const [availability, setAvailability] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [form, setForm] = useState(() => ({
    clientId: user?.role === 'client' ? user.clientId : data?.clients?.[0]?.id || '',
    serviceId: data?.services?.find((service) => service.active)?.id || '',
    barberId: data?.barbers?.[0]?.id || '',
    date: todayKey(1),
    startTime: '',
    allowFitIn: false,
    notes: ''
  }));

  const selectedService = useMemo(
    () => data?.services?.find((service) => service.id === form.serviceId),
    [data?.services, form.serviceId]
  );
  const allowedBarbers = useMemo(
    () => (data?.barbers || []).filter((barber) => selectedService?.barberIds.includes(barber.id)),
    [data?.barbers, selectedService]
  );

  useEffect(() => {
    const firstAllowed = allowedBarbers[0];
    if (firstAllowed && !selectedService?.barberIds.includes(form.barberId)) {
      setForm((current) => ({ ...current, barberId: firstAllowed.id, startTime: '' }));
    }
  }, [allowedBarbers, selectedService, form.barberId]);

  useEffect(() => {
    async function loadAvailability() {
      if (!form.serviceId || !form.date) return;
      setLoadingSlots(true);
      try {
        const params = new URLSearchParams({
          serviceId: form.serviceId,
          barberId: form.barberId,
          date: form.date
        });
        const payload = await apiRequest(`/api/availability?${params.toString()}`);
        setAvailability(payload.availability || []);
      } finally {
        setLoadingSlots(false);
      }
    }

    loadAvailability();
  }, [form.serviceId, form.barberId, form.date]);

  async function submitBooking(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/appointments', {
        method: 'POST',
        token,
        body: form
      });
      setToast({ type: 'success', message: 'Agendamento criado com confirmacao automatica.' });
      setForm((current) => ({ ...current, startTime: '', notes: '' }));
      await refreshDashboard(token);
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  if (!data || !user) return null;

  return (
    <form className="stack-form" onSubmit={submitBooking}>
      {adminRoles.includes(user.role) && (
        <select value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })}>
          {data.clients.map((client) => (
            <option key={client.id} value={client.id}>{client.name}</option>
          ))}
        </select>
      )}
      <select value={form.serviceId} onChange={(event) => setForm({ ...form, serviceId: event.target.value, startTime: '' })}>
        {data.services.filter((service) => service.active).map((service) => (
          <option key={service.id} value={service.id}>{service.name}</option>
        ))}
      </select>
      <select value={form.barberId} onChange={(event) => setForm({ ...form, barberId: event.target.value, startTime: '' })}>
        {allowedBarbers.map((barber) => (
          <option key={barber.id} value={barber.id}>{barber.name}</option>
        ))}
      </select>
      <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value, startTime: '' })} />
      <textarea value={form.notes} maxLength={500} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      <div className="slot-grid" aria-busy={loadingSlots}>
        {availability.map((group) => group.slots.map((slot) => (
          <button
            type="button"
            key={`${group.barberId}-${slot.startTime}`}
            className={`slot ${form.startTime === slot.startTime && form.barberId === group.barberId ? 'selected' : ''}`}
            disabled={!slot.available}
            onClick={() => setForm({ ...form, barberId: group.barberId, startTime: slot.startTime })}
          >
            {slot.startTime}
          </button>
        )))}
      </div>
      <button className="primary-button full" disabled={!form.startTime}>
        <CalendarPlus size={18} />
        Confirmar agendamento
      </button>
    </form>
  );
}
