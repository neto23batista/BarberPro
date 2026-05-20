const SENSITIVE_FIELD_NAMES = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'passwordresettoken',
  'password_reset_token',
  'passwordresettokenhash',
  'password_reset_token_hash',
  'passwordresetexpires',
  'passwordresetexpiresat',
  'password_reset_expires_at',
  'resettoken',
  'reset_token',
  'sessiontoken',
  'session_token',
  'jwttoken',
  'jwt_token',
  'jwtsecret',
  'jwt_secret',
  'apikey',
  'api_key',
  'secret'
]);

function isSensitiveKey(key) {
  const normalized = String(key || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized);
}

function sanitizeBackupData(value) {
  if (Array.isArray(value)) return value.map(sanitizeBackupData);
  if (!value || typeof value !== 'object') return value;

  return Object.entries(value).reduce((safe, [key, item]) => {
    if (isSensitiveKey(key)) return safe;
    safe[key] = sanitizeBackupData(item);
    return safe;
  }, {});
}

module.exports = {
  sanitizeBackupData,
  isSensitiveKey
};
