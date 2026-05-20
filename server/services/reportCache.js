function createReportCache(options = {}) {
  const ttlMs = Number(options.ttlMs || 60_000);
  const cache = new Map();

  function getOrSet(key, factory) {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = factory();
    cache.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlMs
    });
    return value;
  }

  function invalidate(reason = 'manual') {
    const size = cache.size;
    cache.clear();
    return { reason, cleared: size };
  }

  function stats() {
    return {
      ttlMs,
      keys: cache.size,
      entries: Array.from(cache.keys())
    };
  }

  return {
    getOrSet,
    invalidate,
    stats
  };
}

module.exports = {
  createReportCache
};
