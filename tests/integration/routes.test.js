import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

let app;
const loginCookies = new Map();

function nextOpenDate(settings) {
  for (let offset = 2; offset < 30; offset += 1) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const key = date.toISOString().slice(0, 10);
    const day = settings.businessHours[date.getDay()];
    const holiday = settings.holidays.find((item) => item.date === key);
    if (day && !day.closed && !holiday) return { key, open: day.open };
  }
  throw new Error('Nenhum dia aberto encontrado no seed de teste.');
}

function futureDate(offset = 5) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barberpro-test-'));
  process.env.JWT_SECRET = 'integration-test-secret-with-more-than-forty-eight-characters-123456789';
  process.env.DB_DRIVER = 'json';
  process.env.DATA_FILE = path.join(dir, 'barberpro.json');
  process.env.AUTO_BACKUP_ENABLED = 'false';
  process.env.DEMO_AUTO_RENEW = 'false';
  const store = await import('../../server/store.js');
  const index = await import('../../server/index.js');
  await store.initializeStore();
  app = index.app;
});

async function login(email = 'admin@barberpro.com', password = '123456') {
  const cacheKey = `${email}:${password}`;
  if (loginCookies.has(cacheKey)) return loginCookies.get(cacheKey);

  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  const cookies = response.headers['set-cookie'];
  loginCookies.set(cacheKey, cookies);
  return cookies;
}

describe('POST /api/auth/login', () => {
  it('aceita credenciais validas', async () => {
    const cookies = await login();
    expect(cookies.join(';')).toContain('barberpro_session');
  });

  it('rejeita credenciais invalidas', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@barberpro.com', password: 'senha-errada' })
      .expect(401);
  });

});

describe('POST /api/auth/register', () => {
  it('rejeita senha fraca em cadastro publico', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Cliente Fraco',
        email: 'fraco@example.com',
        phone: '11999999999',
        password: '123456'
      })
      .expect(400);
  });
});

describe('isolamento de dados em endpoints auxiliares', () => {
  it('filtra cupons por cliente nos endpoints diretos', async () => {
    const adminCookies = await login('dono@barberpro.com');
    const brunoCoupon = await request(app)
      .post('/api/coupons')
      .set('Cookie', adminCookies)
      .send({ clientId: 'client_bruno', code: 'BRUNOSEG', discountType: 'fixed', discountValue: 10, expiresAt: futureDate(12) })
      .expect(201);

    const lucasCookies = await login('cliente@barberpro.com');
    const lucasCoupons = await request(app)
      .get('/api/coupons')
      .set('Cookie', lucasCookies)
      .expect(200);
    expect(lucasCoupons.body.coupons.map((coupon) => coupon.id)).not.toContain(brunoCoupon.body.coupon.id);
    expect(lucasCoupons.body.coupons.every((coupon) => coupon.clientId === 'client_lucas')).toBe(true);

    const brunoCookies = await login('bruno@email.com');
    const brunoCoupons = await request(app)
      .get('/api/coupons')
      .set('Cookie', brunoCookies)
      .expect(200);
    expect(brunoCoupons.body.coupons.map((coupon) => coupon.id)).toContain(brunoCoupon.body.coupon.id);
  });

  it('filtra fila de espera por cliente e barbeiro', async () => {
    const lucasCookies = await login('cliente@barberpro.com');
    const lucasWaitlist = await request(app)
      .get('/api/waitlist')
      .set('Cookie', lucasCookies)
      .expect(200);
    expect(lucasWaitlist.body.waitlist.map((item) => item.clientId)).not.toContain('client_vitor');

    const barberCookies = await login('barbeiro@barberpro.com');
    const barberWaitlist = await request(app)
      .get('/api/waitlist')
      .set('Cookie', barberCookies)
      .expect(200);
    expect(barberWaitlist.body.waitlist.every((item) => item.barberId === 'barber_marcos')).toBe(true);
    expect(barberWaitlist.body.waitlist.map((item) => item.id)).toContain('wait_001');

    const adminCookies = await login('dono@barberpro.com');
    const adminWaitlist = await request(app)
      .get('/api/waitlist')
      .set('Cookie', adminCookies)
      .expect(200);
    expect(adminWaitlist.body.waitlist.map((item) => item.id)).toContain('wait_001');
  });

  it('esconde promocoes inativas para perfis nao administrativos', async () => {
    const adminCookies = await login('dono@barberpro.com');
    const inactivePromotion = await request(app)
      .post('/api/promotions')
      .set('Cookie', adminCookies)
      .send({
        title: 'Promocao inativa seguranca',
        description: 'Nao deve aparecer para cliente.',
        code: 'INATIVOSEG',
        discountType: 'percent',
        discountValue: 5,
        startsAt: futureDate(1),
        endsAt: futureDate(10),
        active: false
      })
      .expect(201);

    const clientCookies = await login('cliente@barberpro.com');
    const clientPromotions = await request(app)
      .get('/api/promotions')
      .set('Cookie', clientCookies)
      .expect(200);
    expect(clientPromotions.body.promotions.map((promotion) => promotion.id)).not.toContain(inactivePromotion.body.promotion.id);

    const adminPromotions = await request(app)
      .get('/api/promotions')
      .set('Cookie', adminCookies)
      .expect(200);
    expect(adminPromotions.body.promotions.map((promotion) => promotion.id)).toContain(inactivePromotion.body.promotion.id);
  });
});

describe('recuperacao de senha', () => {
  it('gera token de recuperacao e permite redefinir senha', async () => {
    const recovery = await request(app)
      .post('/api/auth/recover')
      .send({ email: 'cliente@barberpro.com' })
      .expect(200);

    expect(recovery.body.devResetUrl).toBeTruthy();
    const token = new URL(recovery.body.devResetUrl).searchParams.get('token');
    expect(token).toBeTruthy();

    await request(app)
      .post('/api/auth/reset')
      .send({ token, password: 'ClienteNovo123!' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'cliente@barberpro.com', password: 'ClienteNovo123!' })
      .expect(200);
  });
});

describe('seguranca de conta e perfil', () => {
  it('bloqueia painel ate troca de senha provisoria', async () => {
    const adminCookies = await login('dono@barberpro.com');
    await request(app)
      .post('/api/users')
      .set('Cookie', adminCookies)
      .send({
        role: 'attendant',
        name: 'Senha Provisoria',
        email: 'senha-provisoria@example.com',
        phone: '11911112222',
        password: 'SenhaInicial123!'
      })
      .expect(201);

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: 'senha-provisoria@example.com', password: 'SenhaInicial123!' })
      .expect(200);
    const cookies = loginResponse.headers['set-cookie'];
    expect(loginResponse.body.user.mustChangePassword).toBe(true);

    const blocked = await request(app)
      .get('/api/dashboard')
      .set('Cookie', cookies)
      .expect(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookies)
      .send({ currentPassword: 'SenhaInicial123!', password: 'SenhaNova123!' })
      .expect(200);

    await request(app)
      .get('/api/dashboard')
      .set('Cookie', cookies)
      .expect(200);
  });

  it('permite ao cliente atualizar apenas o proprio perfil', async () => {
    const cookies = await login('cliente@barberpro.com');

    const profile = await request(app)
      .patch('/api/profile')
      .set('Cookie', cookies)
      .send({
        name: 'Lucas Perfil',
        phone: '11933334444',
        birthDate: '1994-05-20',
        preferredBarberId: 'barber_marcos'
      })
      .expect(200);

    expect(profile.body.user.name).toBe('Lucas Perfil');
    expect(profile.body.client.name).toBe('Lucas Perfil');
    expect(profile.body.client.preferredBarberId).toBe('barber_marcos');

    await request(app)
      .patch('/api/customers/client_bruno')
      .set('Cookie', cookies)
      .send({ name: 'Tentativa Indevida' })
      .expect(403);
  });

  it('nao envia dados internos de outros barbeiros para barbeiro autenticado', async () => {
    const cookies = await login('barbeiro@barberpro.com');
    const dashboard = await request(app)
      .get('/api/dashboard')
      .set('Cookie', cookies)
      .expect(200);

    const ownBarber = dashboard.body.barbers.find((barber) => barber.id === 'barber_marcos');
    const otherBarber = dashboard.body.barbers.find((barber) => barber.id !== 'barber_marcos');
    expect(ownBarber.commissionRate).toBeDefined();
    expect(otherBarber.commissionRate).toBeUndefined();
    expect(otherBarber.email).toBeUndefined();
  });
});

describe('POST /api/tenants', () => {
  it('cria uma barbearia real com dono inicial e permite login no tenant', async () => {
    const cookies = await login();
    const response = await request(app)
      .post('/api/tenants')
      .set('Cookie', cookies)
      .send({
        name: 'Barbearia Mercado',
        slug: 'barbearia-mercado',
        ownerName: 'Dono Mercado',
        ownerEmail: 'dono-mercado@example.com',
        ownerPhone: '5511999999999',
        ownerPassword: 'SenhaForte123!'
      })
      .expect(201);

    expect(response.body.tenant.slug).toBe('barbearia-mercado');
    expect(response.body.owner.passwordHash).toBeUndefined();

    await request(app)
      .post('/api/auth/login')
      .set('x-tenant-id', 'barbearia-mercado')
      .send({ email: 'dono-mercado@example.com', password: 'SenhaForte123!' })
      .expect(200);
  });
});

describe('rotas de appointments', () => {
  it('cria agendamento, bloqueia conflito e exige autenticacao', async () => {
    const cookies = await login('dono@barberpro.com');
    const dashboard = await request(app)
      .get('/api/dashboard')
      .set('Cookie', cookies)
      .expect(200);
    const { key, open } = nextOpenDate(dashboard.body.settings);
    const body = {
      clientId: 'client_lucas',
      serviceId: 'srv_corte',
      barberId: 'barber_marcos',
      unitId: 'unit_centro',
      date: key,
      startTime: open
    };

    const created = await request(app)
      .post('/api/appointments')
      .set('Cookie', cookies)
      .send(body)
      .expect(201);
    expect(created.body.appointment.id).toBeTruthy();

    await request(app)
      .post('/api/appointments')
      .set('Cookie', cookies)
      .send(body)
      .expect(409);

    await request(app)
      .post('/api/appointments')
      .send(body)
      .expect(401);
  });

  it('altera status valido e rejeita status invalido', async () => {
    const cookies = await login('dono@barberpro.com');
    const dashboard = await request(app)
      .get('/api/dashboard')
      .set('Cookie', cookies)
      .expect(200);
    const appointment = dashboard.body.appointments.find((item) => item.status === 'scheduled' || item.status === 'confirmed');
    expect(appointment).toBeTruthy();

    await request(app)
      .post(`/api/appointments/${appointment.id}/status`)
      .set('Cookie', cookies)
      .send({ status: 'in_service' })
      .expect(200);

    await request(app)
      .post(`/api/appointments/${appointment.id}/status`)
      .set('Cookie', cookies)
      .send({ status: 'invalid_status' })
      .expect(400);
  });
});

describe('CRUD operacional', () => {
  it('cria, atualiza e remove servico, produto e promocao', async () => {
    const cookies = await login('dono@barberpro.com');

    const service = await request(app)
      .post('/api/services')
      .set('Cookie', cookies)
      .send({
        name: 'Servico CRUD',
        description: 'Teste de CRUD',
        price: 75,
        durationMinutes: 40,
        barberIds: ['barber_marcos']
      })
      .expect(201);

    await request(app)
      .patch(`/api/services/${service.body.service.id}`)
      .set('Cookie', cookies)
      .send({ active: false })
      .expect(200);

    await request(app)
      .delete(`/api/services/${service.body.service.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const product = await request(app)
      .post('/api/products')
      .set('Cookie', cookies)
      .send({ name: 'Produto CRUD', category: 'Teste', quantity: 3, purchasePrice: 10, salePrice: 20, minStock: 1 })
      .expect(201);

    await request(app)
      .patch(`/api/products/${product.body.product.id}`)
      .set('Cookie', cookies)
      .send({ salePrice: 25, active: true })
      .expect(200);

    await request(app)
      .post(`/api/products/${product.body.product.id}/movements`)
      .set('Cookie', cookies)
      .send({ type: 'adjustment', quantity: 0, reason: 'Zerar estoque' })
      .expect(201);

    await request(app)
      .delete(`/api/products/${product.body.product.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const promotion = await request(app)
      .post('/api/promotions')
      .set('Cookie', cookies)
      .send({
        title: 'Promo CRUD',
        description: 'Teste',
        code: 'CRUD10',
        discountType: 'percent',
        discountValue: 10,
        startsAt: '2026-05-19',
        endsAt: '2026-05-20'
      })
      .expect(201);

    await request(app)
      .patch(`/api/promotions/${promotion.body.promotion.id}`)
      .set('Cookie', cookies)
      .send({ active: false })
      .expect(200);

    await request(app)
      .delete(`/api/promotions/${promotion.body.promotion.id}`)
      .set('Cookie', cookies)
      .expect(200);
  });

  it('cobre usuarios, barbeiros, clientes, despesas, cupons e fila de espera', async () => {
    const cookies = await login('dono@barberpro.com');

    const user = await request(app)
      .post('/api/users')
      .set('Cookie', cookies)
      .send({
        role: 'attendant',
        name: 'Atendente CRUD',
        email: 'atendente-crud@example.com',
        phone: '11999999990',
        password: 'Atendente123!'
      })
      .expect(201);
    expect(user.body.user.passwordHash).toBeUndefined();

    await request(app)
      .patch(`/api/users/${user.body.user.id}`)
      .set('Cookie', cookies)
      .send({ status: 'inactive' })
      .expect(200);

    await request(app)
      .delete(`/api/users/${user.body.user.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const barber = await request(app)
      .post('/api/barbers')
      .set('Cookie', cookies)
      .send({
        name: 'Barbeiro CRUD',
        email: 'barbeiro-crud@example.com',
        phone: '11988887777',
        createUser: true,
        password: 'Barbeiro123!',
        specialties: ['Fade']
      })
      .expect(201);

    await request(app)
      .patch(`/api/barbers/${barber.body.barber.id}`)
      .set('Cookie', cookies)
      .send({ bio: 'Especialista em testes', status: 'inactive' })
      .expect(200);

    await request(app)
      .delete(`/api/barbers/${barber.body.barber.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const customer = await request(app)
      .post('/api/customers')
      .set('Cookie', cookies)
      .send({ name: 'Cliente CRUD', phone: '11977776666', email: 'cliente-crud@example.com' })
      .expect(201);

    await request(app)
      .patch(`/api/customers/${customer.body.client.id}`)
      .set('Cookie', cookies)
      .send({ notes: 'Cliente validado por teste' })
      .expect(200);

    await request(app)
      .delete(`/api/customers/${customer.body.client.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const expense = await request(app)
      .post('/api/expenses')
      .set('Cookie', cookies)
      .send({ category: 'Teste', description: 'Despesa CRUD', amount: 120, dueDate: futureDate(3) })
      .expect(201);

    await request(app)
      .patch(`/api/expenses/${expense.body.expense.id}`)
      .set('Cookie', cookies)
      .send({ status: 'paid' })
      .expect(200);

    await request(app)
      .delete(`/api/expenses/${expense.body.expense.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const coupon = await request(app)
      .post('/api/coupons')
      .set('Cookie', cookies)
      .send({ clientId: 'client_lucas', code: 'CRUDCUPOM', discountType: 'fixed', discountValue: 15, expiresAt: futureDate(10) })
      .expect(201);

    await request(app)
      .post(`/api/coupons/${coupon.body.coupon.id}/redeem`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    await request(app)
      .delete(`/api/coupons/${coupon.body.coupon.id}`)
      .set('Cookie', cookies)
      .expect(200);

    const waitlist = await request(app)
      .post('/api/waitlist')
      .set('Cookie', cookies)
      .send({ clientId: 'client_lucas', serviceId: 'srv_corte', barberId: 'barber_marcos', preferredDate: futureDate(6), period: 'Tarde' })
      .expect(201);

    await request(app)
      .patch(`/api/waitlist/${waitlist.body.item.id}`)
      .set('Cookie', cookies)
      .send({ status: 'notified' })
      .expect(200);

    await request(app)
      .delete(`/api/waitlist/${waitlist.body.item.id}`)
      .set('Cookie', cookies)
      .expect(200);
  });
});

describe('GET /api/backup', () => {
  it('exporta backup sem hashes ou tokens sensiveis', async () => {
    const cookies = await login('dono@barberpro.com');
    const response = await request(app)
      .get('/api/backup')
      .set('Cookie', cookies)
      .expect(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('passwordResetToken');
    expect(serialized).not.toContain('sessionToken');
  });
});

describe('rate limit de autenticacao', () => {
  it('bloqueia excesso de tentativas por rate limit', async () => {
    let lastResponse;
    for (let index = 0; index < 30; index += 1) {
      lastResponse = await request(app)
        .post('/api/auth/login')
        .send({ email: `rate-${index}@barberpro.test`, password: 'x' });
      if (lastResponse.status === 429) break;
    }
    expect(lastResponse.status).toBe(429);
  });
});
