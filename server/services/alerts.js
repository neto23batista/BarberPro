async function notifyCriticalError(event) {
  // Stub pronto para Sentry, BetterStack, Slack ou e-mail transacional.
  // Integre aqui o provider real usando process.env.ALERT_WEBHOOK_URL ou SMTP_*.
  return {
    delivered: false,
    provider: process.env.ALERT_PROVIDER || 'stub',
    event
  };
}

function registerProcessAlertHandlers({ logger }) {
  process.on('unhandledRejection', async (reason) => {
    const event = {
      type: 'unhandledRejection',
      message: reason?.message || String(reason),
      stack: reason?.stack || null,
      createdAt: new Date().toISOString()
    };
    logger?.fatal(event, 'critical_unhandled_rejection');
    await notifyCriticalError(event).catch((error) => logger?.error({ error }, 'critical_alert_failed'));
  });

  process.on('uncaughtException', async (error) => {
    const event = {
      type: 'uncaughtException',
      message: error?.message || String(error),
      stack: error?.stack || null,
      createdAt: new Date().toISOString()
    };
    logger?.fatal(event, 'critical_uncaught_exception');
    await notifyCriticalError(event).catch((alertError) => logger?.error({ error: alertError }, 'critical_alert_failed'));
    process.exit(1);
  });
}

module.exports = {
  notifyCriticalError,
  registerProcessAlertHandlers
};
