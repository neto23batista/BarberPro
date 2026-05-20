function pad(number) {
  return String(number).padStart(2, '0');
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao'].includes(normalized)) return false;
  return fallback;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function timeOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  const text = String(value);
  const match = text.match(/\d{2}:\d{2}/);
  return match ? match[0] : null;
}

function isoDateTime(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();

  const text = String(value).trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const mysqlLike = new Date(text.replace(' ', 'T'));
  if (!Number.isNaN(mysqlLike.getTime())) return mysqlLike.toISOString();
  return text;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (Buffer.isBuffer(value)) return parseJson(value.toString('utf8'), fallback);
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function parseDetails(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseJson(value, undefined);
  return parsed === undefined ? String(value) : parsed;
}

function groupValues(rows, key, mapper) {
  return rows.reduce((groups, row) => {
    const id = row[key];
    if (!id) return groups;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(mapper(row));
    return groups;
  }, new Map());
}

async function fetchAll(pool) {
  const queries = {
    appState: 'SELECT data FROM app_state WHERE id = ? LIMIT 1',
    tenants: 'SELECT * FROM tenants ORDER BY created_at, id',
    units: 'SELECT * FROM units ORDER BY name, id',
    users: 'SELECT * FROM users ORDER BY created_at, id',
    barbers: 'SELECT * FROM barbers ORDER BY name, id',
    barberSpecialties: 'SELECT * FROM barber_specialties ORDER BY barber_id, specialty',
    barberUnits: 'SELECT * FROM barber_units ORDER BY barber_id, unit_id',
    clients: 'SELECT * FROM clients ORDER BY created_at, id',
    clientTags: 'SELECT * FROM client_tags ORDER BY client_id, tag',
    services: 'SELECT * FROM services ORDER BY name, id',
    serviceBarbers: 'SELECT * FROM service_barbers ORDER BY service_id, barber_id',
    barberBlocks: 'SELECT * FROM barber_time_blocks ORDER BY block_date, start_time, id',
    appointments: 'SELECT * FROM appointments ORDER BY appointment_date, start_time, id',
    commissions: 'SELECT * FROM commissions ORDER BY commission_date, id',
    reviews: 'SELECT * FROM reviews ORDER BY created_at DESC, id',
    products: 'SELECT * FROM products ORDER BY name, id',
    stockMovements: 'SELECT * FROM stock_movements ORDER BY created_at DESC, id',
    expenses: 'SELECT * FROM expenses ORDER BY due_date, created_at, id',
    promotions: 'SELECT * FROM promotions ORDER BY starts_at, id',
    coupons: 'SELECT * FROM coupons ORDER BY created_at, id',
    waitlist: 'SELECT * FROM waitlist ORDER BY preferred_date, created_at, id',
    notifications: 'SELECT * FROM notifications ORDER BY created_at DESC, id',
    tenantSettings: 'SELECT * FROM tenant_settings ORDER BY tenant_id',
    loyaltyRules: 'SELECT * FROM loyalty_rules ORDER BY tenant_id',
    loyaltyRewards: 'SELECT * FROM loyalty_rewards ORDER BY tenant_id, points, id',
    operationalReconciliation: 'SELECT * FROM operational_reconciliation ORDER BY tenant_id',
    operationalReconciliationEvents: 'SELECT * FROM operational_reconciliation_events ORDER BY created_at DESC, id',
    auditLogs: 'SELECT * FROM audit_logs ORDER BY created_at DESC, id'
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, sql]) => {
      const [rows] = name === 'appState' ? await pool.execute(sql, ['barberpro']) : await pool.query(sql);
      return [name, rows];
    })
  );

  return Object.fromEntries(entries);
}

async function readRelationalData(pool, fallbackData = {}) {
  const rows = await fetchAll(pool);
  const stateData = parseJson(rows.appState?.[0]?.data, fallbackData || {});
  const defaultTenantId =
    stateData?.meta?.defaultTenantId ||
    rows.tenants?.[0]?.id ||
    process.env.DEFAULT_TENANT_ID ||
    'tenant_demo';

  const clientTagsByClient = groupValues(rows.clientTags || [], 'client_id', (row) => row.tag);
  const barberSpecialtiesByBarber = groupValues(rows.barberSpecialties || [], 'barber_id', (row) => row.specialty);
  const barberUnitsByBarber = groupValues(rows.barberUnits || [], 'barber_id', (row) => row.unit_id);
  const serviceBarbersByService = groupValues(rows.serviceBarbers || [], 'service_id', (row) => row.barber_id);
  const blocksByBarber = groupValues(rows.barberBlocks || [], 'barber_id', (row) => ({
    id: row.id,
    barberId: row.barber_id,
    createdBy: row.created_by || null,
    date: dateOnly(row.block_date),
    startTime: timeOnly(row.start_time),
    endTime: timeOnly(row.end_time),
    reason: row.reason || '',
    createdAt: isoDateTime(row.created_at)
  }));
  const clientIdByUserId = new Map((rows.clients || []).filter((row) => row.user_id).map((row) => [row.user_id, row.id]));
  const barberIdByUserId = new Map((rows.barbers || []).filter((row) => row.user_id).map((row) => [row.user_id, row.id]));

  const tenants = (rows.tenants || []).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const units = (rows.units || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    name: row.name,
    phone: row.phone || '',
    whatsapp: row.whatsapp || '',
    email: row.email || '',
    address: row.address || '',
    status: row.status,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const users = (rows.users || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    unitId: row.unit_id || null,
    role: row.role,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    passwordHash: row.password_hash,
    mustChangePassword: boolValue(row.must_change_password),
    passwordResetTokenHash: row.password_reset_token_hash || null,
    passwordResetExpiresAt: isoDateTime(row.password_reset_expires_at),
    passwordChangedAt: isoDateTime(row.password_changed_at),
    status: row.status,
    avatar: row.avatar_url || '',
    birthDate: dateOnly(row.birth_date),
    lastLoginAt: isoDateTime(row.last_login_at),
    clientId: clientIdByUserId.get(row.id) || null,
    barberId: barberIdByUserId.get(row.id) || null,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const clients = (rows.clients || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    userId: row.user_id || null,
    preferredBarberId: row.preferred_barber_id || null,
    name: row.name,
    phone: row.phone || '',
    email: row.email || '',
    birthDate: dateOnly(row.birth_date),
    loyaltyPoints: intValue(row.loyalty_points),
    visits: intValue(row.visits),
    noShows: intValue(row.no_shows),
    notes: row.notes || '',
    status: row.status || 'active',
    archivedAt: isoDateTime(row.archived_at),
    tags: clientTagsByClient.get(row.id) || [],
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const barbers = (rows.barbers || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    userId: row.user_id || null,
    name: row.name,
    phone: row.phone || '',
    email: row.email || '',
    bio: row.bio || '',
    specialties: barberSpecialtiesByBarber.get(row.id) || [],
    unitIds: barberUnitsByBarber.get(row.id) || [],
    commissionRate: numberValue(row.commission_rate, 0.4),
    rating: numberValue(row.rating, 5),
    goalMonthly: numberValue(row.goal_monthly),
    status: row.status,
    archivedAt: isoDateTime(row.archived_at),
    blocks: blocksByBarber.get(row.id) || [],
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const services = (rows.services || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    name: row.name,
    description: row.description || '',
    price: numberValue(row.price),
    durationMinutes: intValue(row.duration_minutes, 30),
    icon: row.icon || '',
    color: row.color || '',
    active: boolValue(row.active, true),
    archivedAt: isoDateTime(row.archived_at),
    barberIds: serviceBarbersByService.get(row.id) || [],
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const appointments = (rows.appointments || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    code: row.code,
    unitId: row.unit_id,
    clientId: row.client_id,
    barberId: row.barber_id,
    serviceId: row.service_id,
    date: dateOnly(row.appointment_date),
    startTime: timeOnly(row.start_time),
    endTime: timeOnly(row.end_time),
    status: row.status,
    notes: row.notes || '',
    internalNotes: row.internal_notes || '',
    cancellationReason: row.cancellation_reason || null,
    isFitIn: boolValue(row.is_fit_in),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const commissions = (rows.commissions || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    appointmentId: row.appointment_id,
    barberId: row.barber_id,
    amount: numberValue(row.amount),
    rate: numberValue(row.rate),
    status: row.status,
    date: dateOnly(row.commission_date),
    paidAt: isoDateTime(row.paid_at),
    createdAt: isoDateTime(row.created_at)
  }));

  const reviews = (rows.reviews || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    appointmentId: row.appointment_id,
    clientId: row.client_id,
    barberId: row.barber_id,
    rating: intValue(row.rating, 5),
    comment: row.comment || '',
    createdAt: isoDateTime(row.created_at)
  }));

  const products = (rows.products || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    unitId: row.unit_id || null,
    name: row.name,
    category: row.category,
    sku: row.sku || '',
    quantity: intValue(row.quantity),
    purchasePrice: numberValue(row.purchase_price),
    salePrice: numberValue(row.sale_price),
    minStock: intValue(row.min_stock, 1),
    active: boolValue(row.active, true),
    archivedAt: isoDateTime(row.archived_at),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const stockMovements = (rows.stockMovements || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    productId: row.product_id,
    userId: row.user_id || null,
    type: row.type,
    quantity: intValue(row.quantity),
    unitValue: numberValue(row.unit_value),
    reason: row.reason || '',
    createdAt: isoDateTime(row.created_at)
  }));

  const expenses = (rows.expenses || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    category: row.category,
    description: row.description,
    amount: numberValue(row.amount),
    dueDate: dateOnly(row.due_date),
    status: row.status,
    paidAt: isoDateTime(row.paid_at),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const promotions = (rows.promotions || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    title: row.title,
    description: row.description || '',
    code: row.code,
    discountType: row.discount_type,
    discountValue: numberValue(row.discount_value),
    startsAt: dateOnly(row.starts_at),
    endsAt: dateOnly(row.ends_at),
    audience: row.audience || 'all',
    active: boolValue(row.active, true),
    archivedAt: isoDateTime(row.archived_at),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const coupons = (rows.coupons || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    promotionId: row.promotion_id || null,
    clientId: row.client_id || null,
    code: row.code,
    discountType: row.discount_type,
    discountValue: numberValue(row.discount_value),
    expiresAt: dateOnly(row.expires_at),
    usedAt: isoDateTime(row.used_at),
    status: row.status,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const waitlist = (rows.waitlist || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    clientId: row.client_id || null,
    serviceId: row.service_id || null,
    barberId: row.barber_id || null,
    preferredDate: dateOnly(row.preferred_date),
    period: row.period || '',
    status: row.status,
    expiredAt: isoDateTime(row.expired_at),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const notifications = (rows.notifications || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    userId: row.user_id || null,
    channel: row.channel,
    title: row.title,
    message: row.message,
    status: row.status,
    scheduledFor: isoDateTime(row.scheduled_for),
    sentAt: isoDateTime(row.sent_at),
    expiredAt: isoDateTime(row.expired_at),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at)
  }));

  const auditLogs = (rows.auditLogs || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id || defaultTenantId,
    userId: row.user_id || null,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id || null,
    details: parseDetails(row.details),
    ip: row.ip || '',
    createdAt: isoDateTime(row.created_at)
  }));

  const settingsRow =
    (rows.tenantSettings || []).find((row) => row.tenant_id === defaultTenantId) ||
    rows.tenantSettings?.[0];
  const settings = {
    ...(parseJson(settingsRow?.settings_json, stateData.settings || {}) || {}),
    tenantId: settingsRow?.tenant_id || stateData.settings?.tenantId || defaultTenantId
  };

  const loyaltyRow =
    (rows.loyaltyRules || []).find((row) => row.tenant_id === settings.tenantId) ||
    (rows.loyaltyRules || []).find((row) => row.tenant_id === defaultTenantId) ||
    rows.loyaltyRules?.[0];
  const loyaltyRewards = (rows.loyaltyRewards || [])
    .filter((row) => !loyaltyRow || row.tenant_id === loyaltyRow.tenant_id)
    .map((row) => ({
      ...(parseJson(row.metadata_json, {}) || {}),
      id: row.id,
      tenantId: row.tenant_id || defaultTenantId,
      name: row.name,
      points: intValue(row.points),
      discountValue: row.discount_value === null ? null : numberValue(row.discount_value),
      serviceId: row.service_id || null
    }));
  const loyaltyJson = parseJson(loyaltyRow?.rules_json, stateData.loyaltyRules || {}) || {};
  const loyaltyRules = {
    ...loyaltyJson,
    pointsPerCurrency: numberValue(loyaltyRow?.points_per_currency, loyaltyJson.pointsPerCurrency ?? 1),
    pointsPerReferral: intValue(loyaltyRow?.points_per_referral, loyaltyJson.pointsPerReferral ?? 120),
    birthdayCouponValue: numberValue(loyaltyRow?.birthday_coupon_value, loyaltyJson.birthdayCouponValue ?? 25),
    rewards: loyaltyRewards.length ? loyaltyRewards : loyaltyJson.rewards || []
  };

  const reconciliationRow =
    (rows.operationalReconciliation || []).find((row) => row.tenant_id === settings.tenantId) ||
    (rows.operationalReconciliation || []).find((row) => row.tenant_id === defaultTenantId) ||
    rows.operationalReconciliation?.[0];
  const reconciliationEvents = (rows.operationalReconciliationEvents || [])
    .filter((row) => !reconciliationRow || row.tenant_id === reconciliationRow.tenant_id)
    .map((row) => ({
      id: row.id,
      tenantId: row.tenant_id || defaultTenantId,
      type: row.rule_key,
      key: row.rule_key,
      entity: row.entity || null,
      entityId: row.entity_id || null,
      previousStatus: row.previous_status || null,
      nextStatus: row.next_status || null,
      label: row.label || '',
      message: row.message || '',
      createdAt: isoDateTime(row.created_at)
    }));
  const reconciliationJson =
    parseJson(reconciliationRow?.state_json, stateData.operationalReconciliation || {}) || {};
  const operationalReconciliation = {
    ...reconciliationJson,
    tenantId: reconciliationRow?.tenant_id || settings.tenantId || defaultTenantId,
    ruleVersion: reconciliationRow?.rule_version || reconciliationJson.ruleVersion || null,
    lastRunAt: isoDateTime(reconciliationRow?.last_run_at) || reconciliationJson.lastRunAt || null,
    lastRunBy: reconciliationRow?.last_run_by || reconciliationJson.lastRunBy || null,
    lastCheckedAt: isoDateTime(reconciliationRow?.last_checked_at) || reconciliationJson.lastCheckedAt || null,
    lastCheckedBy: reconciliationRow?.last_checked_by || reconciliationJson.lastCheckedBy || null,
    events: reconciliationEvents.length ? reconciliationEvents : reconciliationJson.events || []
  };

  return {
    ...(stateData || {}),
    meta: {
      ...(stateData.meta || {}),
      defaultTenantId
    },
    tenants,
    units,
    users,
    clients,
    barbers,
    services,
    appointments,
    payments: [],
    commissions,
    reviews,
    products,
    stockMovements,
    expenses,
    promotions,
    coupons,
    waitlist,
    notifications,
    auditLogs,
    settings,
    loyaltyRules,
    operationalReconciliation
  };
}

module.exports = {
  readRelationalData,
  dateOnly,
  timeOnly,
  isoDateTime
};
