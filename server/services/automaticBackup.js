const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { sanitizeBackupData } = require('./sanitizers');

const execFileAsync = promisify(execFile);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupDirectory() {
  return path.resolve(process.cwd(), process.env.BACKUP_DIR || path.join('data', 'backups'));
}

async function notifyBackupFailure(error, logger) {
  const event = {
    type: 'backup_failed',
    message: error.message,
    createdAt: new Date().toISOString()
  };
  logger?.error(event, 'backup_failure_notification_stub');
  return event;
}

function rotateBackups(directory, keep = 7) {
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^barberpro-backup-/.test(name))
    .map((name) => ({
      name,
      path: path.join(directory, name),
      mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(keep)) {
    fs.unlinkSync(file.path);
  }
}

async function writeJsonBackup({ readData, directory }) {
  const data = sanitizeBackupData(await readData());
  const file = path.join(directory, `barberpro-backup-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function writeMysqlDump({ directory }) {
  const file = path.join(directory, `barberpro-backup-${timestamp()}.sql`);
  const mysqldump = process.env.MYSQLDUMP_BIN || 'mysqldump';
  const args = [
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '-h',
    process.env.DB_HOST || '127.0.0.1',
    '-P',
    String(process.env.DB_PORT || 3306),
    '-u',
    process.env.DB_USER || 'root',
    `--result-file=${file}`,
    process.env.DB_NAME || 'barberpro'
  ];

  if (process.env.DB_PASSWORD) {
    args.splice(args.length - 1, 0, `-p${process.env.DB_PASSWORD}`);
  }

  await execFileAsync(mysqldump, args, {
    timeout: Number(process.env.BACKUP_TIMEOUT_MS || 120_000),
    windowsHide: true
  });
  return file;
}

async function runAutomaticBackup({ readData, getStoreInfo, mutateData, logger }) {
  const directory = backupDirectory();
  fs.mkdirSync(directory, { recursive: true });

  const store = getStoreInfo();
  const file = store.mode === 'mysql'
    ? await writeMysqlDump({ directory })
    : await writeJsonBackup({ readData, directory });

  rotateBackups(directory, Number(process.env.BACKUP_KEEP || 7));

  await mutateData(async (data) => {
    data.auditLogs = data.auditLogs || [];
    data.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'system',
      action: 'backup_automatic_success',
      entity: 'system',
      entityId: 'backup',
      details: `Backup automatico gerado em ${file}`,
      createdAt: new Date().toISOString(),
      ip: 'local'
    });
  });

  logger?.info({ file }, 'automatic_backup_success');
  return { file };
}

function startAutomaticBackups(dependencies) {
  const enabled = String(process.env.AUTO_BACKUP_ENABLED || (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase();
  if (!['true', '1', 'yes', 'on'].includes(enabled)) return null;

  const intervalMs = Number(process.env.BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const run = () => runAutomaticBackup(dependencies).catch(async (error) => {
    dependencies.logger?.error({ error: error.message, stack: error.stack }, 'automatic_backup_failed');
    await notifyBackupFailure(error, dependencies.logger);
    await dependencies.mutateData(async (data) => {
      data.auditLogs = data.auditLogs || [];
      data.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId: 'system',
        action: 'backup_automatic_failed',
        entity: 'system',
        entityId: 'backup',
        details: error.message,
        createdAt: new Date().toISOString(),
        ip: 'local'
      });
    }).catch(() => {});
  });

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, Number(process.env.BACKUP_START_DELAY_MS || 30_000)).unref?.();
  return timer;
}

module.exports = {
  runAutomaticBackup,
  startAutomaticBackups,
  rotateBackups
};
