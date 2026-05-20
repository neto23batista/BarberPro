const fs = require('fs');
const os = require('os');
const path = require('path');

function diskStatus(targetPath = process.cwd()) {
  const resolved = path.resolve(targetPath);
  const minimumFreeMb = Number(process.env.HEALTH_MIN_FREE_DISK_MB || 512);

  if (typeof fs.statfsSync !== 'function') {
    return {
      ok: true,
      checked: false,
      message: 'fs.statfsSync indisponivel nesta versao do Node.js.'
    };
  }

  const stats = fs.statfsSync(resolved);
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  const freeMb = Math.round(freeBytes / 1024 / 1024);

  return {
    ok: freeMb >= minimumFreeMb,
    checked: true,
    path: resolved,
    freeMb,
    totalMb: Math.round(totalBytes / 1024 / 1024),
    minimumFreeMb
  };
}

async function buildHealthStatus({ refreshStoreHealth, getStoreInfo, logger }) {
  const persistence = await refreshStoreHealth();
  const disk = diskStatus(process.env.BACKUP_DIR || process.cwd());
  const memory = process.memoryUsage();
  const maxHeapMb = Number(process.env.HEALTH_MAX_HEAP_MB || 1024);
  const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
  const memoryStatus = {
    ok: heapUsedMb <= maxHeapMb,
    heapUsedMb,
    rssMb: Math.round(memory.rss / 1024 / 1024),
    maxHeapMb,
    systemFreeMb: Math.round(os.freemem() / 1024 / 1024)
  };

  const database = {
    ok: persistence.writable && !persistence.readOnly,
    mode: persistence.mode,
    status: persistence.status,
    database: persistence.database,
    host: persistence.host,
    port: persistence.port,
    message: persistence.message
  };

  const lastWrite = {
    ok: database.ok || Boolean(persistence.lastPersistedAt) || persistence.mode === 'json',
    lastPersistedAt: persistence.lastPersistedAt || null
  };

  const ok = database.ok && disk.ok && memoryStatus.ok && lastWrite.ok;
  const payload = {
    ok,
    name: 'BarberPro API',
    version: '1.0.0',
    time: new Date().toISOString(),
    database,
    disk,
    memory: memoryStatus,
    lastWrite,
    persistence: getStoreInfo()
  };

  if (!ok && logger) logger.warn(payload, 'health_check_failed');
  return payload;
}

module.exports = {
  buildHealthStatus
};
