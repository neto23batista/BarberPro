const jwt = require('jsonwebtoken');

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function getAuthToken(req, sessionCookie) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return parseCookies(req.headers.cookie)[sessionCookie] || null;
}

function createAuthMiddleware({ jwtSecret, sessionCookie, readData, sanitizeUser, sendError }) {
  if (!jwtSecret) throw new Error('jwtSecret e obrigatorio para createAuthMiddleware.');

  function authenticate(req, res, next) {
    const token = getAuthToken(req, sessionCookie);
    if (!token) return sendError(res, 401, 'Sessao obrigatoria.');

    try {
      const payload = jwt.verify(token, jwtSecret);
      const data = readData();
      const user = data.users.find((item) => item.id === payload.sub && item.status === 'active');
      if (!user) return sendError(res, 401, 'Usuario nao encontrado ou inativo.');
      req.authUser = sanitizeUser(user);
      next();
    } catch {
      return sendError(res, 401, 'Sessao invalida ou expirada.');
    }
  }

  function requireRoles(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.authUser.role)) {
        return sendError(res, 403, 'Seu perfil nao tem permissao para esta acao.');
      }
      next();
    };
  }

  return {
    authenticate,
    requireRoles
  };
}

module.exports = {
  createAuthMiddleware,
  parseCookies,
  getAuthToken
};
