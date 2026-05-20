const crypto = require('crypto');
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: {
    service: 'barberpro-api',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const responseTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info({
      requestId,
      userId: req.authUser?.id || null,
      method: req.method,
      route: req.originalUrl || req.url,
      statusCode: res.statusCode,
      responseTimeMs: Number(responseTimeMs.toFixed(2)),
      ip: req.ip
    }, 'request_completed');
  });

  next();
}

module.exports = {
  logger,
  requestLogger
};
