const mysql = require('mysql2/promise');

function mysqlConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'barberpro',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10)
  };
}

function createPool(config = mysqlConfig()) {
  return mysql.createPool(config);
}

async function createAppointment(pool, appointment) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [services] = await connection.execute(
      'SELECT id, price, duration_minutes, active FROM services WHERE id = ? FOR UPDATE',
      [appointment.serviceId]
    );
    if (!services.length || !services[0].active) {
      await connection.rollback();
      return { ok: false, status: 400, error: 'Servico nao encontrado ou inativo.' };
    }

    const [barbers] = await connection.execute(
      'SELECT id, status FROM barbers WHERE id = ? FOR UPDATE',
      [appointment.barberId]
    );
    if (!barbers.length || barbers[0].status !== 'active') {
      await connection.rollback();
      return { ok: false, status: 400, error: 'Barbeiro nao encontrado ou inativo.' };
    }

    const [conflicts] = await connection.execute(
      `SELECT id, code, start_time, end_time
         FROM appointments
        WHERE barber_id = ?
          AND appointment_date = ?
          AND status IN ('scheduled', 'confirmed', 'in_service')
          AND start_time < ?
          AND end_time > ?
        FOR UPDATE`,
      [appointment.barberId, appointment.date, appointment.endTime, appointment.startTime]
    );
    if (conflicts.length > 0 && !appointment.allowFitIn) {
      await connection.rollback();
      return { ok: false, status: 409, error: 'Este horario ja esta ocupado.', conflict: conflicts[0] };
    }

    await connection.execute(
      `INSERT INTO appointments
        (id, code, unit_id, client_id, barber_id, service_id, appointment_date, start_time, end_time,
         status, notes, internal_notes, is_fit_in)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appointment.id,
        appointment.code,
        appointment.unitId,
        appointment.clientId,
        appointment.barberId,
        appointment.serviceId,
        appointment.date,
        appointment.startTime,
        appointment.endTime,
        appointment.status || 'scheduled',
        appointment.notes || '',
        appointment.internalNotes || '',
        Boolean(appointment.isFitIn)
      ]
    );

    await connection.commit();
    return { ok: true, appointment };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function listDaySchedule(pool, date, barberId = null) {
  const params = [date];
  let barberFilter = '';
  if (barberId) {
    barberFilter = 'AND a.barber_id = ?';
    params.push(barberId);
  }

  const [rows] = await pool.execute(
    `SELECT a.*, c.name AS client_name, b.name AS barber_name, s.name AS service_name, s.price
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN barbers b ON b.id = a.barber_id
       JOIN services s ON s.id = a.service_id
      WHERE a.appointment_date = ?
        ${barberFilter}
      ORDER BY a.start_time ASC`,
    params
  );
  return rows;
}

async function monthlyReport(pool, month) {
  const [rows] = await pool.execute(
    `SELECT
        COUNT(*) AS total_appointments,
        SUM(CASE WHEN a.status = 'finished' THEN 1 ELSE 0 END) AS finished_appointments,
        COALESCE(SUM(CASE WHEN a.status = 'finished' THEN s.price ELSE 0 END), 0) AS revenue,
        COALESCE(AVG(CASE WHEN a.status = 'finished' THEN s.price ELSE NULL END), 0) AS average_ticket,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancellations,
        SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_shows
       FROM appointments a
       JOIN services s ON s.id = a.service_id
      WHERE DATE_FORMAT(a.appointment_date, '%Y-%m') = ?`,
    [month]
  );
  return rows[0];
}

module.exports = {
  createPool,
  createAppointment,
  listDaySchedule,
  monthlyReport
};
