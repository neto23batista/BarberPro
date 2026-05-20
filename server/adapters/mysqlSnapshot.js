const fs = require('fs');
const path = require('path');

const schemaFile = path.resolve(__dirname, '..', '..', 'database', 'schema.mysql.sql');
const MYSQL_DUPLICATE_INDEX_CODES = new Set([
  'ER_DUP_KEYNAME',
  'ER_DUP_FIELDNAME',
  'ER_TABLE_EXISTS_ERROR',
  'ER_KEY_COLUMN_DOES_NOT_EXITS'
]);

let schemaReady = false;

function mysqlDate(value) {
  if (!value) return null;
  const normalized = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function mysqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function nowDateTime() {
  return mysqlDateTime(new Date());
}

function tenantIdOf(item, data) {
  return item?.tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function jsonValue(value) {
  return JSON.stringify(value ?? null);
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function schemaStatements() {
  if (!fs.existsSync(schemaFile)) {
    throw new Error(`Arquivo de schema MySQL nao encontrado: ${schemaFile}`);
  }

  return fs
    .readFileSync(schemaFile, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => !/^CREATE\s+DATABASE/i.test(statement))
    .filter((statement) => !/^USE\s+/i.test(statement));
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?`,
    [table, column]
  );
  if (Number(rows[0]?.total || 0) > 0) return;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}

async function ensureSchemaCompatibility(pool) {
  const tenantTables = [
    'units',
    'users',
    'barbers',
    'clients',
    'services',
    'appointments',
    'payments',
    'commissions',
    'reviews',
    'products',
    'stock_movements',
    'expenses',
    'promotions',
    'coupons',
    'waitlist',
    'notifications',
    'audit_logs'
  ];
  for (const table of tenantTables) {
    await ensureColumn(pool, table, 'tenant_id', "tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id");
  }
  await ensureColumn(pool, 'users', 'must_change_password', 'must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER password_hash');
  await ensureColumn(pool, 'users', 'password_reset_token_hash', 'password_reset_token_hash VARCHAR(128) NULL AFTER must_change_password');
  await ensureColumn(pool, 'users', 'password_reset_expires_at', 'password_reset_expires_at DATETIME NULL AFTER password_reset_token_hash');
  await ensureColumn(pool, 'users', 'password_changed_at', 'password_changed_at DATETIME NULL AFTER password_reset_expires_at');
  await ensureColumn(pool, 'barbers', 'archived_at', 'archived_at DATETIME NULL AFTER status');
  await ensureColumn(pool, 'clients', 'status', "status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active' AFTER notes");
  await ensureColumn(pool, 'clients', 'archived_at', 'archived_at DATETIME NULL AFTER status');
  await ensureColumn(pool, 'services', 'archived_at', 'archived_at DATETIME NULL AFTER active');
  await ensureColumn(pool, 'products', 'archived_at', 'archived_at DATETIME NULL AFTER active');
  await ensureColumn(pool, 'promotions', 'archived_at', 'archived_at DATETIME NULL AFTER active');
}

async function applyRelationalSchema(pool) {
  if (schemaReady) return;
  const statements = schemaStatements();

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (!MYSQL_DUPLICATE_INDEX_CODES.has(error.code)) throw error;
    }
  }

  await ensureSchemaCompatibility(pool);
  for (const statement of statements.filter((item) => /^CREATE\s+INDEX/i.test(item))) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (!MYSQL_DUPLICATE_INDEX_CODES.has(error.code)) throw error;
    }
  }
  schemaReady = true;
}

async function executeMany(connection, sql, rows) {
  for (const row of rows) {
    await connection.execute(sql, row);
  }
}

function defaultTenant(data) {
  const id = data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
  return {
    id,
    name: process.env.DEFAULT_TENANT_NAME || 'BarberPro',
    slug: process.env.DEFAULT_TENANT_SLUG || 'barberpro',
    status: 'active',
    createdAt: data?.meta?.generatedAt
  };
}

function buildRelationalRows(data = {}) {
  const tenants = Array.isArray(data.tenants) && data.tenants.length ? data.tenants : [defaultTenant(data)];
  const tenantIds = new Set(tenants.map((tenant) => tenant.id));
  const unitIds = new Set((data.units || []).map((unit) => unit.id));
  const userIds = new Set((data.users || []).map((user) => user.id));
  const barberIds = new Set((data.barbers || []).map((barber) => barber.id));
  const clientIds = new Set((data.clients || []).map((client) => client.id));
  const serviceIds = new Set((data.services || []).map((service) => service.id));
  const appointmentIds = new Set((data.appointments || []).map((appointment) => appointment.id));
  const productIds = new Set((data.products || []).map((product) => product.id));
  const promotionIds = new Set((data.promotions || []).map((promotion) => promotion.id));
  const userIdByClientId = new Map(
    (data.users || [])
      .filter((user) => user.id && user.clientId)
      .map((user) => [user.clientId, user.id])
  );
  const userIdByBarberId = new Map(
    (data.users || [])
      .filter((user) => user.id && user.barberId)
      .map((user) => [user.barberId, user.id])
  );
  const timestamp = nowDateTime();

  return {
    tenants: tenants.map((tenant) => [
      tenant.id,
      textValue(tenant.name, tenant.id),
      textValue(tenant.slug, tenant.id),
      enumValue(tenant.status, ['active', 'inactive', 'blocked'], 'active'),
      mysqlDateTime(tenant.createdAt) || timestamp
    ]),
    units: (data.units || [])
      .filter((unit) => unit.id)
      .map((unit) => [
        unit.id,
        tenantIdOf(unit, data),
        textValue(unit.name, unit.id),
        unit.phone || null,
        unit.whatsapp || null,
        unit.email || null,
        unit.address || null,
        enumValue(unit.status, ['active', 'inactive', 'blocked'], 'active')
      ]),
    users: (data.users || [])
      .filter((user) => user.id && user.email && user.passwordHash)
      .map((user) => [
        user.id,
        tenantIdOf(user, data),
        user.unitId && unitIds.has(user.unitId) ? user.unitId : null,
        enumValue(user.role, ['admin', 'owner', 'barber', 'attendant', 'client'], 'client'),
        textValue(user.name, user.email),
        String(user.email).trim().toLowerCase(),
        user.phone || null,
        user.passwordHash,
        boolValue(user.mustChangePassword, false),
        user.passwordResetTokenHash || null,
        mysqlDateTime(user.passwordResetExpiresAt),
        mysqlDateTime(user.passwordChangedAt),
        enumValue(user.status, ['active', 'inactive', 'blocked'], 'active'),
        user.avatar || user.avatarUrl || null,
        mysqlDate(user.birthDate),
        mysqlDateTime(user.lastLoginAt),
        mysqlDateTime(user.createdAt) || timestamp
      ]),
    barbers: (data.barbers || [])
      .filter((barber) => barber.id)
      .map((barber) => [
        barber.id,
        tenantIdOf(barber, data),
        barber.userId && userIds.has(barber.userId) ? barber.userId : userIdByBarberId.get(barber.id) || null,
        textValue(barber.name, barber.id),
        barber.phone || null,
        barber.email || null,
        barber.bio || null,
        numberValue(barber.commissionRate, 0.4),
        numberValue(barber.rating, 5),
        numberValue(barber.goalMonthly, 0),
        enumValue(barber.status, ['active', 'inactive', 'blocked'], 'active'),
        mysqlDateTime(barber.archivedAt)
      ]),
    barberSpecialties: (data.barbers || []).flatMap((barber) =>
      (barber.specialties || [])
        .filter((specialty) => barberIds.has(barber.id) && specialty)
        .map((specialty) => [barber.id, String(specialty).slice(0, 80)])
    ),
    barberUnits: (data.barbers || []).flatMap((barber) =>
      (barber.unitIds || [])
        .filter((unitId) => barberIds.has(barber.id) && unitIds.has(unitId))
        .map((unitId) => [barber.id, unitId])
    ),
    clients: (data.clients || [])
      .filter((client) => client.id)
      .map((client) => [
        client.id,
        tenantIdOf(client, data),
        client.userId && userIds.has(client.userId) ? client.userId : userIdByClientId.get(client.id) || null,
        client.preferredBarberId && barberIds.has(client.preferredBarberId) ? client.preferredBarberId : null,
        textValue(client.name, client.id),
        textValue(client.phone, ''),
        client.email || null,
        mysqlDate(client.birthDate),
        intValue(client.loyaltyPoints, 0),
        intValue(client.visits, 0),
        intValue(client.noShows, 0),
        client.notes || null,
        enumValue(client.status, ['active', 'inactive', 'blocked'], 'active'),
        mysqlDateTime(client.archivedAt),
        mysqlDateTime(client.createdAt) || timestamp
      ]),
    clientTags: (data.clients || []).flatMap((client) =>
      (client.tags || [])
        .filter((tag) => clientIds.has(client.id) && tag)
        .map((tag) => [client.id, String(tag).slice(0, 40)])
    ),
    services: (data.services || [])
      .filter((service) => service.id)
      .map((service) => [
        service.id,
        tenantIdOf(service, data),
        textValue(service.name, service.id),
        service.description || null,
        numberValue(service.price, 0),
        intValue(service.durationMinutes, 30),
        service.icon || null,
        service.color || null,
        service.active !== false,
        mysqlDateTime(service.archivedAt)
      ]),
    serviceBarbers: (data.services || []).flatMap((service) =>
      (service.barberIds || [])
        .filter((barberId) => serviceIds.has(service.id) && barberIds.has(barberId))
        .map((barberId) => [service.id, barberId])
    ),
    barberBlocks: (data.barbers || []).flatMap((barber) =>
      (barber.blocks || [])
        .filter((block) => barberIds.has(barber.id) && block.id && mysqlDate(block.date))
        .map((block) => [
          block.id,
          barber.id,
          block.createdBy && userIds.has(block.createdBy) ? block.createdBy : null,
          mysqlDate(block.date),
          block.startTime,
          block.endTime,
          block.reason || null
        ])
    ),
    appointments: (data.appointments || [])
      .filter((appointment) =>
        appointment.id &&
        clientIds.has(appointment.clientId) &&
        barberIds.has(appointment.barberId) &&
        serviceIds.has(appointment.serviceId)
      )
      .map((appointment) => [
        appointment.id,
        tenantIdOf(appointment, data),
        textValue(appointment.code, appointment.id).slice(0, 32),
        appointment.unitId && unitIds.has(appointment.unitId) ? appointment.unitId : [...unitIds][0],
        appointment.clientId,
        appointment.barberId,
        appointment.serviceId,
        mysqlDate(appointment.date),
        appointment.startTime,
        appointment.endTime,
        enumValue(appointment.status, ['scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show'], 'scheduled'),
        appointment.notes || '',
        appointment.internalNotes || '',
        appointment.cancellationReason || null,
        boolValue(appointment.isFitIn, false),
        mysqlDateTime(appointment.createdAt) || timestamp
      ]),
    payments: [],
    commissions: (data.commissions || [])
      .filter((commission) => commission.id && appointmentIds.has(commission.appointmentId) && barberIds.has(commission.barberId))
      .map((commission) => [
        commission.id,
        tenantIdOf(commission, data),
        commission.appointmentId,
        commission.barberId,
        numberValue(commission.amount, 0),
        numberValue(commission.rate, 0),
        enumValue(commission.status, ['pending', 'available', 'paid', 'cancelled'], 'pending'),
        mysqlDate(commission.date) || mysqlDate(new Date()),
        mysqlDateTime(commission.paidAt)
      ]),
    reviews: (data.reviews || [])
      .filter((review) => review.id && appointmentIds.has(review.appointmentId) && clientIds.has(review.clientId) && barberIds.has(review.barberId))
      .map((review) => [
        review.id,
        tenantIdOf(review, data),
        review.appointmentId,
        review.clientId,
        review.barberId,
        Math.min(5, Math.max(1, intValue(review.rating, 5))),
        review.comment || null,
        mysqlDateTime(review.createdAt) || timestamp
      ]),
    products: (data.products || [])
      .filter((product) => product.id)
      .map((product) => [
        product.id,
        tenantIdOf(product, data),
        product.unitId && unitIds.has(product.unitId) ? product.unitId : null,
        textValue(product.name, product.id),
        textValue(product.category, 'Geral'),
        product.sku || null,
        intValue(product.quantity, 0),
        numberValue(product.purchasePrice, 0),
        numberValue(product.salePrice, 0),
        intValue(product.minStock, 1),
        product.active !== false,
        mysqlDateTime(product.archivedAt)
      ]),
    stockMovements: (data.stockMovements || [])
      .filter((movement) => movement.id && productIds.has(movement.productId))
      .map((movement) => [
        movement.id,
        tenantIdOf(movement, data),
        movement.productId,
        movement.userId && userIds.has(movement.userId) ? movement.userId : null,
        enumValue(movement.type, ['purchase', 'sale', 'usage', 'loss', 'adjustment'], 'adjustment'),
        Math.max(0, intValue(movement.quantity, 0)),
        numberValue(movement.unitValue, 0),
        movement.reason || null,
        mysqlDateTime(movement.createdAt) || timestamp
      ]),
    expenses: (data.expenses || [])
      .filter((expense) => expense.id)
      .map((expense) => [
        expense.id,
        tenantIdOf(expense, data),
        textValue(expense.category, 'Geral'),
        textValue(expense.description, expense.category || expense.id),
        numberValue(expense.amount, 0),
        mysqlDate(expense.dueDate),
        enumValue(expense.status, ['pending', 'paid', 'overdue', 'cancelled'], 'pending'),
        mysqlDateTime(expense.paidAt),
        mysqlDateTime(expense.createdAt) || timestamp
      ]),
    promotions: (data.promotions || [])
      .filter((promotion) => promotion.id)
      .map((promotion) => [
        promotion.id,
        tenantIdOf(promotion, data),
        textValue(promotion.title, promotion.id),
        promotion.description || null,
        textValue(promotion.code, promotion.id).toUpperCase(),
        enumValue(promotion.discountType, ['percent', 'fixed'], 'fixed'),
        numberValue(promotion.discountValue, 0),
        mysqlDate(promotion.startsAt),
        mysqlDate(promotion.endsAt),
        textValue(promotion.audience, 'all'),
        promotion.active !== false,
        mysqlDateTime(promotion.archivedAt)
      ]),
    coupons: (data.coupons || [])
      .filter((coupon) => coupon.id)
      .map((coupon) => [
        coupon.id,
        tenantIdOf(coupon, data),
        coupon.promotionId && promotionIds.has(coupon.promotionId) ? coupon.promotionId : null,
        coupon.clientId && clientIds.has(coupon.clientId) ? coupon.clientId : null,
        textValue(coupon.code, coupon.id).toUpperCase(),
        enumValue(coupon.discountType, ['percent', 'fixed'], 'fixed'),
        numberValue(coupon.discountValue, 0),
        mysqlDate(coupon.expiresAt),
        mysqlDateTime(coupon.usedAt),
        enumValue(coupon.status, ['active', 'used', 'expired', 'cancelled'], 'active')
      ]),
    waitlist: (data.waitlist || [])
      .filter((item) => item.id)
      .map((item) => [
        item.id,
        tenantIdOf(item, data),
        item.clientId && clientIds.has(item.clientId) ? item.clientId : null,
        item.serviceId && serviceIds.has(item.serviceId) ? item.serviceId : null,
        item.barberId && barberIds.has(item.barberId) ? item.barberId : null,
        mysqlDate(item.preferredDate),
        item.period || null,
        enumValue(item.status, ['waiting', 'notified', 'converted', 'expired', 'cancelled'], 'waiting'),
        mysqlDateTime(item.expiredAt),
        mysqlDateTime(item.createdAt) || timestamp
      ]),
    notifications: (data.notifications || [])
      .filter((notification) => notification.id)
      .map((notification) => [
        notification.id,
        tenantIdOf(notification, data),
        notification.userId && userIds.has(notification.userId) ? notification.userId : null,
        enumValue(notification.channel, ['system', 'email', 'whatsapp', 'sms'], 'system'),
        textValue(notification.title, notification.id),
        textValue(notification.message, ''),
        enumValue(notification.status, ['queued', 'scheduled', 'sent', 'failed', 'expired', 'cancelled'], 'queued'),
        mysqlDateTime(notification.scheduledFor),
        mysqlDateTime(notification.sentAt),
        mysqlDateTime(notification.expiredAt),
        jsonValue(notification.metadata || {})
      ]),
    settings: [...tenantIds].map((tenantId) => [tenantId, jsonValue({ ...(data.settings || {}), tenantId })]),
    loyaltyRules: [...tenantIds].map((tenantId) => [
      tenantId,
      numberValue(data.loyaltyRules?.pointsPerCurrency, 1),
      intValue(data.loyaltyRules?.pointsPerReferral, 120),
      numberValue(data.loyaltyRules?.birthdayCouponValue, 25),
      jsonValue(data.loyaltyRules || {})
    ]),
    loyaltyRewards: (data.loyaltyRules?.rewards || [])
      .filter((reward) => reward.id)
      .flatMap((reward) =>
        [...tenantIds].map((tenantId) => [
          reward.id,
          tenantId,
          textValue(reward.name, reward.id),
          intValue(reward.points, 0),
          reward.discountValue === undefined ? null : numberValue(reward.discountValue, 0),
          reward.serviceId && serviceIds.has(reward.serviceId) ? reward.serviceId : null,
          jsonValue(reward)
        ])
      ),
    operationalReconciliation: [...tenantIds].map((tenantId) => [
      tenantId,
      data.operationalReconciliation?.ruleVersion || null,
      mysqlDateTime(data.operationalReconciliation?.lastRunAt),
      data.operationalReconciliation?.lastRunBy || null,
      mysqlDateTime(data.operationalReconciliation?.lastCheckedAt),
      data.operationalReconciliation?.lastCheckedBy || null,
      jsonValue(data.operationalReconciliation || {})
    ]),
    operationalReconciliationEvents: (data.operationalReconciliation?.events || []).map((event) => [
      event.id,
      tenantIdOf(event, data),
      event.type || event.key || 'event',
      event.entity || null,
      event.entityId || null,
      event.previousStatus || null,
      event.nextStatus || null,
      event.label || null,
      event.message || null,
      mysqlDateTime(event.createdAt) || timestamp
    ]),
    auditLogs: (data.auditLogs || [])
      .filter((log) => log.id)
      .map((log) => [
        log.id,
        tenantIdOf(log, data),
        log.userId && userIds.has(log.userId) ? log.userId : null,
        textValue(log.action, 'unknown'),
        textValue(log.entity, 'system'),
        log.entityId || null,
        typeof log.details === 'object' ? jsonValue(log.details) : log.details || null,
        log.ip || null,
        mysqlDateTime(log.createdAt) || timestamp
      ])
  };
}

async function deleteProjectionTables(connection) {
  const tables = [
    'operational_reconciliation_events',
    'operational_reconciliation',
    'loyalty_rewards',
    'loyalty_rules',
    'tenant_settings',
    'notifications',
    'waitlist',
    'coupons',
    'promotions',
    'expenses',
    'audit_logs',
    'stock_movements',
    'products',
    'reviews',
    'commissions',
    'payments',
    'appointments',
    'barber_time_blocks',
    'service_barbers',
    'services',
    'client_tags',
    'clients',
    'barber_units',
    'barber_specialties',
    'barbers',
    'users',
    'units',
    'tenants'
  ];

  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of tables) {
    await connection.query(`DELETE FROM \`${table}\``);
  }
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
}

async function insertProjectionRows(connection, rows) {
  await executeMany(
    connection,
    `INSERT INTO tenants (id, name, slug, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    rows.tenants
  );
  await executeMany(
    connection,
    `INSERT INTO units (id, tenant_id, name, phone, whatsapp, email, address, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.units
  );
  await executeMany(
    connection,
    `INSERT INTO users
       (id, tenant_id, unit_id, role, name, email, phone, password_hash, must_change_password,
        password_reset_token_hash, password_reset_expires_at, password_changed_at, status,
        avatar_url, birth_date, last_login_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.users
  );
  await executeMany(
    connection,
    `INSERT INTO barbers
       (id, tenant_id, user_id, name, phone, email, bio, commission_rate, rating, goal_monthly, status, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.barbers
  );
  await executeMany(connection, 'INSERT INTO barber_specialties (barber_id, specialty) VALUES (?, ?)', rows.barberSpecialties);
  await executeMany(connection, 'INSERT INTO barber_units (barber_id, unit_id) VALUES (?, ?)', rows.barberUnits);
  await executeMany(
    connection,
    `INSERT INTO clients
       (id, tenant_id, user_id, preferred_barber_id, name, phone, email, birth_date,
        loyalty_points, visits, no_shows, notes, status, archived_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.clients
  );
  await executeMany(connection, 'INSERT INTO client_tags (client_id, tag) VALUES (?, ?)', rows.clientTags);
  await executeMany(
    connection,
    `INSERT INTO services
       (id, tenant_id, name, description, price, duration_minutes, icon, color, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.services
  );
  await executeMany(connection, 'INSERT INTO service_barbers (service_id, barber_id) VALUES (?, ?)', rows.serviceBarbers);
  await executeMany(
    connection,
    `INSERT INTO barber_time_blocks (id, barber_id, created_by, block_date, start_time, end_time, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rows.barberBlocks
  );
  await executeMany(
    connection,
    `INSERT INTO appointments
       (id, tenant_id, code, unit_id, client_id, barber_id, service_id, appointment_date,
        start_time, end_time, status, notes, internal_notes,
        cancellation_reason, is_fit_in, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.appointments
  );
  await executeMany(
    connection,
    `INSERT INTO commissions
       (id, tenant_id, appointment_id, barber_id, amount, rate, status, commission_date, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.commissions
  );
  await executeMany(
    connection,
    `INSERT INTO reviews (id, tenant_id, appointment_id, client_id, barber_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.reviews
  );
  await executeMany(
    connection,
    `INSERT INTO products
       (id, tenant_id, unit_id, name, category, sku, quantity, purchase_price, sale_price, min_stock, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.products
  );
  await executeMany(
    connection,
    `INSERT INTO stock_movements (id, tenant_id, product_id, user_id, type, quantity, unit_value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.stockMovements
  );
  await executeMany(
    connection,
    `INSERT INTO expenses (id, tenant_id, category, description, amount, due_date, status, paid_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.expenses
  );
  await executeMany(
    connection,
    `INSERT INTO promotions
       (id, tenant_id, title, description, code, discount_type, discount_value,
        starts_at, ends_at, audience, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.promotions
  );
  await executeMany(
    connection,
    `INSERT INTO coupons
       (id, tenant_id, promotion_id, client_id, code, discount_type, discount_value, expires_at, used_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.coupons
  );
  await executeMany(
    connection,
    `INSERT INTO waitlist
       (id, tenant_id, client_id, service_id, barber_id, preferred_date, period, status, expired_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.waitlist
  );
  await executeMany(
    connection,
    `INSERT INTO notifications
       (id, tenant_id, user_id, channel, title, message, status, scheduled_for, sent_at, expired_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.notifications
  );
  await executeMany(connection, 'INSERT INTO tenant_settings (tenant_id, settings_json) VALUES (?, ?)', rows.settings);
  await executeMany(
    connection,
    `INSERT INTO loyalty_rules
       (tenant_id, points_per_currency, points_per_referral, birthday_coupon_value, rules_json)
     VALUES (?, ?, ?, ?, ?)`,
    rows.loyaltyRules
  );
  await executeMany(
    connection,
    `INSERT INTO loyalty_rewards
       (id, tenant_id, name, points, discount_value, service_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rows.loyaltyRewards
  );
  await executeMany(
    connection,
    `INSERT INTO operational_reconciliation
       (tenant_id, rule_version, last_run_at, last_run_by, last_checked_at, last_checked_by, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rows.operationalReconciliation
  );
  await executeMany(
    connection,
    `INSERT INTO operational_reconciliation_events
       (id, tenant_id, rule_key, entity, entity_id, previous_status, next_status, label, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.operationalReconciliationEvents
  );
  await executeMany(
    connection,
    `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.auditLogs
  );
}

async function persistSnapshot(pool, data, stateId) {
  await applyRelationalSchema(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO app_state (id, data)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
      [stateId, JSON.stringify(data)]
    );
    await deleteProjectionTables(connection);
    await insertProjectionRows(connection, buildRelationalRows(data));
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    } catch {
      // Ignore cleanup errors; the original error is more useful.
    }
    connection.release();
  }
}

module.exports = {
  applyRelationalSchema,
  buildRelationalRows,
  persistSnapshot
};
