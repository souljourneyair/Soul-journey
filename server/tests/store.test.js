'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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
  assert.match(result.stderr, /Конфликт хранилища|data\.json был изменён или удалён/i);
});

test('a second process cannot open a save file while another process owns its lock', async (t) => {
  const fixture = createFixture(t);
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(fixture.storePath)});
    process.stdout.write('READY');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });

  let childStderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { childStderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('store process did not acquire lock')), 5000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`store process exited early (${code}): ${childStderr}`)));
    child.stdout.once('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  assert.equal(fs.existsSync(fixture.dataPath + '.lock'), true);
  const second = runStore(fixture, 'store.getAllUsers();');
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Файл блокировки.*уже существует/);

  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(fs.existsSync(fixture.dataPath + '.lock'), false, 'lock should be released after clean shutdown');
});

test('external edits are not reloaded over the in-memory cache', (t) => {
  const initial = JSON.stringify({ users: [], airports: [], buildings: [] });
  const fixture = createFixture(t, initial);
  const external = JSON.stringify({ users: [{ id: 77, username: 'External' }], airports: [], buildings: [] });
  const result = runStore(fixture, `
    const fs = require('node:fs');
    store.getAllUsers();
    fs.writeFileSync(${JSON.stringify(fixture.dataPath)}, ${JSON.stringify(external)}, 'utf8');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    store.getAllUsers();
  `);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Конфликт хранилища/);
  assert.equal(fs.readFileSync(fixture.dataPath, 'utf8'), external);
  const backups = fs.readdirSync(fixture.root).filter(name => name.startsWith('data.json.memory-conflict-'));
  assert.equal(backups.length, 1);
  const memoryCopy = JSON.parse(fs.readFileSync(path.join(fixture.root, backups[0]), 'utf8'));
  assert.deepEqual(memoryCopy.users, []);
});

test('a dirty cache is backed up instead of overwriting an external edit', (t) => {
  const initial = JSON.stringify({ users: [], airports: [], buildings: [] });
  const fixture = createFixture(t, initial);
  const external = JSON.stringify({ users: [{ id: 88, username: 'ExternalNewer' }], airports: [], buildings: [] });
  const result = runStore(fixture, `
    const fs = require('node:fs');
    store.getAllUsers();
    store.createUser('UnsavedMemoryUser', 'test-hash');
    fs.writeFileSync(${JSON.stringify(fixture.dataPath)}, ${JSON.stringify(external)}, 'utf8');
    if (store.flush()) process.exit(3);
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fixture.dataPath, 'utf8'), external);
  const backups = fs.readdirSync(fixture.root).filter(name => name.startsWith('data.json.memory-conflict-'));
  assert.equal(backups.length, 1);
  const memoryCopy = JSON.parse(fs.readFileSync(path.join(fixture.root, backups[0]), 'utf8'));
  assert.equal(memoryCopy.users.some(user => user.username === 'UnsavedMemoryUser'), true);
});
