const nodemailer = require('nodemailer');

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function smtpConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 0);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const from = sanitizeHeader(process.env.SMTP_FROM);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  return {
    configured: Boolean(host && port && from && isEmail(from)),
    host,
    port,
    user,
    pass,
    from,
    secure
  };
}

async function sendPasswordResetEmail({ to, name, resetUrl, expiresAt, logger }) {
  const config = smtpConfig();
  const recipient = sanitizeHeader(to);
  if (!isEmail(recipient)) {
    throw new Error('Destinatario de recuperacao de senha invalido.');
  }

  if (!config.configured) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP nao configurado para recuperacao de senha em producao.');
    }
    logger?.warn({ recipient }, 'password_reset_email_skipped_without_smtp');
    return { skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user || config.pass ? { user: config.user, pass: config.pass } : undefined,
    requireTLS: String(process.env.SMTP_REQUIRE_TLS || 'true').toLowerCase() !== 'false',
    tls: {
      rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false'
    }
  });

  const firstName = sanitizeHeader(name).split(' ').filter(Boolean)[0] || 'cliente';
  const subject = sanitizeHeader(process.env.PASSWORD_RESET_EMAIL_SUBJECT || 'Redefinicao de senha BarberPro');
  const expiry = expiresAt ? new Date(expiresAt).toLocaleString('pt-BR') : 'em breve';
  const text = [
    `Ola, ${firstName}.`,
    '',
    'Recebemos uma solicitacao para redefinir sua senha no BarberPro.',
    `Use este link: ${resetUrl}`,
    '',
    `O link expira em ${expiry}. Se voce nao pediu esta alteracao, ignore este e-mail.`
  ].join('\n');
  const html = `
    <p>Ola, ${escapeHtml(firstName)}.</p>
    <p>Recebemos uma solicitacao para redefinir sua senha no BarberPro.</p>
    <p><a href="${escapeHtml(resetUrl)}">Redefinir senha</a></p>
    <p>O link expira em ${escapeHtml(expiry)}. Se voce nao pediu esta alteracao, ignore este e-mail.</p>
  `;

  await transporter.sendMail({
    from: config.from,
    to: recipient,
    subject,
    text,
    html
  });

  return { sent: true };
}

module.exports = {
  isEmail,
  sendPasswordResetEmail,
  smtpConfig
};
