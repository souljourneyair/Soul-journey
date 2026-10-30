'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceStore = path.join(__dirname, '..', 'store.js');

function createFixture(t, initialData) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-journey-store-'));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  const storePath = path.join(serverDir, 'store.js');
  const dataPath = path.join(root, 'data.json');

  fs.copyFileSync(sourceStore, storePath);
  if (initialData !== undefined) fs.writeFileSync(dataPath, initialData, 'utf8');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storePath, dataPath };
}

function runStore(fixture, code) {
  const source = `const store = require(${JSON.stringify(fixture.storePath)});\n${code}`;
  return spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('first start creates a new save file on the first write', (t) => {
  const fixture = createFixture(t);
  const result = runStore(fixture, `
    if (store.getAllUsers().length !== 0) process.exit(2);
    store.createUser('InitialAdmin', 'test-hash');
    if (!store.flush()) process.exit(3);
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.dataPath), true);
  const saved = JSON.parse(fs.readFileSync(fixture.dataPath, 'utf8'));
  assert.equal(saved.users.length, 1);
  assert.equal(saved.users[0].username, 'InitialAdmin');
});

test('malformed JSON is backed up and is never replaced with an empty database', (t) => {
  const original = '{"users": [ this is not valid JSON';
  const fixture = createFixture(t, original);
  const result = runStore(fixture, 'store.getAllUsers();');

  assert.notEqual(result.status, 0, 'store must stop instead of returning an empty database');
  assert.match(result.stderr, /повреждён или имеет неверную структуру/i);
  assert.equal(fs.readFileSync(fixture.dataPath, 'utf8'), original);

  const backups = fs.readdirSync(fixture.root).filter(name => name.startsWith('data.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.root, backups[0]), 'utf8'), original);
});

test('valid JSON with an invalid database structure is backed up', (t) => {
  const original = JSON.stringify({ users: 'not-an-array', airports: [], buildings: [] });
  const fixture = createFixture(t, original);
  const result = runStore(fixture, 'store.getAllUsers();');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Поле "users" должно быть массивом/);
  assert.equal(fs.readFileSync(fixture.dataPath, 'utf8'), original);
  assert.equal(fs.readdirSync(fixture.root).filter(name => name.startsWith('data.json.corrupt-')).length, 1);
});

test('legacy null collection fields are normalized instead of rejected', (t) => {
  const fixture = createFixture(t, JSON.stringify({
    users: null,
    airports: null,
    buildings: null,
    aircraft: null,
    settings: null,
  }));
  const result = runStore(fixture, 'if (store.getAllUsers().length !== 0) process.exit(2);');

  assert.equal(result.status, 0, result.stderr);
});

test('deleting an existing save while the server is running does not reset it to an empty database', (t) => {
  const fixture = createFixture(t);
  const result = runStore(fixture, `
    store.createUser('ExistingPlayer', 'test-hash');
    if (!store.flush()) process.exit(2);
    require('node:fs').unlinkSync(${JSON.stringify(fixture.dataPath)});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    store.getAllUsers();
  `);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Не удалось проверить файл сохранений/);
});
