function isPlaceholder(value) {
  return /(troque|change|changeme|secret|dev|local|barberpro|example|password|placeholder)/i.test(String(value || ''));
}

function validateStrongPassword(password, options = {}) {
  const minLength = Number(options.minLength || 8);
  const value = String(password || '');
  const errors = [];

  if (value.length < minLength) errors.push(`A senha precisa ter pelo menos ${minLength} caracteres.`);
  if (!/[a-z]/.test(value)) errors.push('A senha precisa conter letra minuscula.');
  if (!/[A-Z]/.test(value)) errors.push('A senha precisa conter letra maiuscula.');
  if (!/[0-9]/.test(value)) errors.push('A senha precisa conter numero.');
  if (!/[^a-zA-Z0-9]/.test(value)) errors.push('A senha precisa conter caractere especial.');
  if (isPlaceholder(value) || /123456|qwerty|admin/i.test(value)) errors.push('A senha nao pode ser padrao ou previsivel.');

  return {
    ok: errors.length === 0,
    errors
  };
}

function requireEnv(name, errors) {
  if (!process.env[name]) errors.push(`${name} e obrigatorio.`);
}

function validateProductionRuntime() {
  if (process.env.NODE_ENV !== 'production') return;

  const errors = [];
  const jwtSecret = process.env.JWT_SECRET || '';

  [
    'JWT_SECRET',
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
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_FROM',
    'SMTP_USER',
    'SMTP_PASS'
  ].forEach((name) => requireEnv(name, errors));

  if (jwtSecret.length < 48) errors.push('JWT_SECRET de producao deve ter pelo menos 48 caracteres.');
  if (isPlaceholder(jwtSecret)) errors.push('JWT_SECRET nao pode ser padrao ou placeholder.');
  if (!String(process.env.CORS_ORIGIN || '').startsWith('https://')) errors.push('CORS_ORIGIN deve usar HTTPS em producao.');
  if (process.env.DB_DRIVER !== 'mysql') errors.push('DB_DRIVER deve ser mysql em producao.');
  if (process.env.DB_FALLBACK_TO_JSON !== 'false') errors.push('DB_FALLBACK_TO_JSON deve ser false em producao.');
  if (!Number.isInteger(Number(process.env.SMTP_PORT)) || Number(process.env.SMTP_PORT) <= 0) {
    errors.push('SMTP_PORT deve ser numerico.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.SMTP_FROM || '').trim())) {
    errors.push('SMTP_FROM deve ser um e-mail valido.');
  }
  if (process.env.DEMO_AUTO_RENEW === 'true') errors.push('DEMO_AUTO_RENEW deve ser false em producao.');
  if (process.env.DEMO_RESET_ENABLED === 'true') errors.push('DEMO_RESET_ENABLED deve ser false em producao.');

  const bootstrapDone = String(process.env.PRODUCTION_BOOTSTRAP_DONE || '').toLowerCase() === 'true';
  if (!bootstrapDone) {
    requireEnv('FIRST_ADMIN_EMAIL', errors);
    requireEnv('FIRST_ADMIN_PASSWORD', errors);
  }

  if (process.env.FIRST_ADMIN_PASSWORD) {
    const adminPassword = validateStrongPassword(process.env.FIRST_ADMIN_PASSWORD, { minLength: 12 });
    if (!adminPassword.ok) errors.push(`FIRST_ADMIN_PASSWORD invalido: ${adminPassword.errors.join(' ')}`);
  }

  if (errors.length) {
    throw new Error(`Configuracao de producao invalida: ${errors.join(' ')}`);
  }
}

module.exports = {
  isPlaceholder,
  validateStrongPassword,
  validateProductionRuntime
};
