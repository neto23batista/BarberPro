function toMinutes(time) {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return hours * 60 + minutes;
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

module.exports = {
  toMinutes,
  fromMinutes,
  overlaps,
  endTime,
  businessWindow
};
