'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSafely, runEachSafely } = require('../tickSafety');

test('one airport failure is reported and later airports still run', () => {
  const visited = [];
  const errors = [];
  const airports = [{ id: 1 }, { id: 2 }, { id: 3 }];

  const result = runEachSafely(
    airports,
    airport => {
      visited.push(airport.id);
      if (airport.id === 2) throw new Error('broken airport');
    },
    (error, airport, index) => errors.push({
      message: error.message,
      airportId: airport.id,
      index,
    }),
  );

  assert.deepEqual(visited, [1, 2, 3]);
  assert.deepEqual(errors, [{ message: 'broken airport', airportId: 2, index: 1 }]);
  assert.deepEqual(result, { processed: 2, failed: 1 });
});

test('tick-level wrapper catches a global failure without throwing into the event loop', () => {
  const errors = [];
  const result = runSafely(
    () => { throw new Error('market failed'); },
    error => errors.push(error.message),
  );

  assert.equal(result.ok, false);
  assert.match(result.error.message, /market failed/);
  assert.deepEqual(errors, ['market failed']);
});

test('successful wrapped task preserves its return value', () => {
  const result = runSafely(() => 42, () => assert.fail('unexpected error callback'));
  assert.deepEqual(result, { ok: true, value: 42 });
});

test('a failing error reporter does not prevent the remaining items from running', () => {
  const oldError = console.error;
  const logged = [];
  const visited = [];
  console.error = (...args) => logged.push(args);
  try {
    const result = runEachSafely(
      [1, 2, 3],
      value => {
        visited.push(value);
        if (value === 1) throw new Error('item failure');
      },
      () => { throw new Error('reporter failure'); },
    );
    assert.deepEqual(visited, [1, 2, 3]);
    assert.deepEqual(result, { processed: 2, failed: 1 });
    assert.equal(logged.length, 1);
  } finally {
    console.error = oldError;
  }
});
