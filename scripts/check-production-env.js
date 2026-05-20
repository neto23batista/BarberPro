require('dotenv').config({ path: process.env.ENV_FILE || '.env.production' });

const { validateProductionRuntime } = require('../server/services/runtimeConfig');

const REQUIRED = [
  'NODE_ENV',
  'JWT_SECRET',
  'SESSION_COOKIE',
  'CORS_ORIGIN',
  'DB_DRIVER',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_FALLBACK_TO_JSON',
  'DEFAULT_TENANT_ID',
  'DEFAULT_TENANT_NAME',
  'AUTO_BACKUP_ENABLED',
  'BACKUP_DIR',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASS'
];

function fail(message) {
  console.error(`ENV INVALIDO: ${message}`);
  process.exitCode = 1;
}

for (const key of REQUIRED) {
  if (!process.env[key]) fail(`${key} nao definido.`);
}

if (process.env.NODE_ENV !== 'production') fail('NODE_ENV deve ser production.');
if ((process.env.JWT_SECRET || '').length < 48) fail('JWT_SECRET deve ter pelo menos 48 caracteres.');
if (/(troque|change|changeme|secret|dev|local|barberpro|example|password)/i.test(process.env.JWT_SECRET || '')) {
  fail('JWT_SECRET parece placeholder.');
}
if (!String(process.env.CORS_ORIGIN || '').startsWith('https://')) fail('CORS_ORIGIN deve usar HTTPS.');
if (process.env.DB_DRIVER !== 'mysql') fail('DB_DRIVER deve ser mysql.');
if (process.env.DB_FALLBACK_TO_JSON !== 'false') fail('DB_FALLBACK_TO_JSON deve ser false em producao.');
if (!Number.isInteger(Number(process.env.SMTP_PORT)) || Number(process.env.SMTP_PORT) <= 0) fail('SMTP_PORT deve ser numerico.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.SMTP_FROM || '').trim())) fail('SMTP_FROM deve ser um e-mail valido.');
if (process.env.PRODUCTION_BOOTSTRAP_DONE !== 'true' && !process.env.FIRST_ADMIN_PASSWORD) {
  fail('FIRST_ADMIN_PASSWORD e obrigatorio antes do primeiro bootstrap.');
}
if (process.env.FIRST_ADMIN_PASSWORD && process.env.FIRST_ADMIN_PASSWORD.length < 12) {
  fail('FIRST_ADMIN_PASSWORD deve ter pelo menos 12 caracteres.');
}
if (process.env.DEMO_RESET_ENABLED === 'true') fail('DEMO_RESET_ENABLED deve ficar false em producao.');

if (!process.exitCode) {
  try {
    validateProductionRuntime();
    console.log('Ambiente de producao validado.');
  } catch (error) {
    fail(error.message);
  }
}
