import { beforeAll, describe, expect, it } from 'vitest';
import scheduler from '../../server/services/scheduler.js';
import appointmentValidator from '../../server/validators/appointment.js';
import mysqlSnapshot from '../../server/adapters/mysqlSnapshot.js';
import mysqlReadModel from '../../server/adapters/mysqlReadModel.js';

const { overlaps } = scheduler;
const { validateSchedule } = appointmentValidator;
const { buildRelationalRows } = mysqlSnapshot;
const { readRelationalData } = mysqlReadModel;

let calculateReports;
let reconcileOperationalData;
let sanitizeUser;

function baseData() {
  return {
    users: [],
    units: [{ id: 'unit_1', name: 'Centro', status: 'active' }],
    clients: [{ id: 'client_1', name: 'Cliente', phone: '11999999999', visits: 0, noShows: 0, loyaltyPoints: 0 }],
    barbers: [
      {
        id: 'barber_1',
        name: 'Barbeiro',
        status: 'active',
        unitIds: ['unit_1'],
        commissionRate: 0.4,
        rating: 5,
        goalMonthly: 1000,
        blocks: []
      }
    ],
    services: [
      {
        id: 'srv_1',
        name: 'Corte',
        price: 60,
        durationMinutes: 45,
        barberIds: ['barber_1'],
        active: true
      }
    ],
    appointments: [],
    payments: [],
    commissions: [],
    reviews: [],
    products: [],
    stockMovements: [],
    expenses: [],
    notifications: [],
    waitlist: [],
    auditLogs: [],
    loyaltyRules: { pointsPerCurrency: 1 },
    settings: {
      holidays: [],
      appointmentRules: { slotIntervalMinutes: 30 },
      businessHours: {
        0: { label: 'Domingo', closed: true, open: '09:00', close: '18:00' },
        1: { label: 'Segunda', closed: false, open: '09:00', close: '18:00' },
        2: { label: 'Terca', closed: false, open: '09:00', close: '18:00' },
        3: { label: 'Quarta', closed: false, open: '09:00', close: '18:00' },
        4: { label: 'Quinta', closed: false, open: '09:00', close: '18:00' },
        5: { label: 'Sexta', closed: false, open: '09:00', close: '18:00' },
        6: { label: 'Sabado', closed: false, open: '09:00', close: '18:00' }
      }
    }
  };
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'unit-test-secret-with-more-than-forty-eight-characters-123456789';
  process.env.DB_DRIVER = 'json';
  process.env.AUTO_BACKUP_ENABLED = 'false';
  const index = await import('../../server/index.js');
  const store = await import('../../server/store.js');
  calculateReports = index.calculateReports;
  reconcileOperationalData = index.reconcileOperationalData;
  sanitizeUser = store.sanitizeUser;
});

describe('overlaps', () => {
  it('detecta sobreposicao real e libera bordas encostadas', () => {
    expect(overlaps('09:00', '10:00', '09:30', '10:30')).toBe(true);
    expect(overlaps('09:00', '10:00', '10:00', '11:00')).toBe(false);
    expect(overlaps('10:00', '11:00', '09:00', '10:00')).toBe(false);
    expect(overlaps('09:00', '12:00', '10:00', '11:00')).toBe(true);
  });
});

describe('validateSchedule', () => {
  it('bloqueia conflito de horario', () => {
    const data = baseData();
    data.appointments.push({
      id: 'apt_1',
      barberId: 'barber_1',
      clientId: 'client_1',
      serviceId: 'srv_1',
      unitId: 'unit_1',
      date: '2026-05-19',
      startTime: '09:00',
      endTime: '09:45',
      status: 'scheduled'
    });
    const result = validateSchedule(data, {
      clientId: 'client_1',
      barberId: 'barber_1',
      serviceId: 'srv_1',
      unitId: 'unit_1',
      date: '2026-05-19',
      startTime: '09:30'
    }, { allowPast: true });
    expect(result.ok).toBe(false);
    expect(result.conflict.id).toBe('apt_1');
  });

  it('bloqueia barbeiro inativo, servico inativo e horario fora do expediente', () => {
    const data = baseData();
    data.barbers[0].status = 'inactive';
    expect(validateSchedule(data, {
      clientId: 'client_1',
      barberId: 'barber_1',
      serviceId: 'srv_1',
      unitId: 'unit_1',
      date: '2026-05-19',
      startTime: '09:00'
    }, { allowPast: true }).ok).toBe(false);

    data.barbers[0].status = 'active';
    data.services[0].active = false;
    expect(validateSchedule(data, {
      clientId: 'client_1',
      barberId: 'barber_1',
      serviceId: 'srv_1',
      unitId: 'unit_1',
      date: '2026-05-19',
      startTime: '09:00'
    }, { allowPast: true }).ok).toBe(false);

    data.services[0].active = true;
    expect(validateSchedule(data, {
      clientId: 'client_1',
      barberId: 'barber_1',
      serviceId: 'srv_1',
      unitId: 'unit_1',
      date: '2026-05-19',
      startTime: '18:00'
    }, { allowPast: true }).ok).toBe(false);
  });
});

describe('calculateReports', () => {
  it('retorna KPIs zerados sem dados financeiros', () => {
    const reports = calculateReports(baseData());
    expect(reports.kpis.revenueToday).toBe(0);
    expect(reports.kpis.totalRevenue).toBe(0);
    expect(reports.kpis.averageTicket).toBe(0);
  });

  it('calcula receita, ticket medio e ranking com dados reais', () => {
    const data = baseData();
    data.appointments.push({
      id: 'apt_1',
      barberId: 'barber_1',
      clientId: 'client_1',
      serviceId: 'srv_1',
      date: new Date().toISOString().slice(0, 10),
      startTime: '10:00',
      endTime: '10:45',
      status: 'finished'
    });
    const reports = calculateReports(data);
    expect(reports.kpis.totalRevenue).toBe(60);
    expect(reports.kpis.averageTicket).toBe(60);
    expect(reports.serviceRanking[0].name).toBe('Corte');
  });
});

describe('reconcileOperationalData', () => {
  it('finaliza automaticamente atendimento em andamento vencido', () => {
    const data = baseData();
    data.appointments.push({
      id: 'apt_1',
      code: 'BP-1',
      barberId: 'barber_1',
      clientId: 'client_1',
      serviceId: 'srv_1',
      date: '2026-05-19',
      startTime: '09:00',
      endTime: '09:45',
      status: 'in_service'
    });
    const result = reconcileOperationalData(data, {
      nowDate: new Date('2026-05-19T12:00:00'),
      user: { id: 'system', role: 'admin' }
    });
    expect(result.updated).toBe(true);
    expect(data.appointments[0].status).toBe('finished');
    expect(data.payments).toHaveLength(0);
  });
});

describe('sanitizeUser', () => {
  it('nunca retorna hashes ou tokens sensiveis', () => {
    const user = sanitizeUser({
      id: 'usr_1',
      name: 'Admin',
      passwordHash: 'hash',
      passwordResetToken: 'reset',
      resetToken: 'reset2',
      sessionToken: 'session'
    });
    expect(user).toEqual({ id: 'usr_1', name: 'Admin' });
  });
});

describe('buildRelationalRows', () => {
  it('materializa entidades operacionais que antes ficavam apenas no app_state', () => {
    const data = baseData();
    data.tenants = [{ id: 'tenant_demo', name: 'Demo', slug: 'demo', status: 'active' }];
    data.users.push({
      id: 'usr_1',
      tenantId: 'tenant_demo',
      role: 'client',
      name: 'Cliente',
      email: 'cliente@example.com',
      passwordHash: 'hash',
      status: 'active',
      clientId: 'client_1'
    });
    data.clients[0].tenantId = 'tenant_demo';
    data.clients[0].userId = null;
    data.units[0].tenantId = 'tenant_demo';
    data.barbers[0].tenantId = 'tenant_demo';
    data.services[0].tenantId = 'tenant_demo';
    data.products.push({
      id: 'prd_1',
      tenantId: 'tenant_demo',
      name: 'Pomada',
      category: 'Finalizacao',
      quantity: 0,
      purchasePrice: 10,
      salePrice: 25,
      minStock: 1,
      active: true
    });
    data.stockMovements.push({
      id: 'mov_1',
      tenantId: 'tenant_demo',
      productId: 'prd_1',
      type: 'adjustment',
      quantity: 0,
      unitValue: 0
    });
    data.promotions = [{
      id: 'promo_1',
      tenantId: 'tenant_demo',
      title: 'Cupom',
      code: 'CUPOM10',
      discountType: 'percent',
      discountValue: 10,
      startsAt: '2026-05-19',
      endsAt: '2026-05-20',
      active: true
    }];
    data.notifications.push({
      id: 'ntf_1',
      tenantId: 'tenant_demo',
      userId: 'usr_1',
      channel: 'whatsapp',
      title: 'Aviso',
      message: 'Mensagem',
      status: 'queued'
    });
    data.loyaltyRules.rewards = [{ id: 'reward_1', name: 'Desconto', points: 100, discountValue: 10 }];

    const rows = buildRelationalRows(data);

    expect(rows.tenants).toHaveLength(1);
    expect(rows.users).toHaveLength(1);
    expect(rows.clients[0][2]).toBe('usr_1');
    expect(rows.products).toHaveLength(1);
    expect(rows.stockMovements[0][5]).toBe(0);
    expect(rows.promotions).toHaveLength(1);
    expect(rows.notifications).toHaveLength(1);
    expect(rows.settings).toHaveLength(1);
    expect(rows.loyaltyRewards).toHaveLength(1);
  });
});

describe('readRelationalData', () => {
  it('reconstroi o contrato operacional a partir das tabelas MySQL', async () => {
    const tableRows = {
      tenants: [{ id: 'tenant_demo', name: 'Demo', slug: 'demo', status: 'active', created_at: '2026-05-19 09:00:00' }],
      units: [{ id: 'unit_1', tenant_id: 'tenant_demo', name: 'Centro', status: 'active' }],
      users: [{
        id: 'usr_client',
        tenant_id: 'tenant_demo',
        role: 'client',
        name: 'Cliente',
        email: 'cliente@example.com',
        phone: '11999999999',
        password_hash: 'hash',
        must_change_password: 0,
        status: 'active',
        created_at: '2026-05-19 09:00:00'
      }],
      clients: [{
        id: 'client_1',
        tenant_id: 'tenant_demo',
        user_id: 'usr_client',
        name: 'Cliente',
        phone: '11999999999',
        loyalty_points: 10,
        visits: 2,
        no_shows: 0
      }],
      client_tags: [{ client_id: 'client_1', tag: 'vip' }],
      barbers: [{
        id: 'barber_1',
        tenant_id: 'tenant_demo',
        name: 'Barbeiro',
        commission_rate: '0.4000',
        rating: '5.00',
        goal_monthly: '1000.00',
        status: 'active'
      }],
      barber_specialties: [{ barber_id: 'barber_1', specialty: 'Corte' }],
      barber_units: [{ barber_id: 'barber_1', unit_id: 'unit_1' }],
      services: [{
        id: 'srv_1',
        tenant_id: 'tenant_demo',
        name: 'Corte',
        price: '60.00',
        duration_minutes: 45,
        active: 1
      }],
      service_barbers: [{ service_id: 'srv_1', barber_id: 'barber_1' }],
      appointments: [{
        id: 'apt_1',
        tenant_id: 'tenant_demo',
        code: 'BP-1',
        unit_id: 'unit_1',
        client_id: 'client_1',
        barber_id: 'barber_1',
        service_id: 'srv_1',
        appointment_date: '2026-05-19',
        start_time: '09:00:00',
        end_time: '09:45:00',
        status: 'scheduled',
        is_fit_in: 0
      }],
      tenant_settings: [{
        tenant_id: 'tenant_demo',
        settings_json: JSON.stringify({ tenantId: 'tenant_demo', currency: 'BRL', businessHours: {} })
      }],
      loyalty_rules: [{
        tenant_id: 'tenant_demo',
        points_per_currency: '1.00',
        points_per_referral: 120,
        birthday_coupon_value: '25.00',
        rules_json: JSON.stringify({ pointsPerCurrency: 1 })
      }],
      loyalty_rewards: [{ id: 'reward_1', tenant_id: 'tenant_demo', name: 'Desconto', points: 100, discount_value: '10.00' }],
      operational_reconciliation: [{
        tenant_id: 'tenant_demo',
        rule_version: 'v1',
        state_json: JSON.stringify({ ruleVersion: 'v1', events: [] })
      }],
      operational_reconciliation_events: [{
        id: 'evt_1',
        tenant_id: 'tenant_demo',
        rule_key: 'expired_coupon',
        entity: 'coupon',
        entity_id: 'cupom_1',
        created_at: '2026-05-19 09:00:00'
      }]
    };
    const pool = {
      execute: async () => [[{ data: JSON.stringify({ meta: { defaultTenantId: 'tenant_demo' } }) }]],
      query: async (sql) => {
        const table = sql.match(/FROM\s+([a-z_]+)/i)?.[1];
        return [tableRows[table] || []];
      }
    };

    const data = await readRelationalData(pool);

    expect(data.meta.defaultTenantId).toBe('tenant_demo');
    expect(data.users[0].clientId).toBe('client_1');
    expect(data.clients[0].tags).toEqual(['vip']);
    expect(data.barbers[0].unitIds).toEqual(['unit_1']);
    expect(data.services[0].barberIds).toEqual(['barber_1']);
    expect(data.appointments[0].date).toBe('2026-05-19');
    expect(data.appointments[0].startTime).toBe('09:00');
    expect(data.loyaltyRules.rewards[0].id).toBe('reward_1');
    expect(data.operationalReconciliation.events[0].key).toBe('expired_coupon');
  });
});
