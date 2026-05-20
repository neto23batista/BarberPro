require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { persistSnapshot } = require('../server/adapters/mysqlSnapshot');

const root = path.resolve(__dirname, '..');
const dataFile = path.resolve(root, process.env.DATA_FILE || path.join('data', 'barberpro.json'));
const schemaFile = path.resolve(root, 'database', 'schema.mysql.sql');
const migrationsDir = path.resolve(root, 'database', 'migrations');

function dbName() {
  const name = process.env.DB_NAME || 'barberpro';
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('DB_NAME invalido.');
  return name;
}

function mysqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function mysqlDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function tenantIdOf(item, data) {
  return item?.tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
}

async function executeMany(connection, sql, rows) {
  for (const row of rows) {
    await connection.execute(sql, row);
  }
}

async function executeSqlMigrations(connection) {
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await connection.query(sql);
  }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const schema = fs.readFileSync(schemaFile, 'utf8').replace(/CREATE DATABASE IF NOT EXISTS barberpro/g, `CREATE DATABASE IF NOT EXISTS \`${dbName()}\``).replace(/USE barberpro/g, `USE \`${dbName()}\``);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  await connection.query(schema);
  await connection.changeUser({ database: dbName() });
  await executeSqlMigrations(connection);
  await connection.beginTransaction();

  let committed = false;
  try {
    await executeMany(
      connection,
      `INSERT INTO tenants (id, name, slug, status, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), slug = VALUES(slug), status = VALUES(status)`,
      (data.tenants && data.tenants.length ? data.tenants : [{
        id: tenantIdOf(null, data),
        name: process.env.DEFAULT_TENANT_NAME || 'BarberPro',
        slug: process.env.DEFAULT_TENANT_SLUG || 'barberpro',
        status: 'active',
        createdAt: data.meta?.generatedAt
      }]).map((tenant) => [
        tenant.id,
        tenant.name,
        tenant.slug || tenant.id,
        tenant.status || 'active',
        mysqlDateTime(tenant.createdAt)
      ])
    );

    await executeMany(
      connection,
      `INSERT INTO units (id, tenant_id, name, phone, whatsapp, email, address, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), whatsapp = VALUES(whatsapp), email = VALUES(email), address = VALUES(address), status = VALUES(status)`,
      (data.units || []).map((unit) => [unit.id, tenantIdOf(unit, data), unit.name, unit.phone || null, unit.whatsapp || null, unit.email || null, unit.address || null, unit.status || 'active'])
    );

    await executeMany(
      connection,
      `INSERT INTO users (id, tenant_id, role, name, email, phone, password_hash, status, avatar_url, birth_date, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), name = VALUES(name), phone = VALUES(phone), status = VALUES(status), avatar_url = VALUES(avatar_url), birth_date = VALUES(birth_date), last_login_at = VALUES(last_login_at)`,
      (data.users || []).map((user) => [
        user.id,
        tenantIdOf(user, data),
        user.role,
        user.name,
        String(user.email || '').toLowerCase(),
        user.phone || null,
        user.passwordHash || user.password_hash,
        user.status || 'active',
        user.avatar || null,
        mysqlDate(user.birthDate),
        mysqlDateTime(user.lastLoginAt),
        mysqlDateTime(user.createdAt)
      ])
    );

    await executeMany(
      connection,
      `INSERT INTO barbers (id, tenant_id, user_id, name, phone, email, bio, commission_rate, rating, goal_monthly, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), name = VALUES(name), phone = VALUES(phone), email = VALUES(email), bio = VALUES(bio), commission_rate = VALUES(commission_rate), rating = VALUES(rating), goal_monthly = VALUES(goal_monthly), status = VALUES(status)`,
      (data.barbers || []).map((barber) => [barber.id, tenantIdOf(barber, data), barber.userId || null, barber.name, barber.phone || null, barber.email || null, barber.bio || null, barber.commissionRate || 0.4, barber.rating || 5, barber.goalMonthly || 0, barber.status || 'active'])
    );

    await executeMany(
      connection,
      'INSERT IGNORE INTO barber_specialties (barber_id, specialty) VALUES (?, ?)',
      (data.barbers || []).flatMap((barber) => (barber.specialties || []).map((specialty) => [barber.id, specialty]))
    );
    await executeMany(
      connection,
      'INSERT IGNORE INTO barber_units (barber_id, unit_id) VALUES (?, ?)',
      (data.barbers || []).flatMap((barber) => (barber.unitIds || []).map((unitId) => [barber.id, unitId]))
    );

    await executeMany(
      connection,
      `INSERT INTO clients (id, tenant_id, user_id, preferred_barber_id, name, phone, email, birth_date, loyalty_points, visits, no_shows, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), preferred_barber_id = VALUES(preferred_barber_id), name = VALUES(name), phone = VALUES(phone), email = VALUES(email), birth_date = VALUES(birth_date), loyalty_points = VALUES(loyalty_points), visits = VALUES(visits), no_shows = VALUES(no_shows), notes = VALUES(notes)`,
      (data.clients || []).map((client) => [client.id, tenantIdOf(client, data), client.userId || null, client.preferredBarberId || null, client.name, client.phone, client.email || null, mysqlDate(client.birthDate), client.loyaltyPoints || 0, client.visits || 0, client.noShows || 0, client.notes || null, mysqlDateTime(client.createdAt)])
    );
    await executeMany(
      connection,
      'INSERT IGNORE INTO client_tags (client_id, tag) VALUES (?, ?)',
      (data.clients || []).flatMap((client) => (client.tags || []).map((tag) => [client.id, tag]))
    );

    await executeMany(
      connection,
      `INSERT INTO services (id, tenant_id, name, description, price, duration_minutes, icon, color, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), price = VALUES(price), duration_minutes = VALUES(duration_minutes), icon = VALUES(icon), color = VALUES(color), active = VALUES(active)`,
      (data.services || []).map((service) => [service.id, tenantIdOf(service, data), service.name, service.description || null, service.price || 0, service.durationMinutes || 30, service.icon || null, service.color || null, service.active !== false])
    );
    await executeMany(
      connection,
      'INSERT IGNORE INTO service_barbers (service_id, barber_id) VALUES (?, ?)',
      (data.services || []).flatMap((service) => (service.barberIds || []).map((barberId) => [service.id, barberId]))
    );

    await executeMany(
      connection,
      `INSERT INTO barber_time_blocks (id, barber_id, block_date, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE block_date = VALUES(block_date), start_time = VALUES(start_time), end_time = VALUES(end_time), reason = VALUES(reason)`,
      (data.barbers || []).flatMap((barber) => (barber.blocks || []).map((block) => [block.id, barber.id, block.date, block.startTime, block.endTime, block.reason || null]))
    );

    await executeMany(
      connection,
      `INSERT INTO appointments (id, tenant_id, code, unit_id, client_id, barber_id, service_id, appointment_date, start_time, end_time, status, payment_status, payment_method, notes, internal_notes, cancellation_reason, is_fit_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE appointment_date = VALUES(appointment_date), start_time = VALUES(start_time), end_time = VALUES(end_time), status = VALUES(status), payment_status = VALUES(payment_status), payment_method = VALUES(payment_method), notes = VALUES(notes), internal_notes = VALUES(internal_notes), cancellation_reason = VALUES(cancellation_reason), is_fit_in = VALUES(is_fit_in)`,
      (data.appointments || []).map((appointment) => [
        appointment.id,
        tenantIdOf(appointment, data),
        appointment.code,
        appointment.unitId,
        appointment.clientId,
        appointment.barberId,
        appointment.serviceId,
        appointment.date,
        appointment.startTime,
        appointment.endTime,
        appointment.status || 'scheduled',
        appointment.paymentStatus || 'pending',
        appointment.paymentMethod || 'pix',
        appointment.notes || '',
        appointment.internalNotes || '',
        appointment.cancellationReason || null,
        Boolean(appointment.isFitIn),
        mysqlDateTime(appointment.createdAt)
      ])
    );

    await executeMany(
      connection,
      `INSERT INTO payments (id, tenant_id, appointment_id, client_id, barber_id, amount, method, status, gateway_reference, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = VALUES(amount), method = VALUES(method), status = VALUES(status), gateway_reference = VALUES(gateway_reference), paid_at = VALUES(paid_at)`,
      (data.payments || []).map((payment) => [payment.id, tenantIdOf(payment, data), payment.appointmentId, payment.clientId, payment.barberId, payment.amount || 0, payment.method || 'pix', payment.status || 'pending', payment.gatewayReference || null, mysqlDateTime(payment.paidAt), mysqlDateTime(payment.createdAt)])
    );

    await executeMany(
      connection,
      `INSERT INTO commissions (id, tenant_id, appointment_id, barber_id, amount, rate, status, commission_date, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = VALUES(amount), rate = VALUES(rate), status = VALUES(status), commission_date = VALUES(commission_date), paid_at = VALUES(paid_at)`,
      (data.commissions || []).map((commission) => [commission.id, tenantIdOf(commission, data), commission.appointmentId, commission.barberId, commission.amount || 0, commission.rate || 0, commission.status || 'pending', commission.date, mysqlDateTime(commission.paidAt)])
    );

    await executeMany(
      connection,
      `INSERT INTO reviews (id, tenant_id, appointment_id, client_id, barber_id, rating, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      (data.reviews || []).map((review) => [review.id, tenantIdOf(review, data), review.appointmentId, review.clientId, review.barberId, review.rating, review.comment || null, mysqlDateTime(review.createdAt)])
    );

    await executeMany(
      connection,
      `INSERT INTO products (id, tenant_id, name, category, sku, quantity, purchase_price, sale_price, min_stock, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), category = VALUES(category), sku = VALUES(sku), quantity = VALUES(quantity), purchase_price = VALUES(purchase_price), sale_price = VALUES(sale_price), min_stock = VALUES(min_stock), active = VALUES(active)`,
      (data.products || []).map((product) => [product.id, tenantIdOf(product, data), product.name, product.category || 'Geral', product.sku || null, product.quantity || 0, product.purchasePrice || 0, product.salePrice || 0, product.minStock || 0, product.active !== false])
    );

    await executeMany(
      connection,
      `INSERT INTO stock_movements (id, tenant_id, product_id, user_id, type, quantity, unit_value, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE type = VALUES(type), quantity = VALUES(quantity), unit_value = VALUES(unit_value), reason = VALUES(reason)`,
      (data.stockMovements || []).map((movement) => [movement.id, tenantIdOf(movement, data), movement.productId, movement.userId || null, movement.type, movement.quantity || 1, movement.unitValue || 0, movement.reason || null, mysqlDateTime(movement.createdAt)])
    );

    await executeMany(
      connection,
      `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE details = VALUES(details), ip = VALUES(ip)`,
      (data.auditLogs || []).map((log) => [log.id, tenantIdOf(log, data), log.userId === 'public' || log.userId === 'system' ? null : log.userId, log.action, log.entity, log.entityId || null, log.details || null, log.ip || null, mysqlDateTime(log.createdAt)])
    );

    await connection.commit();
    committed = true;

    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: dbName(),
      waitForConnections: true,
      connectionLimit: 1
    });
    try {
      await persistSnapshot(pool, data, 'barberpro');
    } finally {
      await pool.end();
    }

    console.log(`Migracao concluida: ${dataFile} -> MySQL ${dbName()}.`);
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Falha na migracao: ${error.stack || error.message}`);
  process.exit(1);
});
