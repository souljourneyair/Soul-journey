'use strict';

// Небольшой ограничитель в памяти процесса. Сохраняет фиксированные окна,
// периодически очищает истёкшие ключи и ограничивает общий размер Map.
function createRateLimiter({ now = Date.now, maxEntries = 20000, cleanupEvery = 128 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive safe integer');
  }
  if (!Number.isSafeInteger(cleanupEvery) || cleanupEvery < 1) {
    throw new TypeError('cleanupEvery must be a positive safe integer');
  }

  const buckets = new Map();
  let operations = 0;

  function cleanupExpired(currentTime) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
  }

  function consume(key, limit, windowMs) {
    if (typeof key !== 'string' || !key) throw new TypeError('rate-limit key must be a non-empty string');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive safe integer');

    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
    }

    // Перемещаем ключ в конец Map, чтобы при достижении потолка удалялись
    // давно не использовавшиеся записи, а активные ограничения сохранялись.
    buckets.delete(key);
    buckets.set(key, bucket);

    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, bucket.resetAt - currentTime),
      };
    }

    bucket.count += 1;
    operations += 1;
    if (operations % cleanupEvery === 0) cleanupExpired(currentTime);

    while (buckets.size > maxEntries) {
      const oldestKey = buckets.keys().next().value;
      buckets.delete(oldestKey);
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterMs: 0,
    };
  }

  function reset(key) {
    return buckets.delete(key);
  }

  return { consume, reset };
}

// Не доверяем X-Forwarded-For напрямую: req.ip использует его только при
// явном перечислении адреса reverse proxy в настройке Express trust proxy.
function getClientIp(req) {
  // req.ip вычисляется Express с учётом app.set('trust proxy').
  const address = req && (typeof req.ip === 'string' && req.ip
    ? req.ip
    : req.socket && req.socket.remoteAddress);
  if (typeof address !== 'string' || !address) return 'unknown';
  return address.replace(/^::ffff:/, '').slice(0, 128);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isValidNewPassword(password) {
  return typeof password === 'string'
    && Array.from(password).length >= 10
    && Buffer.byteLength(password, 'utf8') <= 72;
}

module.exports = { createRateLimiter, getClientIp, isValidNewPassword, isFiniteNumber, isBoolean };
