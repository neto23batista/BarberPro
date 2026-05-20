const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  applyRelationalSchema,
  persistSnapshot: persistMysqlSnapshot
} = require('./adapters/mysqlSnapshot');
const { readRelationalData } = require('./adapters/mysqlReadModel');

const dataFile = path.resolve(process.cwd(), process.env.DATA_FILE || path.join('data', 'barberpro.json'));
const MYSQL_STATE_ID = 'barberpro';
const APP_VERSION = '1.0.0';
const DEMO_DATASET_ID = 'barberpro-demo';
const DEMO_SEED_VERSION = 2;
const DEMO_RESET_CONFIRMATION = 'RESTAURAR DEMO';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'tenant_demo';
const requestedDriver = String(process.env.DB_DRIVER || 'json').toLowerCase() === 'mysql' ? 'mysql' : 'json';
let memoryData = null;
let storageMode = 'json';
let mysqlPool = null;
let mysqlConfig = null;
let persistQueue = Promise.resolve();
let storeState = {
  requestedMode: requestedDriver,
  mode: 'json',
  status: 'booting',
  writable: false,
  readOnly: true,
  fallbackMode: null,
  file: dataFile,
  database: null,
  host: null,
  port: null,
  message: 'Persistencia inicializando.',
  lastError: null,
  lastErrorAt: null,
  lastPersistedAt: null,
  recoveredAt: null,
  demo: null
};

class PersistenceUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PersistenceUnavailableError';
    this.code = 'PERSISTENCE_UNAVAILABLE';
    this.statusCode = 503;
    this.cause = cause;
  }
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function dateKeyFromDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(offset, baseDate = new Date()) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + offset);
  return dateKeyFromDate(date);
}

function isoNow(date = new Date()) {
  return new Date(date).toISOString();
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function tenantId() {
  return DEFAULT_TENANT_ID;
}

function tenantScopedCollections() {
  return [
    'users',
    'units',
    'clients',
    'barbers',
    'services',
    'appointments',
    'payments',
    'commissions',
    'reviews',
    'products',
    'stockMovements',
    'expenses',
    'promotions',
    'coupons',
    'waitlist',
    'notifications',
    'auditLogs'
  ];
}

function normalizeTenantData(data) {
  if (!data || typeof data !== 'object') return data;
  const defaultTenantId = data.meta?.defaultTenantId || DEFAULT_TENANT_ID;
  data.meta = {
    ...(data.meta || {}),
    defaultTenantId
  };
  for (const collection of tenantScopedCollections()) {
    if (!Array.isArray(data[collection])) data[collection] = [];
  }
  data.tenants = Array.isArray(data.tenants) && data.tenants.length
    ? data.tenants
    : [
        {
          id: defaultTenantId,
          name: process.env.DEFAULT_TENANT_NAME || 'BarberPro',
          slug: process.env.DEFAULT_TENANT_SLUG || 'barberpro',
          status: 'active',
          createdAt: data.meta.generatedAt || isoNow()
        }
      ];

  for (const collection of tenantScopedCollections()) {
    if (!Array.isArray(data[collection])) continue;
    data[collection] = data[collection].map((item) => ({
      tenantId: item.tenantId || defaultTenantId,
      ...item,
      tenantId: item.tenantId || defaultTenantId
    }));
  }

  if (data.settings && !data.settings.tenantId) data.settings.tenantId = defaultTenantId;
  data.loyaltyRules = {
    pointsPerCurrency: 1,
    pointsPerReferral: 120,
    birthdayCouponValue: 25,
    rewards: [],
    ...(data.loyaltyRules || {})
  };
  return data;
}

function requireProductionAdminConfig() {
  const email = String(process.env.FIRST_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.FIRST_ADMIN_PASSWORD || '');
  const name = String(process.env.FIRST_ADMIN_NAME || 'Administrador').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('FIRST_ADMIN_EMAIL valido e obrigatorio para inicializar producao sem usuarios demo.');
  }
  if (password.length < 12) {
    throw new Error('FIRST_ADMIN_PASSWORD precisa ter pelo menos 12 caracteres para producao.');
  }
  return { email, password, name };
}

function createProductionInitialData(options = {}) {
  const now = options.generatedAt ? isoNow(options.generatedAt) : isoNow();
  const admin = requireProductionAdminConfig();
  const defaultTenantId = DEFAULT_TENANT_ID;
  const passwordHash = bcrypt.hashSync(admin.password, 12);

  return normalizeTenantData({
    meta: {
      version: APP_VERSION,
      dataset: 'barberpro-production',
      seedVersion: DEMO_SEED_VERSION,
      generatedAt: now,
      generatedForDate: dateKeyFromDate(new Date(now)),
      defaultTenantId
    },
    tenants: [
      {
        id: defaultTenantId,
        name: process.env.DEFAULT_TENANT_NAME || 'BarberPro',
        slug: process.env.DEFAULT_TENANT_SLUG || 'barberpro',
        status: 'active',
        createdAt: now
      }
    ],
    users: [
      {
        id: 'usr_admin',
        tenantId: defaultTenantId,
        role: 'admin',
        name: admin.name,
        email: admin.email,
        phone: process.env.FIRST_ADMIN_PHONE || '',
        passwordHash,
        mustChangePassword: true,
        status: 'active',
        avatar: '',
        createdAt: now
      }
    ],
    units: [
      {
        id: 'unit_main',
        tenantId: defaultTenantId,
        name: process.env.DEFAULT_UNIT_NAME || 'Unidade principal',
        phone: process.env.DEFAULT_UNIT_PHONE || '',
        whatsapp: process.env.WHATSAPP_NUMBER || '',
        email: process.env.DEFAULT_UNIT_EMAIL || admin.email,
        address: process.env.DEFAULT_UNIT_ADDRESS || '',
        status: 'active'
      }
    ],
    clients: [],
    barbers: [],
    services: [],
    appointments: [],
    payments: [],
    commissions: [],
    reviews: [],
    products: [],
    stockMovements: [],
    expenses: [],
    promotions: [],
    coupons: [],
    waitlist: [],
    notifications: [],
    loyaltyRules: {
      pointsPerCurrency: 1,
      pointsPerReferral: 120,
      birthdayCouponValue: 25,
      rewards: []
    },
    settings: {
      tenantId: defaultTenantId,
      barbershopName: process.env.DEFAULT_TENANT_NAME || 'BarberPro',
      defaultUnitId: 'unit_main',
      timezone: process.env.APP_TIMEZONE || 'America/Sao_Paulo',
      currency: 'BRL',
      whatsappNumber: process.env.WHATSAPP_NUMBER || '',
      appointmentRules: {
        slotIntervalMinutes: 30,
        reminderMinutesBefore: 120,
        cancellationLimitHours: 3,
        allowClientReschedule: true
      },
      security: {
        sessionMinutes: 480,
        minPasswordLength: 8,
        auditImportantActions: true,
        lgpdConsentRequired: true
      },
      businessHours: {
        0: { label: 'Domingo', open: '10:00', close: '14:00', closed: true },
        1: { label: 'Segunda', open: '09:00', close: '18:00', closed: false },
        2: { label: 'Terca', open: '09:00', close: '18:00', closed: false },
        3: { label: 'Quarta', open: '09:00', close: '18:00', closed: false },
        4: { label: 'Quinta', open: '09:00', close: '18:00', closed: false },
        5: { label: 'Sexta', open: '09:00', close: '18:00', closed: false },
        6: { label: 'Sabado', open: '08:00', close: '14:00', closed: false }
      },
      holidays: []
    },
    auditLogs: [
      {
        id: 'log_001',
        tenantId: defaultTenantId,
        userId: 'system',
        action: 'system_production_seeded',
        entity: 'system',
        entityId: 'barberpro',
        details: 'Base inicial de producao criada sem usuarios demo.',
        createdAt: now,
        ip: 'local'
      }
    ]
  });
}

function getMysqlConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: validateDatabaseName(process.env.DB_NAME || 'barberpro'),
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 2000)
  };
}

function fallbackToReadonlyJsonEnabled() {
  const value = String(process.env.DB_FALLBACK_TO_JSON || 'readonly').toLowerCase();
  return !['false', '0', 'off', 'no'].includes(value);
}

function setStoreState(patch) {
  storeState = {
    ...storeState,
    ...patch
  };
  return getStoreInfo();
}

function getStoreInfo() {
  return { ...storeState };
}

function markJsonHealthy() {
  return setStoreState({
    requestedMode: requestedDriver,
    mode: 'json',
    status: 'healthy',
    writable: true,
    readOnly: false,
    fallbackMode: null,
    file: dataFile,
    database: null,
    host: null,
    port: null,
    message: 'JSON local ativo.',
    lastError: null
  });
}

function markMysqlHealthy(config = mysqlConfig) {
  return setStoreState({
    requestedMode: 'mysql',
    mode: 'mysql',
    status: 'healthy',
    writable: true,
    readOnly: false,
    fallbackMode: null,
    file: dataFile,
    database: config?.database || null,
    host: config?.host || null,
    port: config?.port || null,
    message: 'MySQL ativo. JSON e usado apenas como seed/backup manual.',
    lastError: null,
    recoveredAt: isoNow()
  });
}

function markMysqlUnavailable(error, fallbackMode = null) {
  return setStoreState({
    requestedMode: 'mysql',
    mode: 'mysql',
    status: 'degraded',
    writable: false,
    readOnly: true,
    fallbackMode,
    file: dataFile,
    database: mysqlConfig?.database || process.env.DB_NAME || 'barberpro',
    host: mysqlConfig?.host || process.env.DB_HOST || '127.0.0.1',
    port: mysqlConfig?.port || Number(process.env.DB_PORT || 3306),
    message: 'MySQL indisponivel. Escritas bloqueadas para evitar divergencia entre MySQL e JSON.',
    lastError: error?.message || String(error || 'Erro desconhecido.'),
    lastErrorAt: isoNow()
  });
}

function persistenceUnavailableError(cause) {
  const info = getStoreInfo();
  const suffix = info.fallbackMode === 'json-readonly'
    ? ' A API esta usando o JSON local apenas para leitura.'
    : '';
  return new PersistenceUnavailableError(
    `${info.message} Ligue o MySQL do XAMPP e tente novamente.${suffix}`,
    cause
  );
}

function runSerialized(operation) {
  const run = persistQueue.then(operation, operation);
  persistQueue = run.catch(() => {});
  return run;
}

function createInitialData(options = {}) {
  if (IS_PRODUCTION && options.production !== false) {
    return createProductionInitialData(options);
  }

  const now = options.generatedAt ? isoNow(options.generatedAt) : isoNow();
  const seedBaseDate = options.baseDate ? new Date(options.baseDate) : new Date(now);
  const seedYear = seedBaseDate.getUTCFullYear();
  const addSeedDays = (offset) => addDays(offset, seedBaseDate);
  const passwordHash = options.passwordHash || bcrypt.hashSync('123456', 10);
  const users = [
    {
      id: 'usr_admin',
      role: 'admin',
      name: 'Administrador Geral',
      email: 'admin@barberpro.com',
      phone: '(11) 90000-0001',
      passwordHash,
      status: 'active',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_owner',
      role: 'owner',
      name: 'Rafael Dono',
      email: 'dono@barberpro.com',
      phone: '(11) 90000-0002',
      passwordHash,
      status: 'active',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_attendant',
      role: 'attendant',
      name: 'Lia Atendimento',
      email: 'atendente@barberpro.com',
      phone: '(11) 90000-0003',
      passwordHash,
      status: 'active',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_barber_marcos',
      role: 'barber',
      name: 'Marcos Navalha',
      email: 'barbeiro@barberpro.com',
      phone: '(11) 91111-1001',
      passwordHash,
      status: 'active',
      barberId: 'barber_marcos',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_barber_ricardo',
      role: 'barber',
      name: 'Ricardo Fade',
      email: 'ricardo@barberpro.com',
      phone: '(11) 91111-1002',
      passwordHash,
      status: 'active',
      barberId: 'barber_ricardo',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_client_lucas',
      role: 'client',
      name: 'Lucas Andrade',
      email: 'cliente@barberpro.com',
      phone: '(11) 95555-0101',
      passwordHash,
      status: 'active',
      clientId: 'client_lucas',
      birthDate: '1994-08-14',
      avatar: '',
      createdAt: now
    },
    {
      id: 'usr_client_bruno',
      role: 'client',
      name: 'Bruno Martins',
      email: 'bruno@email.com',
      phone: '(11) 95555-0102',
      passwordHash,
      status: 'active',
      clientId: 'client_bruno',
      birthDate: '1988-05-21',
      avatar: '',
      createdAt: now
    }
  ];

  return {
    meta: {
      version: APP_VERSION,
      dataset: DEMO_DATASET_ID,
      seedVersion: DEMO_SEED_VERSION,
      generatedAt: now,
      generatedForDate: dateKeyFromDate(seedBaseDate)
    },
    users,
    units: [
      {
        id: 'unit_centro',
        name: 'BarberPro Centro',
        phone: '(11) 3333-3333',
        whatsapp: process.env.WHATSAPP_NUMBER || '5511999999999',
        email: 'contato@barberpro.com',
        address: 'Rua Augusta, 1000 - Centro, Sao Paulo - SP',
        status: 'active'
      },
      {
        id: 'unit_vila',
        name: 'BarberPro Vila Premium',
        phone: '(11) 3333-4444',
        whatsapp: process.env.WHATSAPP_NUMBER || '5511999999999',
        email: 'vila@barberpro.com',
        address: 'Av. Brasil, 820 - Sao Paulo - SP',
        status: 'active'
      }
    ],
    clients: [
      {
        id: 'client_lucas',
        userId: 'usr_client_lucas',
        name: 'Lucas Andrade',
        phone: '(11) 95555-0101',
        email: 'cliente@barberpro.com',
        birthDate: '1994-08-14',
        loyaltyPoints: 340,
        visits: 11,
        noShows: 0,
        preferredBarberId: 'barber_marcos',
        notes: 'Prefere corte baixo nas laterais e barba alinhada.',
        tags: ['premium', 'cliente frequente'],
        createdAt: now
      },
      {
        id: 'client_bruno',
        userId: 'usr_client_bruno',
        name: 'Bruno Martins',
        phone: '(11) 95555-0102',
        email: 'bruno@email.com',
        birthDate: '1988-05-21',
        loyaltyPoints: 180,
        visits: 6,
        noShows: 1,
        preferredBarberId: 'barber_ricardo',
        notes: 'Gosta de pigmentacao leve na barba.',
        tags: ['barba', 'pix'],
        createdAt: now
      },
      {
        id: 'client_vitor',
        userId: null,
        name: 'Vitor Sales',
        phone: '(11) 95555-0103',
        email: 'vitor@email.com',
        birthDate: '1999-12-02',
        loyaltyPoints: 90,
        visits: 3,
        noShows: 0,
        preferredBarberId: 'barber_caio',
        notes: 'Cliente veio por indicacao.',
        tags: ['indicacao'],
        createdAt: now
      }
    ],
    barbers: [
      {
        id: 'barber_marcos',
        userId: 'usr_barber_marcos',
        name: 'Marcos Navalha',
        phone: '(11) 91111-1001',
        email: 'barbeiro@barberpro.com',
        bio: 'Especialista em degradê, navalhado e finalização premium.',
        specialties: ['Degradê', 'Barba', 'Corte + barba'],
        commissionRate: 0.45,
        rating: 4.9,
        goalMonthly: 18000,
        unitIds: ['unit_centro'],
        status: 'active',
        blocks: [
          {
            id: 'block_marcos_almoco',
            date: addSeedDays(1),
            startTime: '12:00',
            endTime: '13:00',
            reason: 'Intervalo'
          }
        ]
      },
      {
        id: 'barber_ricardo',
        userId: 'usr_barber_ricardo',
        name: 'Ricardo Fade',
        phone: '(11) 91111-1002',
        email: 'ricardo@barberpro.com',
        bio: 'Focado em cortes modernos, pigmentação e relaxamento.',
        specialties: ['Pigmentação', 'Luzes', 'Relaxamento'],
        commissionRate: 0.42,
        rating: 4.8,
        goalMonthly: 16000,
        unitIds: ['unit_centro', 'unit_vila'],
        status: 'active',
        blocks: []
      },
      {
        id: 'barber_caio',
        userId: null,
        name: 'Caio Premium',
        phone: '(11) 91111-1003',
        email: 'caio@barberpro.com',
        bio: 'Atendimento consultivo para combos premium e corte infantil.',
        specialties: ['Combo premium', 'Corte infantil', 'Sobrancelha'],
        commissionRate: 0.4,
        rating: 4.7,
        goalMonthly: 14000,
        unitIds: ['unit_vila'],
        status: 'active',
        blocks: []
      }
    ],
    services: [
      {
        id: 'srv_corte',
        name: 'Corte masculino',
        description: 'Corte completo com consultoria de estilo, lavagem e finalização.',
        price: 60,
        durationMinutes: 45,
        icon: 'Scissors',
        color: '#d5a84f',
        barberIds: ['barber_marcos', 'barber_ricardo', 'barber_caio'],
        active: true
      },
      {
        id: 'srv_barba',
        name: 'Barba',
        description: 'Toalha quente, alinhamento com navalha e hidratação.',
        price: 45,
        durationMinutes: 35,
        icon: 'Sparkles',
        color: '#9e1b32',
        barberIds: ['barber_marcos', 'barber_ricardo'],
        active: true
      },
      {
        id: 'srv_corte_barba',
        name: 'Corte + barba',
        description: 'Combo clássico com corte, barba e acabamento premium.',
        price: 95,
        durationMinutes: 75,
        icon: 'Gem',
        color: '#1c345c',
        barberIds: ['barber_marcos', 'barber_ricardo', 'barber_caio'],
        active: true
      },
      {
        id: 'srv_sobrancelha',
        name: 'Sobrancelha',
        description: 'Design masculino rápido e alinhado ao rosto.',
        price: 25,
        durationMinutes: 20,
        icon: 'Eye',
        color: '#d5a84f',
        barberIds: ['barber_caio', 'barber_marcos'],
        active: true
      },
      {
        id: 'srv_pigmentacao',
        name: 'Pigmentação',
        description: 'Correção e realce de falhas com acabamento natural.',
        price: 70,
        durationMinutes: 50,
        icon: 'Paintbrush',
        color: '#9e1b32',
        barberIds: ['barber_ricardo'],
        active: true
      },
      {
        id: 'srv_luzes',
        name: 'Luzes',
        description: 'Clareamento técnico com avaliação prévia.',
        price: 140,
        durationMinutes: 120,
        icon: 'Sun',
        color: '#d5a84f',
        barberIds: ['barber_ricardo'],
        active: true
      },
      {
        id: 'srv_relaxamento',
        name: 'Relaxamento',
        description: 'Tratamento para redução de volume e definição.',
        price: 110,
        durationMinutes: 90,
        icon: 'Waves',
        color: '#1c345c',
        barberIds: ['barber_ricardo'],
        active: true
      },
      {
        id: 'srv_hidratacao',
        name: 'Hidratação',
        description: 'Reposição capilar com finalização profissional.',
        price: 55,
        durationMinutes: 40,
        icon: 'Droplets',
        color: '#1c345c',
        barberIds: ['barber_marcos', 'barber_ricardo'],
        active: true
      },
      {
        id: 'srv_acabamento',
        name: 'Acabamento',
        description: 'Pezinho, laterais e acabamento de barba.',
        price: 30,
        durationMinutes: 25,
        icon: 'BadgeCheck',
        color: '#d5a84f',
        barberIds: ['barber_marcos', 'barber_caio'],
        active: true
      },
      {
        id: 'srv_infantil',
        name: 'Corte infantil',
        description: 'Atendimento ágil, confortável e seguro para crianças.',
        price: 50,
        durationMinutes: 40,
        icon: 'Smile',
        color: '#9e1b32',
        barberIds: ['barber_caio'],
        active: true
      },
      {
        id: 'srv_combo_premium',
        name: 'Combo premium',
        description: 'Corte, barba, sobrancelha, hidratação e finalização especial.',
        price: 155,
        durationMinutes: 120,
        icon: 'Crown',
        color: '#d5a84f',
        barberIds: ['barber_marcos', 'barber_caio'],
        active: true
      }
    ],
    appointments: [
      {
        id: 'apt_001',
        code: 'BP-1001',
        clientId: 'client_lucas',
        barberId: 'barber_marcos',
        serviceId: 'srv_corte_barba',
        unitId: 'unit_centro',
        date: addSeedDays(0),
        startTime: '10:00',
        endTime: '11:15',
        status: 'confirmed',
        notes: 'Cliente pediu lembrete no WhatsApp.',
        internalNotes: 'Oferecer pomada matte.',
        isFitIn: false,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'apt_002',
        code: 'BP-1002',
        clientId: 'client_bruno',
        barberId: 'barber_ricardo',
        serviceId: 'srv_pigmentacao',
        unitId: 'unit_centro',
        date: addSeedDays(0),
        startTime: '14:00',
        endTime: '14:50',
        status: 'scheduled',
        notes: '',
        internalNotes: 'Verificar alergia antes do produto.',
        isFitIn: false,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'apt_003',
        code: 'BP-1003',
        clientId: 'client_vitor',
        barberId: 'barber_caio',
        serviceId: 'srv_combo_premium',
        unitId: 'unit_vila',
        date: addSeedDays(1),
        startTime: '16:00',
        endTime: '18:00',
        status: 'scheduled',
        notes: 'Veio por indicacao do Lucas.',
        internalNotes: '',
        isFitIn: false,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'apt_004',
        code: 'BP-0998',
        clientId: 'client_lucas',
        barberId: 'barber_marcos',
        serviceId: 'srv_corte',
        unitId: 'unit_centro',
        date: addSeedDays(-4),
        startTime: '09:00',
        endTime: '09:45',
        status: 'finished',
        notes: '',
        internalNotes: '',
        isFitIn: false,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'apt_005',
        code: 'BP-0997',
        clientId: 'client_bruno',
        barberId: 'barber_ricardo',
        serviceId: 'srv_barba',
        unitId: 'unit_centro',
        date: addSeedDays(-7),
        startTime: '18:00',
        endTime: '18:35',
        status: 'no_show',
        notes: '',
        internalNotes: 'Registrar falta.',
        isFitIn: false,
        createdAt: now,
        updatedAt: now
      }
    ],
    payments: [],
    commissions: [
      {
        id: 'com_001',
        appointmentId: 'apt_004',
        barberId: 'barber_marcos',
        amount: 27,
        rate: 0.45,
        status: 'available',
        date: addSeedDays(-4)
      }
    ],
    reviews: [
      {
        id: 'rev_001',
        appointmentId: 'apt_004',
        clientId: 'client_lucas',
        barberId: 'barber_marcos',
        rating: 5,
        comment: 'Atendimento excelente e pontual.',
        createdAt: addSeedDays(-4)
      }
    ],
    products: [
      {
        id: 'prd_pomada',
        name: 'Pomada Matte Premium',
        category: 'Finalização',
        quantity: 8,
        purchasePrice: 24,
        salePrice: 49,
        minStock: 10,
        sku: 'BP-POM-MATTE',
        active: true
      },
      {
        id: 'prd_shampoo',
        name: 'Shampoo Barba e Cabelo',
        category: 'Shampoo',
        quantity: 24,
        purchasePrice: 18,
        salePrice: 39,
        minStock: 8,
        sku: 'BP-SHA-001',
        active: true
      },
      {
        id: 'prd_oleo',
        name: 'Óleo para Barba',
        category: 'Barba',
        quantity: 6,
        purchasePrice: 22,
        salePrice: 52,
        minStock: 7,
        sku: 'BP-OLEO-010',
        active: true
      },
      {
        id: 'prd_maquina',
        name: 'Máquina Profissional',
        category: 'Equipamentos',
        quantity: 3,
        purchasePrice: 260,
        salePrice: 420,
        minStock: 2,
        sku: 'BP-MAQ-500',
        active: true
      },
      {
        id: 'prd_navalha',
        name: 'Navalha Inox',
        category: 'Ferramentas',
        quantity: 18,
        purchasePrice: 16,
        salePrice: 35,
        minStock: 6,
        sku: 'BP-NAV-INOX',
        active: true
      }
    ],
    stockMovements: [
      {
        id: 'mov_001',
        productId: 'prd_pomada',
        type: 'sale',
        quantity: 2,
        unitValue: 49,
        reason: 'Venda balcão',
        createdAt: addSeedDays(-2),
        userId: 'usr_attendant'
      },
      {
        id: 'mov_002',
        productId: 'prd_oleo',
        type: 'usage',
        quantity: 1,
        unitValue: 22,
        reason: 'Uso em atendimento premium',
        createdAt: addSeedDays(-1),
        userId: 'usr_barber_marcos'
      }
    ],
    expenses: [
      {
        id: 'exp_001',
        category: 'Aluguel',
        description: 'Aluguel da unidade Centro',
        amount: 4200,
        dueDate: addSeedDays(10),
        status: 'pending'
      },
      {
        id: 'exp_002',
        category: 'Produtos',
        description: 'Reposição de cosméticos',
        amount: 860,
        dueDate: addSeedDays(-3),
        status: 'paid'
      }
    ],
    promotions: [
      {
        id: 'promo_001',
        title: 'Combo Premium de Sexta',
        description: '15% de desconto para corte + barba + sobrancelha nas sextas.',
        code: 'SEXTA15',
        discountType: 'percent',
        discountValue: 15,
        startsAt: addSeedDays(-10),
        endsAt: addSeedDays(30),
        audience: 'all',
        active: true
      },
      {
        id: 'promo_002',
        title: 'Volte esse mês',
        description: 'Cupom para clientes sem atendimento nos últimos 45 dias.',
        code: 'VOLTE20',
        discountType: 'fixed',
        discountValue: 20,
        startsAt: addSeedDays(-1),
        endsAt: addSeedDays(20),
        audience: 'inactive_clients',
        active: true
      }
    ],
    loyaltyRules: {
      pointsPerCurrency: 1,
      pointsPerReferral: 120,
      birthdayCouponValue: 25,
      rewards: [
        { id: 'reward_001', name: 'R$ 20 de desconto', points: 200, discountValue: 20 },
        { id: 'reward_002', name: 'Barba gratuita', points: 450, serviceId: 'srv_barba' },
        { id: 'reward_003', name: 'Combo VIP', points: 900, serviceId: 'srv_combo_premium' }
      ]
    },
    coupons: [
      {
        id: 'cupom_lucas_aniversario',
        code: 'NIVERLUCAS',
        clientId: 'client_lucas',
        discountValue: 25,
        expiresAt: addSeedDays(60),
        usedAt: null,
        status: 'active'
      }
    ],
    waitlist: [
      {
        id: 'wait_001',
        clientId: 'client_vitor',
        serviceId: 'srv_corte',
        barberId: 'barber_marcos',
        preferredDate: addSeedDays(0),
        period: 'Fim da tarde',
        status: 'waiting',
        createdAt: now
      }
    ],
    notifications: [
      {
        id: 'ntf_001',
        userId: 'usr_client_lucas',
        channel: 'whatsapp',
        title: 'Lembrete de atendimento',
        message: 'Lucas, seu horário na BarberPro está chegando.',
        status: 'scheduled',
        scheduledFor: `${addSeedDays(0)}T08:00:00.000Z`,
        sentAt: null
      }
    ],
    settings: {
      barbershopName: 'BarberPro',
      defaultUnitId: 'unit_centro',
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      whatsappNumber: process.env.WHATSAPP_NUMBER || '5511999999999',
      appointmentRules: {
        slotIntervalMinutes: 30,
        reminderMinutesBefore: 120,
        cancellationLimitHours: 3,
        allowClientReschedule: true
      },
      security: {
        sessionMinutes: 480,
        minPasswordLength: 6,
        auditImportantActions: true,
        lgpdConsentRequired: true
      },
      businessHours: {
        0: { label: 'Domingo', open: '10:00', close: '14:00', closed: false },
        1: { label: 'Segunda', open: '09:00', close: '18:00', closed: true },
        2: { label: 'Terça', open: '09:00', close: '20:00', closed: false },
        3: { label: 'Quarta', open: '09:00', close: '20:00', closed: false },
        4: { label: 'Quinta', open: '09:00', close: '20:00', closed: false },
        5: { label: 'Sexta', open: '09:00', close: '21:00', closed: false },
        6: { label: 'Sábado', open: '08:00', close: '18:00', closed: false }
      },
      holidays: [
        { date: `${seedYear}-12-25`, reason: 'Natal' },
        { date: `${seedYear}-01-01`, reason: 'Ano Novo' }
      ]
    },
    auditLogs: [
      {
        id: 'log_001',
        userId: 'usr_admin',
        action: 'system_seeded',
        entity: 'system',
        entityId: 'barberpro',
        details: 'Base demonstrativa criada automaticamente.',
        createdAt: now,
        ip: 'local'
      }
    ]
  };
}

function demoAutoRenewEnabled() {
  const value = String(process.env.DEMO_AUTO_RENEW || 'true').toLowerCase();
  return !IS_PRODUCTION && !['false', '0', 'off', 'no'].includes(value);
}

function parseDateKey(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateKeyFromDate(date);
}

function snapshotGeneratedAt(data) {
  const generatedAt = data?.meta?.generatedAt;
  if (!generatedAt) return null;
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function snapshotGeneratedForDate(data) {
  return parseDateKey(data?.meta?.generatedForDate) || parseDateKey(data?.meta?.generatedAt);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function stripVolatileDemoFields(data) {
  const snapshot = cloneData(data);
  delete snapshot.meta;
  delete snapshot.auditLogs;

  for (const user of snapshot.users || []) {
    delete user.passwordHash;
    delete user.lastLoginAt;
  }

  for (const client of snapshot.clients || []) {
    delete client.loyaltyPoints;
    delete client.visits;
    delete client.noShows;
  }

  for (const appointment of snapshot.appointments || []) {
    delete appointment.status;
    delete appointment.paymentStatus;
    delete appointment.updatedAt;
    delete appointment.cancellationReason;
  }

  return snapshot;
}

function stableDemoJson(data) {
  return JSON.stringify(canonicalize(stripVolatileDemoFields(data)));
}

function referenceForSnapshot(data) {
  const generatedAt = snapshotGeneratedAt(data);
  const generatedForDate = snapshotGeneratedForDate(data);
  if (!generatedAt || !generatedForDate) return null;
  return createInitialData({
    generatedAt,
    baseDate: `${generatedForDate}T12:00:00.000Z`,
    passwordHash: 'ignored-for-demo-comparison'
  });
}

function matchesPristineDemoSnapshot(data) {
  try {
    const reference = referenceForSnapshot(data);
    if (!reference) return false;
    return stableDemoJson(data) === stableDemoJson(reference);
  } catch {
    return false;
  }
}

function demoSnapshotStatus(data, nowDate = new Date()) {
  const generatedAt = snapshotGeneratedAt(data);
  const generatedForDate = snapshotGeneratedForDate(data);
  const today = dateKeyFromDate(nowDate);
  const taggedDemo = data?.meta?.dataset === DEMO_DATASET_ID;
  const pristine = matchesPristineDemoSnapshot(data);
  const stale = Boolean(generatedForDate && generatedForDate < today);

  return {
    dataset: taggedDemo ? DEMO_DATASET_ID : null,
    seedVersion: data?.meta?.seedVersion || null,
    generatedAt,
    generatedForDate,
    today,
    isDemo: taggedDemo || pristine,
    pristine,
    stale,
    autoRenewable: pristine,
    autoRenewEnabled: demoAutoRenewEnabled()
  };
}

function updateDemoStoreState(data, patch = {}) {
  const demo = {
    ...demoSnapshotStatus(data),
    ...patch
  };
  setStoreState({ demo });
  return demo;
}

function buildRenewedDemoData(previousData, previousStatus) {
  const renewedAt = isoNow();
  const data = createInitialData({ generatedAt: renewedAt });
  data.meta.renewedAt = renewedAt;
  data.meta.renewedFrom = {
    generatedAt: previousData?.meta?.generatedAt || null,
    generatedForDate: previousStatus.generatedForDate || null,
    seedVersion: previousData?.meta?.seedVersion || null
  };
  data.auditLogs.unshift({
    id: id('log'),
    userId: 'system',
    action: 'system_demo_renewed',
    entity: 'system',
    entityId: 'barberpro',
    details: 'Base demonstrativa renovada automaticamente.',
    createdAt: renewedAt,
    ip: 'local'
  });
  return data;
}

function maybeRenewDemoSnapshot(data) {
  const status = demoSnapshotStatus(data);
  if (!status.autoRenewEnabled || !status.stale || !status.autoRenewable) {
    return { data, status, renewed: false };
  }

  const renewedData = buildRenewedDemoData(data, status);
  return {
    data: renewedData,
    status: demoSnapshotStatus(renewedData),
    previousStatus: status,
    renewed: true
  };
}

function writeJsonFile(data) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function backupJsonFile(reason) {
  if (!fs.existsSync(dataFile)) return null;
  const parsed = path.parse(dataFile);
  const stamp = isoNow().replace(/[:.]/g, '-');
  const backupFile = path.join(parsed.dir, `${parsed.name}.${reason}.${stamp}${parsed.ext || '.json'}`);
  fs.copyFileSync(dataFile, backupFile);
  return backupFile;
}

function localSeedData(options = {}) {
  const persist = options.persist !== false;

  if (fs.existsSync(dataFile)) {
    const loadedData = normalizeTenantData(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    const renewal = maybeRenewDemoSnapshot(loadedData);
    if (renewal.renewed) {
      renewal.data = normalizeTenantData(renewal.data);
      let backupFile = null;
      if (persist) {
        backupFile = backupJsonFile('stale-demo');
        writeJsonFile(renewal.data);
        console.info(
          `Snapshot demo local renovado de ${renewal.previousStatus.generatedForDate} para ${renewal.status.generatedForDate}.`
        );
      }
      updateDemoStoreState(renewal.data, {
        autoRenewedAt: renewal.data.meta.renewedAt,
        renewedFrom: renewal.data.meta.renewedFrom,
        backupFile
      });
      return normalizeTenantData(renewal.data);
    }

    updateDemoStoreState(loadedData);
    return loadedData;
  }

  const createdData = normalizeTenantData(createInitialData());
  if (options.writeIfMissing) writeJsonFile(createdData);
  updateDemoStoreState(createdData);
  return createdData;
}

async function resetDemoData(options = {}) {
  if (IS_PRODUCTION) {
    const error = new Error('Reset da demonstracao nao esta disponivel em producao.');
    error.statusCode = 403;
    error.code = 'DEMO_RESET_DISABLED';
    throw error;
  }

  return runSerialized(async () => {
    ensureStore();
    const resetAt = isoNow();
    const data = normalizeTenantData(createInitialData({ generatedAt: resetAt, production: false }));
    data.meta.resetAt = resetAt;
    data.auditLogs.unshift({
      id: id('log'),
      userId: options.userId || 'system',
      action: 'system_demo_reset',
      entity: 'system',
      entityId: 'barberpro',
      details: 'Base demonstrativa restaurada manualmente.',
      createdAt: resetAt,
      ip: options.ip || 'local'
    });

    await persistSnapshot(data);
    memoryData = data;
    const demo = updateDemoStoreState(data, { resetAt });
    return { data: memoryData, demo };
  });
}

function validateDatabaseName(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('DB_NAME deve conter apenas letras, números e underscore.');
  }
  return name;
}

async function initializeMysqlStore() {
  const mysql = require('mysql2/promise');
  const config = getMysqlConfig();
  mysqlConfig = config;

  const serverConnection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: config.connectTimeout
  });
  await serverConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await serverConnection.end();

  mysqlPool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: config.connectTimeout,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    namedPlaceholders: true
  });

  await applyRelationalSchema(mysqlPool);

  const [rows] = await mysqlPool.execute('SELECT data FROM app_state WHERE id = ?', [MYSQL_STATE_ID]);
  if (rows.length > 0) {
    const loadedData = normalizeTenantData(JSON.parse(rows[0].data));
    const renewal = maybeRenewDemoSnapshot(loadedData);
    memoryData = normalizeTenantData(renewal.data);
    if (renewal.renewed) {
      console.info(
        `Snapshot demo MySQL renovado de ${renewal.previousStatus.generatedForDate} para ${renewal.status.generatedForDate}.`
      );
    }
    await persistMysqlSnapshot(mysqlPool, memoryData, MYSQL_STATE_ID);
    setStoreState({ lastPersistedAt: isoNow() });
    updateDemoStoreState(memoryData, renewal.renewed
      ? {
          autoRenewedAt: memoryData.meta.renewedAt,
          renewedFrom: memoryData.meta.renewedFrom
        }
      : {});
  } else {
    memoryData = normalizeTenantData(localSeedData());
    await persistMysqlSnapshot(mysqlPool, memoryData, MYSQL_STATE_ID);
    setStoreState({ lastPersistedAt: isoNow() });
  }

  storageMode = 'mysql';
  return markMysqlHealthy(config);
}

function ensureJsonStore() {
  if (!memoryData) {
    memoryData = localSeedData({ writeIfMissing: true });
  }
}

async function initializeStore() {
  if (requestedDriver === 'mysql') {
    try {
      return await initializeMysqlStore();
    } catch (error) {
      if (!fallbackToReadonlyJsonEnabled()) throw error;
      console.warn(
        `Falha ao conectar no MySQL (${error.message}). JSON local carregado somente para leitura; escritas bloqueadas.`
      );
      storageMode = 'mysql';
      mysqlPool = null;
      memoryData = normalizeTenantData(localSeedData());
      return markMysqlUnavailable(error, 'json-readonly');
    }
  }

  storageMode = 'json';
  ensureJsonStore();
  return markJsonHealthy();
}

function ensureStore() {
  if (storageMode === 'mysql') {
    if (!memoryData) throw new Error('Store MySQL ainda não foi inicializado.');
    return;
  }
  ensureJsonStore();
}

async function refreshStoreHealth() {
  if (requestedDriver !== 'mysql') return getStoreInfo();

  if (!mysqlPool) {
    try {
      return await initializeMysqlStore();
    } catch (error) {
      markMysqlUnavailable(error, storeState.fallbackMode || 'json-readonly');
      return getStoreInfo();
    }
  }

  try {
    await mysqlPool.query('SELECT 1');
    return markMysqlHealthy(mysqlConfig);
  } catch (error) {
    markMysqlUnavailable(error, storeState.fallbackMode);
    return getStoreInfo();
  }
}

async function persistMysql(data) {
  if (!mysqlPool || storeState.status !== 'healthy') {
    await refreshStoreHealth();
  }
  if (!mysqlPool || storeState.status !== 'healthy') {
    throw persistenceUnavailableError();
  }

  try {
    await persistMysqlSnapshot(mysqlPool, data, MYSQL_STATE_ID);
    setStoreState({
      status: 'healthy',
      writable: true,
      readOnly: false,
      fallbackMode: null,
      message: 'MySQL ativo. JSON e usado apenas como seed/backup manual.',
      lastError: null,
      lastPersistedAt: isoNow()
    });
  } catch (error) {
    markMysqlUnavailable(error, storeState.fallbackMode);
    throw persistenceUnavailableError(error);
  }
}

async function persistMysqlOperationalMutation(data, writerContext, writer) {
  if (!mysqlPool || storeState.status !== 'healthy') {
    await refreshStoreHealth();
  }
  if (!mysqlPool || storeState.status !== 'healthy') {
    throw persistenceUnavailableError();
  }

  const connection = await mysqlPool.getConnection();
  try {
    await connection.beginTransaction();
    await writer(connection, writerContext);
    await connection.execute(
      `INSERT INTO app_state (id, data)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
      [MYSQL_STATE_ID, JSON.stringify(data)]
    );
    await connection.commit();
    setStoreState({
      status: 'healthy',
      writable: true,
      readOnly: false,
      fallbackMode: null,
      message: 'MySQL ativo. Escritas criticas usam transacoes SQL e app_state sincronizado.',
      lastError: null,
      lastErrorAt: null,
      lastPersistedAt: isoNow()
    });
  } catch (error) {
    await connection.rollback();
    markMysqlUnavailable(error, storeState.fallbackMode);
    throw persistenceUnavailableError(error);
  } finally {
    connection.release();
  }
}

async function persistSnapshot(data) {
  if (storageMode === 'mysql') {
    await persistMysql(data);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    setStoreState({
      status: 'healthy',
      writable: true,
      readOnly: false,
      lastError: null,
      lastPersistedAt: isoNow()
    });
  } catch (error) {
    setStoreState({
      status: 'degraded',
      writable: false,
      readOnly: true,
      message: 'JSON local indisponivel para escrita.',
      lastError: error.message,
      lastErrorAt: isoNow()
    });
    throw new PersistenceUnavailableError('Falha ao gravar o JSON local.', error);
  }
}

function readData() {
  ensureStore();
  return memoryData;
}

async function readOperationalData() {
  ensureStore();
  if (storageMode !== 'mysql' || !mysqlPool || storeState.status !== 'healthy') {
    return readData();
  }

  try {
    const relationalData = await readRelationalData(mysqlPool, memoryData);
    memoryData = normalizeTenantData(relationalData);
    updateDemoStoreState(memoryData);
    setStoreState({
      lastError: null,
      lastErrorAt: null
    });
    return memoryData;
  } catch (error) {
    setStoreState({
      lastError: `Falha ao ler modelo relacional MySQL: ${error.message}`,
      lastErrorAt: isoNow()
    });
    return readData();
  }
}

async function writeData(data) {
  return runSerialized(async () => {
    const nextData = normalizeTenantData(cloneData(data));
    await persistSnapshot(nextData);
    memoryData = nextData;
    updateDemoStoreState(memoryData);
    return memoryData;
  });
}

async function mutateData(mutator) {
  return runSerialized(async () => {
    ensureStore();
    const current = memoryData || createInitialData();
    const before = JSON.stringify(current);
    const draft = normalizeTenantData(cloneData(current));
    const result = await mutator(draft);
    const after = JSON.stringify(draft);

    if (after !== before) {
      await persistSnapshot(draft);
      memoryData = draft;
      updateDemoStoreState(memoryData);
    }

    return result;
  });
}

async function mutateDataWithMysqlOperation(mutator, writer) {
  return runSerialized(async () => {
    ensureStore();
    const current = memoryData || createInitialData();
    const before = JSON.stringify(current);
    const draft = normalizeTenantData(cloneData(current));
    const result = await mutator(draft);
    const after = JSON.stringify(draft);

    if (after !== before) {
      if (storageMode === 'mysql' && typeof writer === 'function') {
        await persistMysqlOperationalMutation(draft, { before: current, after: draft, result }, writer);
      } else {
        await persistSnapshot(draft);
      }
      memoryData = draft;
      updateDemoStoreState(memoryData);
    }

    return result;
  });
}

function sanitizeUser(user) {
  if (!user) return null;
  const {
    passwordHash,
    passwordResetToken,
    passwordResetTokenHash,
    passwordResetExpiresAt,
    passwordResetExpires,
    resetToken,
    resetTokenExpiresAt,
    sessionToken,
    ...safeUser
  } = user;
  return safeUser;
}

module.exports = {
  DEFAULT_TENANT_ID,
  dataFile,
  DEMO_RESET_CONFIRMATION,
  getStoreInfo,
  id,
  initializeStore,
  isoNow,
  PersistenceUnavailableError,
  readData,
  readOperationalData,
  refreshStoreHealth,
  resetDemoData,
  writeData,
  mutateData,
  mutateDataWithMysqlOperation,
  sanitizeUser,
  normalizeTenantData
};
