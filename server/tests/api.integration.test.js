'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverEntry = path.join(projectRoot, 'server', 'index.js');
const productionDataFile = path.join(projectRoot, 'data.json');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const finished = await Promise.race([exited.then(() => true), wait(5000).then(() => false)]);
  if (!finished && child.exitCode === null && child.signalCode === null) {
    const forceExit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await Promise.race([forceExit, wait(2000)]);
  }
}

async function waitForServer(child, baseUrl, getLogs) {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early (code ${child.exitCode}, signal ${child.signalCode}).\n${getLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/me`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.status === 401) return;
      lastError = new Error(`Unexpected readiness response: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Test server did not become ready: ${lastError?.message || 'timeout'}\n${getLogs()}`);
}

async function request(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${route}, got HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, data };
}

test('HTTP API isolates its save and protects the first construction and finance flow', {
  timeout: 45_000,
}, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-journey-api-'));
  const tempDataFile = path.join(tempRoot, 'api-data.json');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  assert.notEqual(tempDataFile, productionDataFile);
  assert.equal(fs.existsSync(tempDataFile), false);
  assert.equal(fs.existsSync(productionDataFile), false,
    'integration tests must not create or modify the production data.json');

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SOUL_JOURNEY_TEST_DATA_FILE: tempDataFile,
      SUPERUSER_PASSWORD: 'CI-Only-Admin-Password-2026',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });

  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await waitForServer(child, baseUrl, () => logs);

  const unauthenticated = await request(baseUrl, '/api/state');
  assert.equal(unauthenticated.status, 401);

  const registration = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { username: 'ApiIntegration', password: 'Integration-Password-2026' },
  });
  assert.equal(registration.status, 200);
  assert.equal(registration.data.username, 'ApiIntegration');
  assert.equal(registration.data.isAdmin, false);
  assert.ok(typeof registration.data.token === 'string' && registration.data.token.length > 0);

  const login = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'ApiIntegration', password: 'Integration-Password-2026' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.userId, registration.data.userId);
  const token = login.data.token;

  const meBeforeStart = await request(baseUrl, '/api/me', { token });
  assert.equal(meBeforeStart.status, 200);
  assert.equal(meBeforeStart.data.hasAirport, false);

  const missingAirport = await request(baseUrl, '/api/state', { token });
  assert.equal(missingAirport.status, 404);
  assert.equal(missingAirport.data.error, 'no_airport');

  const started = await request(baseUrl, '/api/start-game', { method: 'POST', token, body: {} });
  assert.equal(started.status, 200);
  assert.equal(started.data.money, 12_000);
  assert.equal(started.data.level, 1);
  assert.ok(started.data.buildings.some(building => building.buildingId === 'admin'));
  assert.equal(started.data.mow.credits, 0);

  const duplicateStart = await request(baseUrl, '/api/start-game', { method: 'POST', token, body: {} });
  assert.equal(duplicateStart.status, 409);
  assert.equal(duplicateStart.data.error, 'already_started');

  const beforeRejectedActions = await request(baseUrl, '/api/state', { token });
  const initialMoney = beforeRejectedActions.data.money;

  const invalidLoanType = await request(baseUrl, '/api/bank/borrow', {
    method: 'POST', token, body: { amount: '5000' },
  });
  assert.equal(invalidLoanType.status, 400);
  assert.equal(invalidLoanType.data.error, 'invalid_amount');

  const tooSmallLoan = await request(baseUrl, '/api/bank/borrow', {
    method: 'POST', token, body: { amount: 1000 },
  });
  assert.equal(tooSmallLoan.status, 400);
  assert.equal(tooSmallLoan.data.error, 'too_small');

  const fuelWithoutDepot = await request(baseUrl, '/api/fuel/refill', {
    method: 'POST', token, body: {},
  });
  assert.equal(fuelWithoutDepot.status, 400);
  assert.equal(fuelWithoutDepot.data.error, 'no_depot');

  const unknownBuilding = await request(baseUrl, '/api/build', {
    method: 'POST', token, body: { buildingId: '__not_a_building__' },
  });
  assert.equal(unknownBuilding.status, 400);
  assert.equal(unknownBuilding.data.error, 'unknown_building');

  const helipadWithoutMowing = await request(baseUrl, '/api/build', {
    method: 'POST', token, body: { buildingId: 'helipad' },
  });
  assert.equal(helipadWithoutMowing.status, 400);
  assert.equal(helipadWithoutMowing.data.error, 'needs_mow');

  const moneyAfterRejections = await request(baseUrl, '/api/state', { token });
  assert.equal(moneyAfterRejections.data.money, initialMoney,
    'rejected financial and construction requests must not change the balance');

  const mowing = await request(baseUrl, '/api/quests/mow', { method: 'POST', token, body: {} });
  assert.equal(mowing.status, 200);
  assert.equal(mowing.data.money, initialMoney - mowing.data.mow.cost);
  assert.equal(mowing.data.mow.mowing, true);

  const duplicateMowing = await request(baseUrl, '/api/quests/mow', { method: 'POST', token, body: {} });
  assert.equal(duplicateMowing.status, 400);
  assert.equal(duplicateMowing.data.error, 'mow_busy');

  // Mow completion is driven by the real server tick. Poll state instead of
  // hard-coding the configured tick interval or writing directly to storage.
  const mowingDeadline = Date.now() + 20_000;
  let afterMow = mowing.data;
  while (Date.now() < mowingDeadline && afterMow.mow.credits < 1) {
    await wait(150);
    const state = await request(baseUrl, '/api/state', { token });
    assert.equal(state.status, 200);
    afterMow = state.data;
  }
  assert.equal(afterMow.mow.credits, 1, `mow credit was not granted before timeout.\n${logs}`);

  const build = await request(baseUrl, '/api/build', {
    method: 'POST', token, body: { buildingId: 'helipad' },
  });
  assert.equal(build.status, 200);
  assert.equal(build.data.money, initialMoney - mowing.data.mow.cost - build.data.catalog.helipad.cost);
  assert.equal(build.data.mow.credits, 0);
  const helipad = build.data.buildings.find(building => building.buildingId === 'helipad');
  assert.ok(helipad, 'new helipad should be persisted and returned');
  assert.equal(helipad.constructionType, 'build');
  assert.ok(helipad.constructionTicksLeft > 0);

  const saved = JSON.parse(fs.readFileSync(tempDataFile, 'utf8'));
  assert.equal(saved.users.length, 2, 'isolated save contains the admin and test account');
  assert.equal(saved.airports.length, 2, 'isolated save contains admin and test airports');
  assert.equal(fs.existsSync(productionDataFile), false,
    'the real project data.json must remain untouched');
});
