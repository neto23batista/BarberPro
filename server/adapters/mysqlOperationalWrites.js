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
  return Boolean(value);
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function tenantIdOf(item, data) {
  return item?.tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
}

function rowMap(items = []) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function changedItem(beforeItems = [], afterItems = [], id) {
  if (id) return afterItems.find((item) => item.id === id) || null;
  const beforeById = rowMap(beforeItems);
  return afterItems.find((item) => JSON.stringify(beforeById.get(item.id) || null) !== JSON.stringify(item)) || null;
}

function changedItems(beforeItems = [], afterItems = []) {
  const beforeById = rowMap(beforeItems);
  return afterItems.filter((item) => item?.id && JSON.stringify(beforeById.get(item.id) || null) !== JSON.stringify(item));
}

function newItems(beforeItems = [], afterItems = []) {
  const beforeIds = new Set(beforeItems.map((item) => item.id));
  return afterItems.filter((item) => item?.id && !beforeIds.has(item.id));
}

function deletedItem(beforeItems = [], afterItems = [], id) {
  const afterIds = new Set(afterItems.map((item) => item.id));
  if (id) {
    return beforeItems.find((item) => item.id === id && !afterIds.has(item.id)) || null;
  }
  return beforeItems.find((item) => item?.id && !afterIds.has(item.id)) || null;
}

function auditDetails(details) {
  if (details === undefined || details === null) return null;
  return typeof details === 'object' ? JSON.stringify(details) : String(details);
}

function uniqueById(items = []) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

async function upsertTenant(connection, tenant) {
  if (!tenant?.id) return;
  await connection.execute(
    `INSERT INTO tenants (id, name, slug, status, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       slug = VALUES(slug),
       status = VALUES(status),
       updated_at = CURRENT_TIMESTAMP`,
    [
      tenant.id,
      tenant.name || tenant.id,
      tenant.slug || tenant.id,
      enumValue(tenant.status, ['active', 'inactive', 'blocked'], 'active'),
      mysqlDateTime(tenant.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function upsertUnit(connection, unit, data) {
  if (!unit?.id) return;
  await connection.execute(
    `INSERT INTO units (id, tenant_id, name, phone, whatsapp, email, address, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       name = VALUES(name),
       phone = VALUES(phone),
       whatsapp = VALUES(whatsapp),
       email = VALUES(email),
       address = VALUES(address),
       status = VALUES(status),
       updated_at = CURRENT_TIMESTAMP`,
    [
      unit.id,
      tenantIdOf(unit, data),
      unit.name || unit.id,
      unit.phone || null,
      unit.whatsapp || null,
      unit.email || null,
      unit.address || null,
      enumValue(unit.status, ['active', 'inactive', 'blocked'], 'active')
    ]
  );
}

async function upsertAppointment(connection, appointment, data) {
  await connection.execute(
    `INSERT INTO appointments
       (id, tenant_id, code, unit_id, client_id, barber_id, service_id, appointment_date,
        start_time, end_time, status, notes, internal_notes,
        cancellation_reason, is_fit_in, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       code = VALUES(code),
       unit_id = VALUES(unit_id),
       client_id = VALUES(client_id),
       barber_id = VALUES(barber_id),
       service_id = VALUES(service_id),
       appointment_date = VALUES(appointment_date),
       start_time = VALUES(start_time),
       end_time = VALUES(end_time),
       status = VALUES(status),
       notes = VALUES(notes),
       internal_notes = VALUES(internal_notes),
       cancellation_reason = VALUES(cancellation_reason),
       is_fit_in = VALUES(is_fit_in),
       updated_at = CURRENT_TIMESTAMP`,
    [
      appointment.id,
      tenantIdOf(appointment, data),
      appointment.code,
      appointment.unitId || data.settings?.defaultUnitId || data.units?.[0]?.id,
      appointment.clientId,
      appointment.barberId,
      appointment.serviceId,
      mysqlDate(appointment.date),
      appointment.startTime,
      appointment.endTime,
      appointment.status || 'scheduled',
      appointment.notes || '',
      appointment.internalNotes || '',
      appointment.cancellationReason || null,
      boolValue(appointment.isFitIn, false),
      mysqlDateTime(appointment.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function upsertCommission(connection, commission, data) {
  await connection.execute(
    `INSERT INTO commissions
       (id, tenant_id, appointment_id, barber_id, amount, rate, status, commission_date, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       barber_id = VALUES(barber_id),
       amount = VALUES(amount),
       rate = VALUES(rate),
       status = VALUES(status),
       commission_date = VALUES(commission_date),
       paid_at = VALUES(paid_at)`,
    [
      commission.id,
      tenantIdOf(commission, data),
      commission.appointmentId,
      commission.barberId,
      numberValue(commission.amount),
      numberValue(commission.rate),
      commission.status || 'pending',
      mysqlDate(commission.date) || mysqlDate(new Date()),
      mysqlDateTime(commission.paidAt)
    ]
  );
}

async function updateClientCounters(connection, client, data) {
  if (!client?.id) return;
  await connection.execute(
    `UPDATE clients
        SET loyalty_points = ?,
            visits = ?,
            no_shows = ?,
            preferred_barber_id = ?,
            notes = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND tenant_id = ?`,
    [
      intValue(client.loyaltyPoints),
      intValue(client.visits),
      intValue(client.noShows),
      client.preferredBarberId || null,
      client.notes || null,
      client.id,
      tenantIdOf(client, data)
    ]
  );
}

async function upsertUser(connection, user, data) {
  if (!user?.id || !user.email || !user.passwordHash) return;
  await connection.execute(
    `INSERT INTO users
       (id, tenant_id, unit_id, role, name, email, phone, password_hash, must_change_password,
        password_reset_token_hash, password_reset_expires_at, password_changed_at, status,
        avatar_url, birth_date, last_login_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       unit_id = VALUES(unit_id),
       role = VALUES(role),
       name = VALUES(name),
       email = VALUES(email),
       phone = VALUES(phone),
       password_hash = VALUES(password_hash),
       must_change_password = VALUES(must_change_password),
       password_reset_token_hash = VALUES(password_reset_token_hash),
       password_reset_expires_at = VALUES(password_reset_expires_at),
       password_changed_at = VALUES(password_changed_at),
       status = VALUES(status),
       avatar_url = VALUES(avatar_url),
       birth_date = VALUES(birth_date),
       last_login_at = VALUES(last_login_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      user.id,
      tenantIdOf(user, data),
      user.unitId || null,
      user.role || 'client',
      user.name || user.email,
      String(user.email).trim().toLowerCase(),
      user.phone || null,
      user.passwordHash,
      boolValue(user.mustChangePassword, false),
      user.passwordResetTokenHash || null,
      mysqlDateTime(user.passwordResetExpiresAt),
      mysqlDateTime(user.passwordChangedAt),
      user.status || 'active',
      user.avatar || user.avatarUrl || null,
      mysqlDate(user.birthDate),
      mysqlDateTime(user.lastLoginAt),
      mysqlDateTime(user.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function deleteUser(connection, user) {
  if (!user?.id) return;
  await connection.execute('DELETE FROM users WHERE id = ?', [user.id]);
}

async function upsertClient(connection, client, data) {
  if (!client?.id) return;
  await connection.execute(
    `INSERT INTO clients
       (id, tenant_id, user_id, preferred_barber_id, name, phone, email, birth_date,
        loyalty_points, visits, no_shows, notes, status, archived_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       user_id = VALUES(user_id),
       preferred_barber_id = VALUES(preferred_barber_id),
       name = VALUES(name),
       phone = VALUES(phone),
       email = VALUES(email),
       birth_date = VALUES(birth_date),
       loyalty_points = VALUES(loyalty_points),
       visits = VALUES(visits),
       no_shows = VALUES(no_shows),
       notes = VALUES(notes),
       status = VALUES(status),
       archived_at = VALUES(archived_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      client.id,
      tenantIdOf(client, data),
      client.userId || null,
      client.preferredBarberId || null,
      client.name || client.id,
      client.phone || '',
      client.email || null,
      mysqlDate(client.birthDate),
      intValue(client.loyaltyPoints),
      intValue(client.visits),
      intValue(client.noShows),
      client.notes || null,
      client.status || 'active',
      mysqlDateTime(client.archivedAt),
      mysqlDateTime(client.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function syncClientTags(connection, client) {
  if (!client?.id) return;
  await connection.execute('DELETE FROM client_tags WHERE client_id = ?', [client.id]);
  for (const tag of client.tags || []) {
    if (!tag) continue;
    await connection.execute('INSERT INTO client_tags (client_id, tag) VALUES (?, ?)', [client.id, String(tag).slice(0, 40)]);
  }
}

async function deleteClient(connection, client) {
  if (!client?.id) return;
  await connection.execute('DELETE FROM client_tags WHERE client_id = ?', [client.id]);
  await connection.execute('DELETE FROM clients WHERE id = ?', [client.id]);
}

async function upsertBarber(connection, barber, data) {
  if (!barber?.id) return;
  await connection.execute(
    `INSERT INTO barbers
       (id, tenant_id, user_id, name, phone, email, bio, commission_rate,
        rating, goal_monthly, status, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       user_id = VALUES(user_id),
       name = VALUES(name),
       phone = VALUES(phone),
       email = VALUES(email),
       bio = VALUES(bio),
       commission_rate = VALUES(commission_rate),
       rating = VALUES(rating),
       goal_monthly = VALUES(goal_monthly),
       status = VALUES(status),
       archived_at = VALUES(archived_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      barber.id,
      tenantIdOf(barber, data),
      barber.userId || null,
      barber.name || barber.id,
      barber.phone || null,
      barber.email || null,
      barber.bio || null,
      numberValue(barber.commissionRate, 0.4),
      numberValue(barber.rating, 5),
      numberValue(barber.goalMonthly),
      barber.status || 'active',
      mysqlDateTime(barber.archivedAt)
    ]
  );
}

async function syncBarberRelations(connection, barber, data) {
  if (!barber?.id) return;
  await connection.execute('DELETE FROM barber_specialties WHERE barber_id = ?', [barber.id]);
  for (const specialty of barber.specialties || []) {
    if (!specialty) continue;
    await connection.execute('INSERT INTO barber_specialties (barber_id, specialty) VALUES (?, ?)', [barber.id, String(specialty).slice(0, 80)]);
  }

  await connection.execute('DELETE FROM barber_units WHERE barber_id = ?', [barber.id]);
  const unitIds = new Set((data.units || []).map((unit) => unit.id));
  for (const unitId of barber.unitIds || []) {
    if (!unitIds.has(unitId)) continue;
    await connection.execute('INSERT INTO barber_units (barber_id, unit_id) VALUES (?, ?)', [barber.id, unitId]);
  }

  await connection.execute('DELETE FROM barber_time_blocks WHERE barber_id = ?', [barber.id]);
  const userIds = new Set((data.users || []).map((user) => user.id));
  for (const block of barber.blocks || []) {
    if (!block?.id || !mysqlDate(block.date)) continue;
    await connection.execute(
      `INSERT INTO barber_time_blocks (id, barber_id, created_by, block_date, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id,
        barber.id,
        block.createdBy && userIds.has(block.createdBy) ? block.createdBy : null,
        mysqlDate(block.date),
        block.startTime,
        block.endTime,
        block.reason || null
      ]
    );
  }
}

async function syncBarberServiceLinks(connection, barber, data) {
  if (!barber?.id) return;
  await connection.execute('DELETE FROM service_barbers WHERE barber_id = ?', [barber.id]);
  for (const service of data.services || []) {
    if ((service.barberIds || []).includes(barber.id)) {
      await connection.execute('INSERT INTO service_barbers (service_id, barber_id) VALUES (?, ?)', [service.id, barber.id]);
    }
  }
}

async function deleteBarber(connection, barber) {
  if (!barber?.id) return;
  await connection.execute('DELETE FROM service_barbers WHERE barber_id = ?', [barber.id]);
  await connection.execute('DELETE FROM barber_time_blocks WHERE barber_id = ?', [barber.id]);
  await connection.execute('DELETE FROM barber_units WHERE barber_id = ?', [barber.id]);
  await connection.execute('DELETE FROM barber_specialties WHERE barber_id = ?', [barber.id]);
  await connection.execute('DELETE FROM barbers WHERE id = ?', [barber.id]);
}

async function upsertService(connection, service, data) {
  if (!service?.id) return;
  await connection.execute(
    `INSERT INTO services
       (id, tenant_id, name, description, price, duration_minutes, icon, color, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       name = VALUES(name),
       description = VALUES(description),
       price = VALUES(price),
       duration_minutes = VALUES(duration_minutes),
       icon = VALUES(icon),
       color = VALUES(color),
       active = VALUES(active),
       archived_at = VALUES(archived_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      service.id,
      tenantIdOf(service, data),
      service.name || service.id,
      service.description || null,
      numberValue(service.price),
      intValue(service.durationMinutes, 30),
      service.icon || null,
      service.color || null,
      service.active !== false,
      mysqlDateTime(service.archivedAt)
    ]
  );
}

async function syncServiceBarbers(connection, service, data) {
  if (!service?.id) return;
  await connection.execute('DELETE FROM service_barbers WHERE service_id = ?', [service.id]);
  const barberIds = new Set((data.barbers || []).map((barber) => barber.id));
  for (const barberId of service.barberIds || []) {
    if (!barberIds.has(barberId)) continue;
    await connection.execute('INSERT INTO service_barbers (service_id, barber_id) VALUES (?, ?)', [service.id, barberId]);
  }
}

async function deleteService(connection, service) {
  if (!service?.id) return;
  await connection.execute('DELETE FROM service_barbers WHERE service_id = ?', [service.id]);
  await connection.execute('DELETE FROM services WHERE id = ?', [service.id]);
}

async function upsertProduct(connection, product, data) {
  if (!product?.id) return;
  await connection.execute(
    `INSERT INTO products
       (id, tenant_id, unit_id, name, category, sku, quantity, purchase_price,
        sale_price, min_stock, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       unit_id = VALUES(unit_id),
       name = VALUES(name),
       category = VALUES(category),
       sku = VALUES(sku),
       quantity = VALUES(quantity),
       purchase_price = VALUES(purchase_price),
       sale_price = VALUES(sale_price),
       min_stock = VALUES(min_stock),
       active = VALUES(active),
       archived_at = VALUES(archived_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      product.id,
      tenantIdOf(product, data),
      product.unitId || null,
      product.name,
      product.category || 'Geral',
      product.sku || null,
      intValue(product.quantity),
      numberValue(product.purchasePrice),
      numberValue(product.salePrice),
      intValue(product.minStock, 1),
      product.active !== false,
      mysqlDateTime(product.archivedAt)
    ]
  );
}

async function updateProduct(connection, product, data) {
  return upsertProduct(connection, product, data);
}

async function deleteProduct(connection, product) {
  if (!product?.id) return;
  await connection.execute('DELETE FROM products WHERE id = ?', [product.id]);
}

async function upsertExpense(connection, expense, data) {
  if (!expense?.id) return;
  await connection.execute(
    `INSERT INTO expenses (id, tenant_id, category, description, amount, due_date, status, paid_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       category = VALUES(category),
       description = VALUES(description),
       amount = VALUES(amount),
       due_date = VALUES(due_date),
       status = VALUES(status),
       paid_at = VALUES(paid_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      expense.id,
      tenantIdOf(expense, data),
      expense.category || 'Geral',
      expense.description || expense.id,
      numberValue(expense.amount),
      mysqlDate(expense.dueDate),
      expense.status || 'pending',
      mysqlDateTime(expense.paidAt),
      mysqlDateTime(expense.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function deleteExpense(connection, expense) {
  if (!expense?.id) return;
  await connection.execute('DELETE FROM expenses WHERE id = ?', [expense.id]);
}

async function upsertPromotion(connection, promotion, data) {
  if (!promotion?.id) return;
  await connection.execute(
    `INSERT INTO promotions
       (id, tenant_id, title, description, code, discount_type, discount_value,
        starts_at, ends_at, audience, active, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       description = VALUES(description),
       code = VALUES(code),
       discount_type = VALUES(discount_type),
       discount_value = VALUES(discount_value),
       starts_at = VALUES(starts_at),
       ends_at = VALUES(ends_at),
       audience = VALUES(audience),
       active = VALUES(active),
       archived_at = VALUES(archived_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      promotion.id,
      tenantIdOf(promotion, data),
      promotion.title || promotion.id,
      promotion.description || null,
      String(promotion.code || promotion.id).toUpperCase(),
      promotion.discountType || 'fixed',
      numberValue(promotion.discountValue),
      mysqlDate(promotion.startsAt),
      mysqlDate(promotion.endsAt),
      promotion.audience || 'all',
      promotion.active !== false,
      mysqlDateTime(promotion.archivedAt)
    ]
  );
}

async function deletePromotion(connection, promotion) {
  if (!promotion?.id) return;
  await connection.execute('DELETE FROM promotions WHERE id = ?', [promotion.id]);
}

async function upsertCoupon(connection, coupon, data) {
  if (!coupon?.id) return;
  await connection.execute(
    `INSERT INTO coupons
       (id, tenant_id, promotion_id, client_id, code, discount_type, discount_value, expires_at, used_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       promotion_id = VALUES(promotion_id),
       client_id = VALUES(client_id),
       code = VALUES(code),
       discount_type = VALUES(discount_type),
       discount_value = VALUES(discount_value),
       expires_at = VALUES(expires_at),
       used_at = VALUES(used_at),
       status = VALUES(status),
       updated_at = CURRENT_TIMESTAMP`,
    [
      coupon.id,
      tenantIdOf(coupon, data),
      coupon.promotionId || null,
      coupon.clientId || null,
      String(coupon.code || coupon.id).toUpperCase(),
      coupon.discountType || 'fixed',
      numberValue(coupon.discountValue),
      mysqlDate(coupon.expiresAt),
      mysqlDateTime(coupon.usedAt),
      coupon.status || 'active'
    ]
  );
}

async function upsertWaitlistItem(connection, item, data) {
  if (!item?.id) return;
  await connection.execute(
    `INSERT INTO waitlist
       (id, tenant_id, client_id, service_id, barber_id, preferred_date, period, status, expired_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       client_id = VALUES(client_id),
       service_id = VALUES(service_id),
       barber_id = VALUES(barber_id),
       preferred_date = VALUES(preferred_date),
       period = VALUES(period),
       status = VALUES(status),
       expired_at = VALUES(expired_at),
       updated_at = CURRENT_TIMESTAMP`,
    [
      item.id,
      tenantIdOf(item, data),
      item.clientId || null,
      item.serviceId || null,
      item.barberId || null,
      mysqlDate(item.preferredDate),
      item.period || null,
      item.status || 'waiting',
      mysqlDateTime(item.expiredAt),
      mysqlDateTime(item.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function deleteWaitlistItem(connection, item) {
  if (!item?.id) return;
  await connection.execute('DELETE FROM waitlist WHERE id = ?', [item.id]);
}

async function upsertReview(connection, review, data) {
  if (!review?.id) return;
  await connection.execute(
    `INSERT INTO reviews (id, tenant_id, appointment_id, client_id, barber_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       client_id = VALUES(client_id),
       barber_id = VALUES(barber_id),
       rating = VALUES(rating),
       comment = VALUES(comment)`,
    [
      review.id,
      tenantIdOf(review, data),
      review.appointmentId,
      review.clientId,
      review.barberId,
      Math.min(5, Math.max(1, intValue(review.rating, 5))),
      review.comment || null,
      mysqlDateTime(review.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function insertStockMovement(connection, movement, data) {
  await connection.execute(
    `INSERT INTO stock_movements
       (id, tenant_id, product_id, user_id, type, quantity, unit_value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       tenant_id = VALUES(tenant_id),
       product_id = VALUES(product_id),
       user_id = VALUES(user_id),
       type = VALUES(type),
       quantity = VALUES(quantity),
       unit_value = VALUES(unit_value),
       reason = VALUES(reason)`,
    [
      movement.id,
      tenantIdOf(movement, data),
      movement.productId,
      movement.userId || null,
      movement.type || 'adjustment',
      Math.max(0, intValue(movement.quantity)),
      numberValue(movement.unitValue),
      movement.reason || null,
      mysqlDateTime(movement.createdAt) || mysqlDateTime(new Date())
    ]
  );
}

async function insertNotifications(connection, notifications, data) {
  const userIds = new Set((data.users || []).map((user) => user.id));
  for (const notification of notifications) {
    await connection.execute(
      `INSERT INTO notifications
         (id, tenant_id, user_id, channel, title, message, status,
          scheduled_for, sent_at, expired_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         channel = VALUES(channel),
         title = VALUES(title),
         message = VALUES(message),
         status = VALUES(status),
         scheduled_for = VALUES(scheduled_for),
         sent_at = VALUES(sent_at),
         expired_at = VALUES(expired_at),
         metadata_json = VALUES(metadata_json),
         updated_at = CURRENT_TIMESTAMP`,
      [
        notification.id,
        tenantIdOf(notification, data),
        notification.userId && userIds.has(notification.userId) ? notification.userId : null,
        notification.channel || 'system',
        notification.title || notification.id,
        notification.message || '',
        notification.status || 'queued',
        mysqlDateTime(notification.scheduledFor),
        mysqlDateTime(notification.sentAt),
        mysqlDateTime(notification.expiredAt),
        JSON.stringify(notification.metadata || {})
      ]
    );
  }
}

async function insertAuditLogs(connection, logs, data) {
  const userIds = new Set((data.users || []).map((user) => user.id));
  for (const log of logs) {
    await connection.execute(
      `INSERT INTO audit_logs
         (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         action = VALUES(action),
         entity = VALUES(entity),
         entity_id = VALUES(entity_id),
         details = VALUES(details),
         ip = VALUES(ip)`,
      [
        log.id,
        tenantIdOf(log, data),
        log.userId && userIds.has(log.userId) ? log.userId : null,
        log.action || 'unknown',
        log.entity || 'system',
        log.entityId || null,
        auditDetails(log.details),
        log.ip || null,
        mysqlDateTime(log.createdAt) || mysqlDateTime(new Date())
      ]
    );
  }
}

async function syncAppendOnlyRows(connection, before, after) {
  await insertNotifications(connection, newItems(before.notifications, after.notifications), after);
  await insertAuditLogs(connection, newItems(before.auditLogs, after.auditLogs), after);
}

async function upsertTenantSettings(connection, settings, data, tenantId = null) {
  const resolvedTenantId = tenantId || settings?.tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
  const settingsJson = {
    ...(settings || {}),
    tenantId: resolvedTenantId
  };
  await connection.execute(
    `INSERT INTO tenant_settings (tenant_id, settings_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       settings_json = VALUES(settings_json),
       updated_at = CURRENT_TIMESTAMP`,
    [resolvedTenantId, JSON.stringify(settingsJson)]
  );
}

async function upsertLoyaltyRules(connection, loyaltyRules, data, tenantId = null) {
  const resolvedTenantId = tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
  const rules = loyaltyRules || {};
  await connection.execute(
    `INSERT INTO loyalty_rules
       (tenant_id, points_per_currency, points_per_referral, birthday_coupon_value, rules_json)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       points_per_currency = VALUES(points_per_currency),
       points_per_referral = VALUES(points_per_referral),
       birthday_coupon_value = VALUES(birthday_coupon_value),
       rules_json = VALUES(rules_json),
       updated_at = CURRENT_TIMESTAMP`,
    [
      resolvedTenantId,
      numberValue(rules.pointsPerCurrency, 1),
      intValue(rules.pointsPerReferral, 120),
      numberValue(rules.birthdayCouponValue, 25),
      JSON.stringify(rules)
    ]
  );

  await connection.execute('DELETE FROM loyalty_rewards WHERE tenant_id = ?', [resolvedTenantId]);
  for (const reward of rules.rewards || []) {
    if (!reward?.id) continue;
    await connection.execute(
      `INSERT INTO loyalty_rewards
         (id, tenant_id, name, points, discount_value, service_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reward.id,
        resolvedTenantId,
        reward.name || reward.id,
        intValue(reward.points),
        reward.discountValue === undefined || reward.discountValue === null ? null : numberValue(reward.discountValue),
        reward.serviceId || null,
        JSON.stringify(reward)
      ]
    );
  }
}

async function upsertOperationalReconciliation(connection, state, data, tenantId = null) {
  const resolvedTenantId = tenantId || state?.tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
  await connection.execute(
    `INSERT INTO operational_reconciliation
       (tenant_id, rule_version, last_run_at, last_run_by, last_checked_at, last_checked_by, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       rule_version = VALUES(rule_version),
       last_run_at = VALUES(last_run_at),
       last_run_by = VALUES(last_run_by),
       last_checked_at = VALUES(last_checked_at),
       last_checked_by = VALUES(last_checked_by),
       state_json = VALUES(state_json),
       updated_at = CURRENT_TIMESTAMP`,
    [
      resolvedTenantId,
      state?.ruleVersion || null,
      mysqlDateTime(state?.lastRunAt),
      state?.lastRunBy || null,
      mysqlDateTime(state?.lastCheckedAt),
      state?.lastCheckedBy || null,
      JSON.stringify(state || {})
    ]
  );
}

async function insertReconciliationEvents(connection, events, data, tenantId = null) {
  const resolvedTenantId = tenantId || data?.meta?.defaultTenantId || process.env.DEFAULT_TENANT_ID || 'tenant_demo';
  for (const event of events || []) {
    if (!event?.id) continue;
    await connection.execute(
      `INSERT INTO operational_reconciliation_events
         (id, tenant_id, rule_key, entity, entity_id, previous_status, next_status, label, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         rule_key = VALUES(rule_key),
         entity = VALUES(entity),
         entity_id = VALUES(entity_id),
         previous_status = VALUES(previous_status),
         next_status = VALUES(next_status),
         label = VALUES(label),
         message = VALUES(message)`,
      [
        event.id,
        event.tenantId || resolvedTenantId,
        event.type || event.key || 'event',
        event.entity || null,
        event.entityId || null,
        event.previousStatus || null,
        event.nextStatus || null,
        event.label || null,
        event.message || null,
        mysqlDateTime(event.createdAt) || mysqlDateTime(new Date())
      ]
    );
  }
}

async function persistAppointmentMutation(connection, { before, after, result }) {
  const appointmentId = result?.appointment?.id;
  const appointment = changedItem(before.appointments, after.appointments, appointmentId);
  if (!appointment) return;

  await upsertAppointment(connection, appointment, after);

  const client = after.clients?.find((item) => item.id === appointment.clientId);
  await updateClientCounters(connection, client, after);

  const commission = after.commissions?.find((item) => item.appointmentId === appointment.id);
  if (commission) await upsertCommission(connection, commission, after);

  await syncAppendOnlyRows(connection, before, after);
}

async function persistStockMovementMutation(connection, { before, after, result }) {
  const productId = result?.product?.id || result?.movement?.productId;
  const product = after.products?.find((item) => item.id === productId);
  if (!product) return;

  await updateProduct(connection, product, after);

  const movement = changedItem(before.stockMovements, after.stockMovements, result?.movement?.id);
  if (movement) await insertStockMovement(connection, movement, after);

  await syncAppendOnlyRows(connection, before, after);
}

async function persistServiceMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const service = result.service || deletedItem(before.services, after.services);
    await deleteService(connection, service);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const service = after.services?.find((item) => item.id === result?.service?.id) ||
    changedItem(before.services, after.services);
  if (service) {
    await upsertService(connection, service, after);
    await syncServiceBarbers(connection, service, after);
  }
  await syncAppendOnlyRows(connection, before, after);
}

async function persistProductMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const product = result.product || deletedItem(before.products, after.products);
    await deleteProduct(connection, product);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const product = after.products?.find((item) => item.id === result?.product?.id) ||
    changedItem(before.products, after.products);
  if (product) await upsertProduct(connection, product, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistCustomerMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const client = result.client || deletedItem(before.clients, after.clients);
    const linkedUser = before.users?.find((user) => user.id === client?.userId);
    await deleteClient(connection, client);
    await deleteUser(connection, linkedUser);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const client = after.clients?.find((item) => item.id === result?.client?.id) ||
    changedItem(before.clients, after.clients);
  if (client) {
    const linkedUser = after.users?.find((user) => user.id === client.userId);
    if (linkedUser) await upsertUser(connection, linkedUser, after);
    await upsertClient(connection, client, after);
    await syncClientTags(connection, client);
  }
  await syncAppendOnlyRows(connection, before, after);
}

async function persistBarberMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const barber = result.barber || deletedItem(before.barbers, after.barbers);
    const linkedUser = before.users?.find((user) => user.id === barber?.userId);
    await deleteBarber(connection, barber);
    await deleteUser(connection, linkedUser);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const barber = after.barbers?.find((item) => item.id === result?.barber?.id) ||
    after.barbers?.find((item) => item.id === result?.block?.barberId) ||
    changedItem(before.barbers, after.barbers);
  if (barber) {
    const linkedUser = after.users?.find((user) => user.id === barber.userId);
    if (linkedUser) await upsertUser(connection, linkedUser, after);
    await upsertBarber(connection, barber, after);
    await syncBarberRelations(connection, barber, after);
    await syncBarberServiceLinks(connection, barber, after);
  }
  await syncAppendOnlyRows(connection, before, after);
}

async function persistExpenseMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const expense = result.expense || deletedItem(before.expenses, after.expenses);
    await deleteExpense(connection, expense);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const expense = after.expenses?.find((item) => item.id === result?.expense?.id) ||
    changedItem(before.expenses, after.expenses);
  if (expense) await upsertExpense(connection, expense, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistPromotionMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const promotion = result.promotion || deletedItem(before.promotions, after.promotions);
    await deletePromotion(connection, promotion);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const promotion = after.promotions?.find((item) => item.id === result?.promotion?.id) ||
    changedItem(before.promotions, after.promotions);
  if (promotion) await upsertPromotion(connection, promotion, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistCouponMutation(connection, { before, after, result }) {
  const coupon = after.coupons?.find((item) => item.id === result?.coupon?.id) ||
    changedItem(before.coupons, after.coupons);
  if (coupon) await upsertCoupon(connection, coupon, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistWaitlistMutation(connection, { before, after, result }) {
  if (result?.deleted) {
    const item = result.item || deletedItem(before.waitlist, after.waitlist);
    await deleteWaitlistItem(connection, item);
    await syncAppendOnlyRows(connection, before, after);
    return;
  }

  const item = after.waitlist?.find((entry) => entry.id === result?.item?.id) ||
    changedItem(before.waitlist, after.waitlist);
  if (item) await upsertWaitlistItem(connection, item, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistReviewMutation(connection, { before, after, result }) {
  const review = after.reviews?.find((item) => item.id === result?.review?.id) ||
    changedItem(before.reviews, after.reviews);
  if (review) await upsertReview(connection, review, after);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistAuthMutation(connection, { before, after }) {
  const touchedUsers = changedItems(before.users, after.users);
  const touchedClients = changedItems(before.clients, after.clients);
  const touchedBarbers = changedItems(before.barbers, after.barbers);

  for (const user of touchedUsers) {
    await upsertUser(connection, user, after);
  }

  for (const client of touchedClients) {
    await upsertClient(connection, client, after);
    await syncClientTags(connection, client);
  }

  for (const barber of touchedBarbers) {
    await upsertBarber(connection, barber, after);
    await syncBarberRelations(connection, barber, after);
    await syncBarberServiceLinks(connection, barber, after);
  }

  await syncAppendOnlyRows(connection, before, after);
}

async function persistUserMutation(connection, { before, after }) {
  const touchedUsers = changedItems(before.users, after.users);
  const touchedClients = changedItems(before.clients, after.clients);
  const touchedBarbers = changedItems(before.barbers, after.barbers);

  for (const user of touchedUsers) {
    await upsertUser(connection, user, after);
  }

  for (const client of touchedClients) {
    await upsertClient(connection, client, after);
    await syncClientTags(connection, client);
  }

  for (const barber of touchedBarbers) {
    await upsertBarber(connection, barber, after);
    await syncBarberRelations(connection, barber, after);
    await syncBarberServiceLinks(connection, barber, after);
  }

  await syncAppendOnlyRows(connection, before, after);
}

async function persistTenantMutation(connection, { before, after, result }) {
  const tenantIds = new Set([
    ...(result?.tenant?.id ? [result.tenant.id] : []),
    ...newItems(before.tenants, after.tenants).map((tenant) => tenant.id)
  ]);
  const tenants = uniqueById([
    ...(after.tenants || []).filter((tenant) => tenantIds.has(tenant.id)),
    ...changedItems(before.tenants, after.tenants)
  ]);

  for (const tenant of tenants) {
    await upsertTenant(connection, tenant);
  }

  const tenantIdSet = new Set(tenants.map((tenant) => tenant.id));
  const units = uniqueById([
    ...(after.units || []).filter((unit) => tenantIdSet.has(tenantIdOf(unit, after))),
    ...changedItems(before.units, after.units)
  ]);
  for (const unit of units) {
    await upsertUnit(connection, unit, after);
  }

  const users = uniqueById([
    ...(after.users || []).filter((user) => tenantIdSet.has(tenantIdOf(user, after))),
    ...changedItems(before.users, after.users)
  ]);
  for (const user of users) {
    await upsertUser(connection, user, after);
  }

  for (const tenant of tenants) {
    await upsertTenantSettings(connection, after.settings, after, tenant.id);
    await upsertLoyaltyRules(connection, after.loyaltyRules, after, tenant.id);
  }

  await syncAppendOnlyRows(connection, before, after);
}

async function persistSettingsMutation(connection, { before, after, result }) {
  const tenantId = result?.settings?.tenantId || after.settings?.tenantId || after.meta?.defaultTenantId;
  await upsertTenantSettings(connection, after.settings, after, tenantId);
  await syncAppendOnlyRows(connection, before, after);
}

async function persistAuditOnlyMutation(connection, { before, after }) {
  await syncAppendOnlyRows(connection, before, after);
}

async function persistReconciliationMutation(connection, { before, after, result }) {
  const tenantId = result?.operationalReconciliation?.tenantId || after.operationalReconciliation?.tenantId || after.meta?.defaultTenantId;
  const appointments = changedItems(before.appointments, after.appointments);
  const clientsById = new Map((after.clients || []).map((client) => [client.id, client]));

  for (const appointment of appointments) {
    await upsertAppointment(connection, appointment, after);
    const client = clientsById.get(appointment.clientId);
    if (client) await updateClientCounters(connection, client, after);

    const commission = after.commissions?.find((item) => item.appointmentId === appointment.id);
    if (commission) await upsertCommission(connection, commission, after);
  }

  for (const client of changedItems(before.clients, after.clients)) {
    await updateClientCounters(connection, client, after);
  }

  for (const item of changedItems(before.waitlist, after.waitlist)) {
    await upsertWaitlistItem(connection, item, after);
  }

  await insertNotifications(connection, changedItems(before.notifications, after.notifications), after);
  await upsertOperationalReconciliation(connection, after.operationalReconciliation, after, tenantId);
  await insertReconciliationEvents(
    connection,
    newItems(before.operationalReconciliation?.events || [], after.operationalReconciliation?.events || []),
    after,
    tenantId
  );
  await insertAuditLogs(connection, newItems(before.auditLogs, after.auditLogs), after);
}

module.exports = {
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
  persistReconciliationMutation,
  upsertAppointment,
  upsertCommission,
  updateProduct,
  insertStockMovement
};
