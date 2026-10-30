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
const productionLockFile = `${productionDataFile}.lock`;

function snapshotFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function assertFileUnchanged(filePath, before) {
  const after = snapshotFile(filePath);
  if (before === null) {
    assert.equal(after, null, `integration test unexpectedly created ${filePath}`);
  } else {
    assert.deepEqual(after, before, `integration test modified ${filePath}`);
  }
}

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
  timeout: 180_000,
}, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-journey-api-'));
  const tempDataFile = path.join(tempRoot, 'api-data.json');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const productionDataBefore = snapshotFile(productionDataFile);
  const productionLockBefore = snapshotFile(productionLockFile);
  const tempMediaDir = path.join(tempRoot, 'public-media');

  assert.notEqual(tempDataFile, productionDataFile);
  assert.equal(fs.existsSync(tempDataFile), false);
  assert.equal(fs.existsSync(tempMediaDir), false);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SOUL_JOURNEY_TEST_DATA_FILE: tempDataFile,
      SOUL_JOURNEY_TEST_MEDIA_DIR: tempMediaDir,
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

  const beforeBuild = await request(baseUrl, '/api/state', { token });
  assert.equal(beforeBuild.status, 200);
  const buildCost = beforeBuild.data.catalog.helipad.cost;

  const build = await request(baseUrl, '/api/build', {
    method: 'POST', token, body: { buildingId: 'helipad' },
  });
  assert.equal(build.status, 200);
  // Содержание продолжает начисляться между запросами: сравниваем с балансом
  // непосредственно перед постройкой и допускаем несколько тиков расходов.
  assert.ok(build.data.money <= beforeBuild.data.money - buildCost,
    'the full configured construction cost must be deducted');
  const tickExpenseAllowance = Math.max(0, beforeBuild.data.upkeepPerTick || 0) * 4 + 10;
  assert.ok(build.data.money >= beforeBuild.data.money - buildCost - tickExpenseAllowance,
    'only normal tick upkeep may additionally reduce the balance during the request');
  assert.equal(build.data.mow.credits, 0);
  const helipad = build.data.buildings.find(building => building.buildingId === 'helipad');
  assert.ok(helipad, 'new helipad should be persisted and returned');
  assert.equal(helipad.constructionType, 'build');
  assert.ok(helipad.constructionTicksLeft > 0);

  // Проверяем завершение стройки через реальный игровой тик, а не прямую
  // запись в data.json. У площадки по конфигу 8 тиков строительства.
  const constructionDeadline = Date.now() + 45_000;
  let completedConstructionState = build.data;
  let completedHelipad = helipad;
  while (Date.now() < constructionDeadline && completedHelipad.constructionType !== null) {
    await wait(200);
    const state = await request(baseUrl, '/api/state', { token });
    assert.equal(state.status, 200);
    completedConstructionState = state.data;
    completedHelipad = completedConstructionState.buildings.find(
      building => building.buildingId === 'helipad',
    );
    assert.ok(completedHelipad, 'helipad must remain present while construction progresses');
  }
  assert.equal(completedHelipad.constructionType, null,
    `helipad construction did not finish before timeout.\n${logs}`);
  assert.equal(completedHelipad.constructionTicksLeft, 0);
  assert.ok(completedConstructionState.xp > build.data.xp,
    'completed construction must award XP');

  // После ввода первой вертолётной площадки глава 1 должна получить первое
  // гарантированное предложение — даже если направления ещё не открыты.
  const envelopeDeadline = Date.now() + 10_000;
  let envelope = await request(baseUrl, '/api/envelope', { token });
  while (Date.now() < envelopeDeadline && envelope.data.offers.length === 0) {
    await wait(200);
    envelope = await request(baseUrl, '/api/envelope', { token });
  }
  assert.equal(envelope.status, 200);
  assert.equal(envelope.data.offers.length, 1,
    `chapter one should generate its guaranteed first contract offer.\\n${logs}`);
  const firstOffer = envelope.data.offers[0];
  assert.equal(firstOffer.craft, 'heli');
  assert.equal(firstOffer.pointId, 'tihaya');

  const invalidDuration = await request(baseUrl, '/api/envelope/accept', {
    method: 'POST', token,
    body: { offerId: firstOffer.id, durationUnit: 'day', durationValue: 0 },
  });
  assert.equal(invalidDuration.status, 400);
  assert.equal(invalidDuration.data.error, 'bad_duration');

  const offerStillAvailable = await request(baseUrl, '/api/envelope', { token });
  assert.equal(offerStillAvailable.data.offers.length, 1,
    'invalid duration must not consume the offer');

  const acceptedContract = await request(baseUrl, '/api/envelope/accept', {
    method: 'POST', token,
    body: { offerId: firstOffer.id, durationUnit: 'day', durationValue: 3 },
  });
  assert.equal(acceptedContract.status, 200);
  assert.equal(acceptedContract.data.offers.length, 0);
  assert.equal(acceptedContract.data.contracts.length, 1);
  assert.equal(acceptedContract.data.contracts[0].craft, 'heli');
  assert.equal(acceptedContract.data.contracts[0].pointId, 'tihaya');
  assert.ok(acceptedContract.data.contracts[0].daysLeft > 0);

  const acceptConsumedOfferAgain = await request(baseUrl, '/api/envelope/accept', {
    method: 'POST', token,
    body: { offerId: firstOffer.id, durationUnit: 'day', durationValue: 3 },
  });
  assert.equal(acceptConsumedOfferAgain.status, 404);
  assert.equal(acceptConsumedOfferAgain.data.error, 'no_offer');

  // Глава 1 использует только разовый учебный договор. Прямые запросы не
  // должны включать расписание или чартеры раньше перехода во вторую главу.
  const chapterOneBalance = await request(baseUrl, '/api/state', { token });
  const chapterOneCharter = await request(baseUrl, '/api/charter/order', {
    method: 'POST', token, body: { craft: 'heli', seats: 2 },
  });
  assert.equal(chapterOneCharter.status, 403);
  assert.equal(chapterOneCharter.data.error, 'feature_locked');

  const lockedScheduleRequests = [
    ['/api/schedule/place', { contractId: acceptedContract.data.contracts[0].id, dayIndex: 1, slot: 0 }],
    ['/api/schedule/remove', { id: 'not-used' }],
    ['/api/schedule/row', { contractId: acceptedContract.data.contracts[0].id, row: 0 }],
    ['/api/schedule/clear', {}],
    ['/api/schedule/unassign', { contractId: acceptedContract.data.contracts[0].id }],
    ['/api/schedule/copy-day', { dayIndex: 1, contractId: acceptedContract.data.contracts[0].id }],
  ];
  for (const [route, body] of lockedScheduleRequests) {
    const locked = await request(baseUrl, route, { method: 'POST', token, body });
    assert.equal(locked.status, 403, `${route} must be locked in chapter one`);
    assert.equal(locked.data.error, 'feature_locked', `${route} must return the common progression error`);
  }
  const chapterOneEnvelope = await request(baseUrl, '/api/envelope', { token });
  assert.equal(chapterOneEnvelope.data.contracts.length, 1);
  assert.equal(chapterOneEnvelope.data.schedule.length, 0);
  const chapterOneBalanceAfterLockedRequests = await request(baseUrl, '/api/state', { token });
  assert.equal(chapterOneBalanceAfterLockedRequests.data.money, chapterOneBalance.data.money,
    'locked charter and schedule requests must not charge the airport');

  const upgradeDuringChapterOne = await request(baseUrl, '/api/building/upgrade', {
    method: 'POST', token, body: { cellIndex: completedHelipad.cellIndex },
  });
  assert.equal(upgradeDuringChapterOne.status, 400);
  assert.equal(upgradeDuringChapterOne.data.error, 'chapter_upgrade_cap',
    'chapter one must reject building upgrades above its configured cap');

  const rentOffersForHelipad = await request(baseUrl, '/api/building/rent-offers', {
    method: 'POST', token, body: { cellIndex: completedHelipad.cellIndex },
  });
  assert.equal(rentOffersForHelipad.status, 400);
  assert.equal(rentOffersForHelipad.data.error, 'non_rentable');

  // Глава 1 завершается только после реального первого прилёта и второй
  // построенной площадки. Второй покос запускаем, пока первый борт уже летит,
  // чтобы не добавлять лишнее ожидание в интеграционный сценарий.
  const secondMowing = await request(baseUrl, '/api/quests/mow', {
    method: 'POST', token, body: {},
  });
  assert.equal(secondMowing.status, 200);
  assert.equal(secondMowing.data.mow.mowing, true);

  const firstArrivalDeadline = Date.now() + 35_000;
  let chapterOneProgress = secondMowing.data;
  while (Date.now() < firstArrivalDeadline
      && (chapterOneProgress.mow.credits < 1 || chapterOneProgress.paxArrived < 1)) {
    await wait(150);
    const state = await request(baseUrl, '/api/state', { token });
    assert.equal(state.status, 200);
    chapterOneProgress = state.data;
  }
  assert.ok(chapterOneProgress.mow.credits >= 1,
    `second mowing did not finish before timeout.\\n${logs}`);
  assert.ok(chapterOneProgress.paxArrived >= 1,
    `the chapter-one contract did not deliver its first aircraft.\\n${logs}`);

  const secondHelipadCost = chapterOneProgress.catalog.helipad.cost;
  const secondHelipadBuild = await request(baseUrl, '/api/build', {
    method: 'POST', token, body: { buildingId: 'helipad' },
  });
  assert.equal(secondHelipadBuild.status, 200);
  assert.ok(secondHelipadBuild.data.money <= chapterOneProgress.money - secondHelipadCost);
  assert.equal(secondHelipadBuild.data.mow.credits, 0);
  assert.equal(secondHelipadBuild.data.buildings.filter(
    building => building.buildingId === 'helipad',
  ).length, 2);

  // Глава не должна перейти автоматически при запуске стройки: нужен
  // завершённый объект, после которого тик закроет последнюю задачу главы 1.
  const secondConstructionDeadline = Date.now() + 45_000;
  let chapterOneCompleteState = secondHelipadBuild.data;
  const secondHelipadInProgress = chapterOneCompleteState.buildings.find(
    building => building.buildingId === 'helipad' && building.constructionType === 'build',
  );
  assert.ok(secondHelipadInProgress, 'the second helipad must start as a construction');
  const secondHelipadCellIndex = secondHelipadInProgress.cellIndex;
  let completedSecondHelipad = secondHelipadInProgress;
  while (Date.now() < secondConstructionDeadline
      && (completedSecondHelipad.constructionType !== null
        || chapterOneCompleteState.quests.pendingReward !== 1)) {
    await wait(150);
    const state = await request(baseUrl, '/api/state', { token });
    assert.equal(state.status, 200);
    chapterOneCompleteState = state.data;
    completedSecondHelipad = chapterOneCompleteState.buildings.find(
      building => building.cellIndex === secondHelipadCellIndex,
    );
    assert.ok(completedSecondHelipad, 'the second helipad must remain in the airport');
  }
  assert.ok(completedSecondHelipad, 'the second helipad must remain in the airport');
  assert.equal(completedSecondHelipad.constructionType, null,
    `the second helipad did not finish before timeout.\\n${logs}`);
  assert.equal(chapterOneCompleteState.quests.pendingReward, 1,
    `chapter one should offer its reward after all four tasks are complete.\\n${logs}`);
  assert.equal(chapterOneCompleteState.quests.chapter.id, 1);

  const chapterTwo = await request(baseUrl, '/api/quests/reward/ack', {
    method: 'POST', token, body: {},
  });
  assert.equal(chapterTwo.status, 200);
  assert.equal(chapterTwo.data.quests.chapter.id, 2);
  assert.equal(chapterTwo.data.quests.pendingReward, null);
  assert.equal(chapterTwo.data.chartersAvailable, true);
  assert.ok(chapterTwo.data.openPoints.includes('tihaya'));
  assert.ok(chapterTwo.data.openPoints.includes('ozersk'));
  assert.equal(chapterTwo.data.hasMedicalHeli, false,
    'medical helicopter is the reward for completing chapter two, not entering it');

  // После перехода в главу 2 появляется обычное предложение по одной из
  // открытых точек. Оно уже не разовое: его можно поставить в расписание.
  const chapterTwoOfferDeadline = Date.now() + 15_000;
  let chapterTwoEnvelope = await request(baseUrl, '/api/envelope', { token });
  while (Date.now() < chapterTwoOfferDeadline && chapterTwoEnvelope.data.offers.length === 0) {
    await wait(150);
    chapterTwoEnvelope = await request(baseUrl, '/api/envelope', { token });
  }
  assert.equal(chapterTwoEnvelope.status, 200);
  assert.equal(chapterTwoEnvelope.data.offers.length, 1,
    `chapter two should generate a regular contract offer.\\n${logs}`);
  const chapterTwoOffer = chapterTwoEnvelope.data.offers[0];
  assert.equal(chapterTwoOffer.craft, 'heli');
  assert.ok(chapterTwo.data.openPoints.includes(chapterTwoOffer.pointId));

  const chapterTwoContractResponse = await request(baseUrl, '/api/envelope/accept', {
    method: 'POST', token,
    body: { offerId: chapterTwoOffer.id, durationUnit: 'day', durationValue: 3 },
  });
  assert.equal(chapterTwoContractResponse.status, 200);
  assert.equal(chapterTwoContractResponse.data.contracts.length, 1);
  const chapterTwoContract = chapterTwoContractResponse.data.contracts[0];
  assert.equal(chapterTwoContract.pointId, chapterTwoOffer.pointId);
  assert.equal(chapterTwoContract.craft, 'heli');

  const beforeSchedule = await request(baseUrl, '/api/state', { token });
  assert.equal(beforeSchedule.status, 200);
  const scheduleDay = Math.floor(beforeSchedule.data.tick / beforeSchedule.data.calendar.ticksPerDay) + 1;
  const scheduleSlot = 0;

  const placeBeforeRow = await request(baseUrl, '/api/schedule/place', {
    method: 'POST', token,
    body: { contractId: chapterTwoContract.id, dayIndex: scheduleDay, slot: scheduleSlot },
  });
  assert.equal(placeBeforeRow.status, 400);
  assert.equal(placeBeforeRow.data.error, 'row_required');

  const assignContractRow = await request(baseUrl, '/api/schedule/row', {
    method: 'POST', token,
    body: { contractId: chapterTwoContract.id, row: 0 },
  });
  assert.equal(assignContractRow.status, 200);
  assert.deepEqual(assignContractRow.data.scheduleRows, [chapterTwoContract.id]);

  const scheduledFlight = await request(baseUrl, '/api/schedule/place', {
    method: 'POST', token,
    body: { contractId: chapterTwoContract.id, dayIndex: scheduleDay, slot: scheduleSlot },
  });
  assert.equal(scheduledFlight.status, 200);
  assert.equal(scheduledFlight.data.schedule.length, 1);
  assert.equal(scheduledFlight.data.schedule[0].contractId, chapterTwoContract.id);
  assert.equal(scheduledFlight.data.schedule[0].dayIndex, scheduleDay);
  assert.equal(scheduledFlight.data.schedule[0].slot, scheduleSlot);

  const duplicateScheduleCell = await request(baseUrl, '/api/schedule/place', {
    method: 'POST', token,
    body: { contractId: chapterTwoContract.id, dayIndex: scheduleDay, slot: scheduleSlot },
  });
  assert.equal(duplicateScheduleCell.status, 400);
  assert.equal(duplicateScheduleCell.data.error, 'cell_taken');

  const invalidScheduleSlot = await request(baseUrl, '/api/schedule/place', {
    method: 'POST', token,
    body: { contractId: chapterTwoContract.id, dayIndex: scheduleDay, slot: 12 },
  });
  assert.equal(invalidScheduleSlot.status, 400);
  assert.equal(invalidScheduleSlot.data.error, 'bad_slot');

  const scheduleAfterRejectedRequests = await request(baseUrl, '/api/envelope', { token });
  assert.equal(scheduleAfterRejectedRequests.data.schedule.length, 1,
    'invalid and duplicate schedule requests must not change the existing flight');
  assert.equal(scheduleAfterRejectedRequests.data.schedule[0].id, scheduledFlight.data.schedule[0].id);

  // У аэропорта уже достаточно залоговой стоимости для минимального кредита.
  const loan = await request(baseUrl, '/api/bank/borrow', {
    method: 'POST', token, body: { amount: 5000 },
  });
  assert.equal(loan.status, 200);
  assert.equal(loan.data._bank.loan.amount, 5000);
  assert.ok(loan.data._bank.loan.left > 5000);

  const secondLoan = await request(baseUrl, '/api/bank/borrow', {
    method: 'POST', token, body: { amount: 5000 },
  });
  assert.equal(secondLoan.status, 400);
  assert.equal(secondLoan.data.error, 'has_loan');

  const repayment = await request(baseUrl, '/api/bank/repay', {
    method: 'POST', token, body: {},
  });
  assert.equal(repayment.status, 200);
  assert.equal(repayment.data.bank.loan, null, 'early repayment must clear the loan');
  assert.ok(repayment.data.money < loan.data.money, 'repayment must deduct the outstanding balance');

  // Второй игрок не должен видеть или сносить постройку первого игрока,
  // даже если знает её cellIndex.
  const secondRegistration = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { username: 'ApiIntegrationTwo', password: 'Integration-Password-2026' },
  });
  assert.equal(secondRegistration.status, 200);
  const secondLogin = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'ApiIntegrationTwo', password: 'Integration-Password-2026' },
  });
  assert.equal(secondLogin.status, 200);
  const secondToken = secondLogin.data.token;
  const secondStart = await request(baseUrl, '/api/start-game', {
    method: 'POST', token: secondToken, body: {},
  });
  assert.equal(secondStart.status, 200);

  const crossPlayerDemolish = await request(baseUrl, '/api/building/demolish', {
    method: 'POST', token: secondToken, body: { cellIndex: helipad.cellIndex },
  });
  assert.equal(crossPlayerDemolish.status, 404);
  assert.equal(crossPlayerDemolish.data.error, 'no_building');

  const ownAdministrationDemolish = await request(baseUrl, '/api/building/demolish', {
    method: 'POST', token: secondToken, body: { cellIndex: 0 },
  });
  assert.equal(ownAdministrationDemolish.status, 400);
  assert.equal(ownAdministrationDemolish.data.error, 'not_removable');

  const firstPlayerBeforeRestart = await request(baseUrl, '/api/state', { token });
  assert.ok(firstPlayerBeforeRestart.data.buildings.some(building => building.buildingId === 'helipad'),
    'a failed cross-player action must not change the owner airport');

  // Повторный старт очищает старые объекты и возвращает исходный аэропорт,
  // сохраняя результат предыдущего прохождения.
  const restarted = await request(baseUrl, '/api/airport/restart', {
    method: 'POST', token, body: {},
  });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.data.money, 12_000);
  assert.equal(restarted.data.level, 1);
  assert.deepEqual(restarted.data.buildings.map(building => building.buildingId), ['admin']);
  assert.equal(restarted.data.previousResult.buildingsBuilt, 2);

  const deleted = await request(baseUrl, '/api/account/delete', {
    method: 'POST', token: secondToken, body: {},
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);
  const deletedAccountMe = await request(baseUrl, '/api/me', { token: secondToken });
  assert.equal(deletedAccountMe.status, 401);

  const firstPlayerAfterSecondDeleted = await request(baseUrl, '/api/state', { token });
  assert.equal(firstPlayerAfterSecondDeleted.status, 200);
  assert.equal(firstPlayerAfterSecondDeleted.data.money, 12_000);

  const saved = JSON.parse(fs.readFileSync(tempDataFile, 'utf8'));
  assert.equal(saved.users.length, 2, 'isolated save contains the admin and surviving test account');
  assert.equal(saved.airports.length, 2, 'deleting the second account must also remove its airport');
  assertFileUnchanged(productionDataFile, productionDataBefore);
  assertFileUnchanged(productionLockFile, productionLockBefore);
  assert.ok(fs.existsSync(tempMediaDir), 'test media folders should live only in the temporary directory');
});
