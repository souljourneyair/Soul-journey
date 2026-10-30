'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function getRunTickSource() {
  const start = source.indexOf('function runTick() {');
  assert.notEqual(start, -1, 'runTick() must exist');

  const end = source.indexOf('\nfunction processAircraftTick', start);
  assert.notEqual(end, -1, 'runTick() must end before processAircraftTick()');
  assert.ok(end > start, 'runTick() source range must be valid');

  return source.slice(start, end);
}

test('runTick initializes per-airport notifications before any notification is used', () => {
  const runTick = getRunTickSource();
  const airportLoop = runTick.indexOf('for (const airport of airports)');
  const declaration = runTick.indexOf('const notifications = [];');
  const firstUse = runTick.search(/notifications\s*\./);

  assert.notEqual(airportLoop, -1, 'runTick() must iterate through airports');
  assert.notEqual(declaration, -1, 'notifications array must be declared');
  assert.notEqual(firstUse, -1, 'notifications must be used in runTick()');

  assert.ok(declaration > airportLoop,
    'notifications must be isolated per airport, inside the airport loop');
  assert.ok(declaration < firstUse,
    'notifications must be declared before the first read or write');
});

test('fuel contract break notification is inside the initialized airport scope', () => {
  const runTick = getRunTickSource();
  const declaration = runTick.indexOf('const notifications = [];');
  const breakCondition = runTick.indexOf('if (fresh.money <= 0)');
  const breakNotification = runTick.indexOf('notifications.push(\'⛽ Контракт с поставщиком разорван');

  assert.notEqual(declaration, -1, 'notifications array must be declared');
  assert.notEqual(breakCondition, -1, 'fuel contract must handle insufficient funds');
  assert.notEqual(breakNotification, -1, 'fuel contract break must notify the player');

  assert.ok(declaration < breakCondition,
    'notifications must exist before the insufficient-funds branch');
  assert.ok(breakCondition < breakNotification,
    'break notification must remain in the insufficient-funds branch');
});
