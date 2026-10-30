'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, getClientIp, isValidNewPassword } = require('../security');

test('rate limiter allows the configured number of attempts and returns retry delay', () => {
  let now = 1000;
  const limiter = createRateLimiter({ now: () => now });

  assert.equal(limiter.consume('ip:127.0.0.1', 2, 60_000).allowed, true);
  assert.equal(limiter.consume('ip:127.0.0.1', 2, 60_000).allowed, true);
  const blocked = limiter.consume('ip:127.0.0.1', 2, 60_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);

  now += 60_000;
  assert.equal(limiter.consume('ip:127.0.0.1', 2, 60_000).allowed, true);
});

test('successful authentication can reset only the matching account bucket', () => {
  const limiter = createRateLimiter();
  limiter.consume('user:alice', 1, 60_000);
  limiter.consume('user:bob', 1, 60_000);

  assert.equal(limiter.consume('user:alice', 1, 60_000).allowed, false);
  assert.equal(limiter.reset('user:alice'), true);
  assert.equal(limiter.consume('user:alice', 1, 60_000).allowed, true);
  assert.equal(limiter.consume('user:bob', 1, 60_000).allowed, false);
});

test('rate limiter keeps its in-memory state bounded', () => {
  const limiter = createRateLimiter({ maxEntries: 2 });
  limiter.consume('first', 1, 60_000);
  limiter.consume('second', 1, 60_000);
  limiter.consume('third', 1, 60_000);

  // Первая запись вытеснена как самая старая; ограничение для остальных
  // ключей продолжает действовать.
  assert.equal(limiter.consume('second', 1, 60_000).allowed, false);
  assert.equal(limiter.consume('third', 1, 60_000).allowed, false);
  assert.equal(limiter.consume('first', 1, 60_000).allowed, true);
});

test('client IP comes from the socket and ignores a forged forwarded header', () => {
  const req = {
    socket: { remoteAddress: '::ffff:192.0.2.5' },
    headers: { 'x-forwarded-for': '203.0.113.99' },
  };
  assert.equal(getClientIp(req), '192.0.2.5');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '203.0.113.99' } }), 'unknown');
});

test('new passwords must be at least 10 characters and no more than 72 UTF-8 bytes', () => {
  assert.equal(isValidNewPassword('1234567890'), true);
  assert.equal(isValidNewPassword('123456789'), false);
  assert.equal(isValidNewPassword('🙂'.repeat(18)), true);
  assert.equal(isValidNewPassword('🙂'.repeat(19)), false);
  assert.equal(isValidNewPassword(null), false);
});
