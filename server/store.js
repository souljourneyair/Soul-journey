// Лёгкое файловое хранилище на чистом Node.js fs — без нативных зависимостей.
//
// ЕДИНСТВЕННЫЙ ВЛАДЕЛЕЦ БАЗЫ.
//
// В каждый момент времени только один процесс может открыть data.json на
// запись: для этого создаётся эксклюзивный data.json.lock. Рабочая копия
// загружается в память один раз и остаётся единственным источником истины
// до завершения процесса. Изменения записываются с задержкой, атомарно.
//
// Периодическая stat-проверка не перечитывает файл, а только обнаруживает
// постороннее изменение. Если файл заменили, удалили или отредактировали
// при работающем процессе, хранилище фиксирует конфликт, сохраняет отдельную
// копию состояния из памяти и отказывается перезаписывать data.json.
//
// Сервисные скрипты (например, reset-password.js) запускаются только после
// остановки сервера. Это исключает конкурирующие записи и потерю изменений.
//
// При росте нагрузки — замена на Postgres/SQLite делается без изменения
// остального кода, только этого файла.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const LOCK_FILE = `${DATA_FILE}.lock`;

const EMPTY_DB = {
  nextUserId: 1,
  nextAirportId: 1,
  nextBuildingId: 1,
  nextLeaderboardId: 1,
  nextMediaId: 1,
  nextAircraftId: 1,
  nextContractId: 1,
  tickCounter: 0,   // монотонный счётчик тиков (для расписания рейсов самолётов)
  users: [],        // { id, username, passwordHash, token, createdAt, isAdmin, bannedUntil }
  airports: [],      // { id, userId, startType, money, reputation, xp, level, startedAt, reachedLevel10At }
  buildings: [],      // { id, airportId, cellIndex, buildingId, builtAt, state, botName, rentPrice, listedPrice, customIcon, customName, upgradeLevel }
  aircraft: [],       // { id, airportId, typeId, ownership('owned'|'lease'), status('idle'|'flying'|'waiting'), wear, flightEndsTick, boughtAt }
  contractOffers: [], // предложения авиакомпаний в конверте { id, airportId, airline, payPerTick, durationTicks, createdTick, expiresTick, thinking }
  contracts: [],      // активные договоры { id, airportId, airline, payPerTick, endsTick, signedTick }
  leaderboard: [],    // { id, username, startType, elapsedSeconds, achievedAt }
  buildingLabelStyles: {}, // { [buildingId]: { fontSize, color } } — глобально, одинаково у всех игроков
  buildingNames: {},        // { [buildingId]: "Своё название" } — глобальное переименование объекта, одинаково у всех игроков
  buildingDescriptions: {},  // { [buildingId]: "Своё описание" } — глобальное описание объекта, одинаково у всех игроков
  settings: {},              // глобальные настройки игры (логотип и т.п.)
};

// ---------- кэш ----------
const STAT_CHECK_MS = 250;   // как часто сверяться с файлом на диске
const FLUSH_MS = 500;        // как часто сбрасывать изменения на диск

let cache = null;
let dirty = false;           // есть несохранённые изменения
let lastStatCheck = 0;
let flushTimer = null;
let dataFileSignature = null; // версия файла, которую сейчас представляет кэш
let storageConflict = null;   // внешняя запись/второй процесс: сохранять поверх нельзя
let storeLockOwned = false;
let storeLockInstance = null;

function cloneEmptyDb() {
  return JSON.parse(JSON.stringify(EMPTY_DB));
}

// Подпись файла включает inode, размер и времена изменения: этого достаточно
// для обнаружения атомарной замены и обычного внешнего редактирования.
function diskSignature() {
  try {
    // BigIntStats сохраняет точность времени до наносекунд там, где её
    // поддерживает файловая система, и снижает риск пропустить быструю замену.
    const stat = fs.statSync(DATA_FILE, { bigint: true });
    return [
      String(stat.dev), String(stat.ino), String(stat.size),
      String(stat.mtimeNs), String(stat.ctimeNs),
    ].join(':');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function uniqueDataPath(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${DATA_FILE}.${kind}-${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

// Эксклюзивная блокировка не позволяет запустить два процесса, использующих
// один data.json. Устаревший lock-файл удаляется вручную только после проверки,
// что указанный PID больше не работает: автоматическое удаление создаёт гонки.
function acquireStoreLock() {
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') {
      let owner = '';
      try { owner = fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch (readError) { /* покажем общий текст */ }
      throw new Error(
        `[store] Файл блокировки ${LOCK_FILE} уже существует. ` +
        `Возможно, другой процесс Soul Journey использует эту базу. ` +
        `Остановите его перед запуском второго процесса. Данные владельца: ${owner || 'не удалось прочитать'}.` +
        ` Если сервер аварийно завершился, сначала убедитесь, что указанный PID не работает, и только затем удалите lock-файл вручную.`
      );
    }
    throw new Error(`[store] Не удалось создать блокировку базы ${LOCK_FILE}: ${e.message}`);
  }

  try {
    storeLockInstance = crypto.randomBytes(8).toString('hex');
    const owner = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      instance: storeLockInstance,
    }) + '\n';
    fs.writeFileSync(fd, owner, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    storeLockOwned = true;
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* исходная ошибка важнее */ }
    }
    try { fs.unlinkSync(LOCK_FILE); } catch (unlinkError) { /* best effort */ }
    throw new Error(`[store] Не удалось записать файл блокировки ${LOCK_FILE}: ${e.message}`);
  }
}

function releaseStoreLock() {
  if (!storeLockOwned) return;
  storeLockOwned = false;
  try {
    const owner = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (owner.pid !== process.pid || owner.instance !== storeLockInstance) {
      console.error(`[store] Файл блокировки ${LOCK_FILE} был заменён другим процессом; не удаляю чужую блокировку.`);
      return;
    }
    fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[store] Не удалось безопасно удалить файл блокировки ${LOCK_FILE}: ${e.message}`);
    }
  }
}

function writeMemoryConflictBackup() {
  if (!cache) return null;
  const backupPath = uniqueDataPath('memory-conflict');
  let fd = null;
  try {
    fd = fs.openSync(backupPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(cache), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return backupPath;
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* best effort */ }
    }
    try { fs.unlinkSync(backupPath); } catch (unlinkError) { /* best effort */ }
    console.error(`[store] Не удалось создать копию кэша при конфликте: ${e.message}`);
    return null;
  }
}

function failOnStorageConflict(reason) {
  if (!storageConflict) {
    const backupPath = writeMemoryConflictBackup();
    const backupNote = backupPath
      ? ` Копия данных из памяти сохранена в ${backupPath}.`
      : ' Не удалось создать копию данных из памяти; текущий процесс продолжает хранить их в памяти.';
    storageConflict = new Error(
      `[store] Конфликт хранилища: ${reason}. ` +
      'Файл data.json не будет перезаписан автоматически. Остановите сервер и вручную сравните файл и резервную копию.' +
      backupNote
    );
    console.error(storageConflict.message);
  }
  throw storageConflict;
}

acquireStoreLock();

// Повреждённый файл никогда не заменяем пустой базой. Перед остановкой
// загрузки сохраняем исходник рядом с data.json под уникальным именем.
function corruptedDataError(message, cause) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DATA_FILE}.corrupt-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.copyFileSync(DATA_FILE, backupPath, fs.constants.COPYFILE_EXCL);
    return new Error(`[store] ${message}. Исходный файл сохранён: ${backupPath}. Сервер остановлен, чтобы не перезаписать сохранения.`);
  } catch (backupError) {
    return new Error(`[store] ${message}. Не удалось создать резервную копию (${backupError.message}). Сервер остановлен, исходный файл не изменён.`);
  }
}

function validateDatabaseShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Корень data.json должен быть JSON-объектом');
  }

  for (const [key, defaultValue] of Object.entries(EMPTY_DB)) {
    if (Array.isArray(defaultValue) && data[key] != null && !Array.isArray(data[key])) {
      throw new Error(`Поле "${key}" должно быть массивом`);
    }
    if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)
        && data[key] != null
        && (typeof data[key] !== 'object' || Array.isArray(data[key]))) {
      throw new Error(`Поле "${key}" должно быть объектом`);
    }
  }
}

function readFromDisk() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf-8');
  } catch (e) {
    throw new Error(`[store] Не удалось прочитать существующий файл ${DATA_FILE}: ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    validateDatabaseShape(parsed);
  } catch (e) {
    throw corruptedDataError(`Файл ${DATA_FILE} повреждён или имеет неверную структуру: ${e.message}`, e);
  }

  // Для старых сохранений подставляем значения новых полей, не затрагивая
  // уже существующие пользовательские данные.
  const data = Object.assign(cloneEmptyDb(), parsed);
  // Старые версии уже допускали null в необязательных полях. Нормализуем их
  // к пустым значениям, но не принимаем строки/числа вместо коллекций.
  for (const [key, defaultValue] of Object.entries(EMPTY_DB)) {
    if (Array.isArray(defaultValue) && !Array.isArray(data[key])) {
      data[key] = [];
    } else if (defaultValue && typeof defaultValue === 'object'
        && !Array.isArray(defaultValue)
        && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) {
      data[key] = {};
    }
  }

  try {
    if (data.nextMediaId === undefined) data.nextMediaId = 1;
    // Износ ВПП переехал в общее для всех зданий поле wear. Переносим старое
    // значение у уже наигранных сохранений, чтобы накопленный износ не пропал
    // и чтобы в панели не оказалось двух разных повреждений у одной полосы.
    if (Array.isArray(data.buildings)) {
      for (const b of data.buildings) {
        if (b.rwWear !== undefined) {
          if (b.wear === undefined) b.wear = b.rwWear;
          delete b.rwWear;
        }
        if (b.rwRepairEndsTick !== undefined) {
          if (b.repairEndsTick === undefined) b.repairEndsTick = b.rwRepairEndsTick;
          delete b.rwRepairEndsTick;
        }
        if (b.wear === undefined) b.wear = 0;
        if (b.ruined === undefined) b.ruined = false;
      }
    }
    if (!data.buildingLabelStyles) data.buildingLabelStyles = {};
    if (!data.buildingNames) data.buildingNames = {};
    if (!data.buildingDescriptions) data.buildingDescriptions = {};
    if (!data.settings) data.settings = {};
    if (data.settings.authBgUrl === undefined) data.settings.authBgUrl = null;
    if (data.settings.authBgKind === undefined) data.settings.authBgKind = null;
    if (data.settings.gameBgUrl === undefined) data.settings.gameBgUrl = null;
    if (data.settings.gameBgKind === undefined) data.settings.gameBgKind = null;
    if (data.settings.oilPrice === undefined) data.settings.oilPrice = 70;
    if (data.settings.goldPrice === undefined) data.settings.goldPrice = 2000;
    if (data.settings.fuelMarketMult === undefined) data.settings.fuelMarketMult = 1.0;
    if (data.settings.fuelMarketRepricedTick === undefined) data.settings.fuelMarketRepricedTick = 0;
    if (!Array.isArray(data.settings.marketHistory)) data.settings.marketHistory = [];
    if (data.settings.marketHourTick === undefined) data.settings.marketHourTick = 0;
    if (data.nextAircraftId === undefined) data.nextAircraftId = 1;
    if (!data.aircraft) data.aircraft = [];
    (data.aircraft || []).forEach(a => {
      if (a.auto === undefined) a.auto = false;
      if (a.upgradeLevel === undefined) a.upgradeLevel = 1;
      if (a.totalEarnings === undefined) a.totalEarnings = 0;
      if (a.decommissioned === undefined) a.decommissioned = false;
      if (a.repairEndsTick === undefined) a.repairEndsTick = null;
    });
    (data.airports || []).forEach(a => {
      if (a.name === undefined) a.name = null;
      if (a.airline === undefined) a.airline = null;
      if (a.airlineOfferSeen === undefined) a.airlineOfferSeen = false;
      if (a.idleSinceTick === undefined) a.idleSinceTick = null;
      if (a.bankrupt === undefined) a.bankrupt = false;
      if (!a.apronBorts) a.apronBorts = [];
      if (!a.waitingBorts) a.waitingBorts = [];
      if (a.fuelStored === undefined) a.fuelStored = 0;
      if (a.fuelSupplier === undefined) a.fuelSupplier = null;
      if (a.fuelContract === undefined) a.fuelContract = null;
      if (a.fuelAutoContract === undefined) a.fuelAutoContract = false;
      if (a.fuelRefillThreshold === undefined) a.fuelRefillThreshold = 25;
      if (!a.paxPool) a.paxPool = { heli: 0, vvl: 0, mvl: 0 };
      if (a.heliCarried === undefined) a.heliCarried = 0;
      if (a.paxServed === undefined) a.paxServed = 0;
      // Исторический недоучёт: прилёты писались в paxProcessed, но не в
      // paxServed. Подтягиваем общий счёт «обслужено» до пропущенного значения.
      if ((a.paxProcessed || 0) > a.paxServed) a.paxServed = a.paxProcessed;
      if (!a.termQueue) a.termQueue = [];
      if (!a.newsLog) a.newsLog = [];
      if (a.lastAircraftEventTick === undefined) a.lastAircraftEventTick = 0;
      if (a.ratingBoostEndsTick === undefined) a.ratingBoostEndsTick = null;
      if (a.previousResult === undefined) a.previousResult = null;
    });
    if (data.tickCounter === undefined) data.tickCounter = 0;
    if (data.nextContractId === undefined) data.nextContractId = 1;
    if (!data.contractOffers) data.contractOffers = [];
    if (!data.contracts) data.contracts = [];
    (data.buildings || []).forEach(b => {
      if (b.upgradeLevel === undefined) b.upgradeLevel = 1;
      if (b.constructionEndsTick === undefined) b.constructionEndsTick = null;
      if (b.constructionType === undefined) b.constructionType = null;
      if (b.pendingUpgradeLevel === undefined) b.pendingUpgradeLevel = null;
      if (b.pendingXp === undefined) b.pendingXp = 0;
      // пересборка списка ВПП: вторая ВПП переименована, третья убрана
      if (b.buildingId === 'runway_2') b.buildingId = 'runway_big';
      // старая единая стоянка (apron) → малая стоянка ВС
      if (b.buildingId === 'apron') b.buildingId = 'stand_small';
    });
    // удаляем здания снятой с игры Третьей ВПП
    data.buildings = data.buildings.filter(b => b.buildingId !== 'runway_3');
    (data.users || []).forEach(u => {
      if (u.isAdmin === undefined) u.isAdmin = false;
      if (u.bannedUntil === undefined) u.bannedUntil = null;
      if (u.mustChangePassword === undefined) u.mustChangePassword = false;
    });
    return data;
  } catch (e) {
    throw corruptedDataError(`Не удалось безопасно применить миграции к ${DATA_FILE}: ${e.message}`, e);
  }
}

function load() {
  if (storageConflict) throw storageConflict;

  const now = Date.now();
  // В памяти всегда находится единственная рабочая копия этой базы.
  // Периодическая stat-проверка нужна только для обнаружения внешней записи:
  // автоматически подменять кэш новой версией файла во время работы нельзя.
  if (cache && now - lastStatCheck < STAT_CHECK_MS) return cache;
  lastStatCheck = now;

  let currentSignature;
  try {
    currentSignature = diskSignature();
  } catch (e) {
    failOnStorageConflict(`не удалось проверить файл сохранений: ${e.message}`);
  }

  if (!cache) {
    if (currentSignature === null) {
      cache = cloneEmptyDb();
      dataFileSignature = null;
      return cache;
    }

    const nextCache = readFromDisk();
    let afterReadSignature;
    try {
      afterReadSignature = diskSignature();
    } catch (e) {
      failOnStorageConflict(`файл изменился во время чтения: ${e.message}`);
    }
    if (afterReadSignature !== currentSignature) {
      failOnStorageConflict('data.json изменился во время первоначальной загрузки');
    }

    cache = nextCache;
    dataFileSignature = currentSignature;
    return cache;
  }

  if (currentSignature !== dataFileSignature) {
    failOnStorageConflict('data.json был изменён или удалён извне во время работы процесса');
  }

  return cache;
}

// Немедленно записать накопленное на диск атомарной заменой.
function flush(options = {}) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (storageConflict) return false;
  if (!dirty || !cache) return true;

  // Перед каждой записью убеждаемся, что файл всё ещё тот, который мы
  // загрузили или записали сами. При несовпадении сохраняем кэш отдельно.
  let currentSignature;
  try {
    currentSignature = diskSignature();
  } catch (e) {
    try { failOnStorageConflict(`не удалось проверить data.json перед записью: ${e.message}`); }
    catch (conflictError) { return false; }
  }
  if (!storageConflict && currentSignature !== dataFileSignature) {
    try { failOnStorageConflict('data.json изменился до очередной записи'); }
    catch (conflictError) { return false; }
  }

  const tmp = `${DATA_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fd = null;
  try {
    const serialized = JSON.stringify(cache);
    let mode = 0o600;
    try { mode = fs.statSync(DATA_FILE).mode & 0o777; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, serialized, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // До успешного rename dirty остаётся true: при ошибке данные остаются
    // в памяти и следующая попытка сможет повторить сохранение.
    // Повторная проверка непосредственно перед rename сужает окно гонки
    // при ручной записи в data.json сторонней программой.
    const signatureBeforeReplace = diskSignature();
    if (signatureBeforeReplace !== dataFileSignature) {
      failOnStorageConflict('data.json изменился непосредственно перед заменой');
    }

    fs.renameSync(tmp, DATA_FILE);
    dirty = false;
    try {
      dataFileSignature = diskSignature();
      if (dataFileSignature === null) {
        failOnStorageConflict('файл data.json исчез сразу после сохранения');
      }
      lastStatCheck = Date.now();
    } catch (e) {
      if (storageConflict) throw e;
      failOnStorageConflict(`не удалось проверить сохранённый файл: ${e.message}`);
    }
    return true;
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* сохраняем исходную ошибку */ }
    }
    try { fs.unlinkSync(tmp); } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') {
        console.error(`[store] Не удалось удалить временный файл ${tmp}: ${unlinkError.message}`);
      }
    }
    console.error(`[store] Не удалось сохранить ${DATA_FILE}: ${e.message}. Несохранённые данные сохранены в памяти.`);
    if (options.retry !== false && !storageConflict && !flushTimer) {
      flushTimer = setTimeout(() => flush(), Math.max(FLUSH_MS, 2000));
    }
    return false;
  }
}

function save(data) {
  cache = data;
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(() => flush(), FLUSH_MS);
}

// При штатном завершении делаем последнюю синхронную попытку сохранения.
process.on('exit', () => {
  if (!flush({ retry: false })) {
    console.error('[store] ВНИМАНИЕ: завершение процесса с несохранёнными изменениями.');
  }
  releaseStoreLock();
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    const saved = flush({ retry: false });
    if (!saved) {
      console.error('[store] Сервер завершает работу с ошибкой: последние изменения не удалось сохранить.');
    }
    process.exit(saved ? 0 : 1);
  });
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- users ----------
function createUser(username, passwordHash, options = {}) {
  const data = load();
  const user = {
    id: data.nextUserId++,
    username,
    passwordHash,
    token: newToken(),
    createdAt: Date.now(),
    isAdmin: false,
    mustChangePassword: !!options.mustChangePassword,
    bannedUntil: null, // null | 'forever' | timestamp(ms)
  };
  data.users.push(user);
  save(data);
  return user;
}

// Логины сравниваем без учёта регистра и крайних пробелов: «Vasya», «vasya»
// и « VASYA » — один и тот же аккаунт. В data.json при этом хранится
// написание, которое ввёл игрок: оно показывается в интерфейсе и таблице
// рекордов, меняется только правило сравнения.
function normalizeUsername(username) {
  return String(username == null ? '' : username).trim().toLowerCase();
}

function findUserByUsername(username) {
  const data = load();
  const key = normalizeUsername(username);
  if (!key) return null;
  return data.users.find(u => normalizeUsername(u.username) === key) || null;
}

// Логины, различающиеся только регистром (могли завестись до того, как
// сравнение стало нечувствительным). Возвращает [[логин, логин], ...].
function findCaseDuplicateUsernames() {
  const data = load();
  const byKey = new Map();
  for (const u of data.users) {
    const key = normalizeUsername(u.username);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(u.username);
  }
  return [...byKey.values()].filter(names => names.length > 1);
}

function findUserByToken(token) {
  const data = load();
  return data.users.find(u => u.token === token) || null;
}

function findUserById(id) {
  const data = load();
  return data.users.find(u => u.id === id) || null;
}

function setUserPassword(username, passwordHash, options = {}) {
  const data = load();
  const key = normalizeUsername(username);
  const user = data.users.find(u => normalizeUsername(u.username) === key);
  if (!user) return null;
  user.passwordHash = passwordHash;
  if (typeof options.mustChangePassword === 'boolean') {
    user.mustChangePassword = options.mustChangePassword;
  }
  save(data);
  return user;
}

function setUserMustChangePassword(username, required) {
  const data = load();
  const key = normalizeUsername(username);
  const user = data.users.find(u => normalizeUsername(u.username) === key);
  if (!user) return null;
  user.mustChangePassword = !!required;
  save(data);
  return user;
}

function getAllUsers() {
  const data = load();
  return data.users;
}

function setUserAdmin(username, isAdmin) {
  const data = load();
  const key = normalizeUsername(username);
  const user = data.users.find(u => normalizeUsername(u.username) === key);
  if (!user) return null;
  user.isAdmin = isAdmin;
  save(data);
  return user;
}

function setUserBan(username, bannedUntil) {
  const data = load();
  const key = normalizeUsername(username);
  const user = data.users.find(u => normalizeUsername(u.username) === key);
  if (!user) return null;
  user.bannedUntil = bannedUntil; // null | 'forever' | timestamp(ms)
  save(data);
  return user;
}

function isBanActive(user) {
  if (!user || !user.bannedUntil) return false;
  if (user.bannedUntil === 'forever') return true;
  return Date.now() < user.bannedUntil;
}

// Полное удаление пользователя со всеми его данными (аэропорт, здания, самолёты).
function deleteUser(userId) {
  const data = load();
  const airports = data.airports.filter(a => a.userId === userId);
  const airportIds = new Set(airports.map(a => a.id));
  data.buildings = data.buildings.filter(b => !airportIds.has(b.airportId));
  data.aircraft = (data.aircraft || []).filter(a => !airportIds.has(a.airportId));
  data.contractOffers = (data.contractOffers || []).filter(o => !airportIds.has(o.airportId));
  data.contracts = (data.contracts || []).filter(c => !airportIds.has(c.airportId));
  data.airports = data.airports.filter(a => a.userId !== userId);
  // Рекорды привязаны к имени, а не к идентификатору: без чистки новый игрок,
  // зарегистрировавшийся под тем же логином, унаследовал бы чужое достижение.
  const gone = data.users.find(u => u.id === userId);
  if (gone) {
    const key = normalizeUsername(gone.username);
    data.leaderboard = (data.leaderboard || [])
      .filter(r => normalizeUsername(r.username) !== key);
  }
  data.users = data.users.filter(u => u.id !== userId);
  save(data);
}

// ---------- airports ----------
function createAirport(userId, startType, money) {
  const data = load();
  const airport = {
    id: data.nextAirportId++,
    userId,
    startType,
    name: null,             // название аэропорта (вводится при первом входе)
    airline: null,           // название собственной авиакомпании (создаётся с 5 уровня)
    airlineOfferSeen: false,  // показывали ли предложение создать АК на 5 уровне
    money,
    reputation: 0,
    xp: 0,
    level: 0,
    startedAt: Date.now(),
    reachedLevel10At: null,
    idleSinceTick: null,   // с какого тика аэропорт простаивает (null = сейчас активен)
    bankrupt: false,        // флаг банкротства (долг достиг дна)
    apronBorts: [],         // борты на стоянке (занимают места): { contractId, airline, departsTick, payPerArrival }
    waitingBorts: [],       // борты в очереди на посадку: { contractId, airline, waitingSinceTick, payPerArrival }
    fuelStored: 0,          // текущий запас топлива на складе (единиц)
    fuelSupplier: null,     // id выбранного поставщика топлива (биржа)
    fuelContract: null,     // активный контракт { supplierId, pricePerUnit, endsTick }
    fuelAutoContract: false, // автопродление контракта (ур.6+)
    fuelRefillThreshold: 25, // порог автодозаправки (% вместимости)
    // Пулы ожидающих ВЫЛЕТА пассажиров по типам (копятся генерацией трафика)
    paxPool: { heli: 0, vvl: 0, mvl: 0 },
    heliCarried: 0,         // всего перевезено вертолётами (для формулы числа пассажиров)
    paxServed: 0,           // всего обслужено пассажиров (улетевшие+прилетевшие, верт.+самолёты)
    // Очередь на обслуживание в терминале: группы { count, sinceTick, type, ticket }
    termQueue: [],
    // пулы ожидающих вылета пассажиров (спрос)
    paxPool: { heli: 0, vvl: 0, mvl: 0 },
    // очереди пассажиров в терминалах: { count, sinceTick, type('vvl'|'mvl'), dir('dep'|'arr'), ticket }
    termQueue: [],
    // новости о случайных событиях с самолётами (раздел «Новости»)
    newsLog: [],
    // когда разыгрывать следующее случайное событие с самолётами
    lastAircraftEventTick: 0,
    // предыдущий результат (на конец прошлой игры): { xp, level, buildingsBuilt, endedAt }
    previousResult: null,
    // --- Главы, задачи, цели (данные — CHAPTERS в gameData.js) ---
    chapter: 1,               // текущая глава
    quests: {},               // { [taskId]: { status, endsTick } }
    pendingChapterReward: null, // глава завершена, ждём показа награды
    goshaIntroSeen: false,    // показали ли знакомство с дядей Гошей
    ninaIntroSeen: false,     // показали ли знакомство с тётей Ниной (глава 2)
    ninaLetterSeen: false,    // показали ли письмо Нины про рейтинг (глава 1)
    chapterRatingSamples: 0,  // свежих оценок рейтинга набрано в текущей главе
    ratingChapter: 1,         // для какой главы сейчас копится рейтинг
    openPoints: [],           // открытые направления (id из POINTS)
    flownPoints: [],          // точки, по которым уже прилетал борт
    schedule: [],             // сетка рейсов: { id, contractId, dayIndex, slot 0-11 }
    scheduleRows: [],         // раскладка: какие АК в каких строках (contractId|null)
    ninaService: false,       // услуга «Нина на хозяйстве» включена
    ninaOfferPending: false,  // предложить услугу (после 3 ручных рейсов)
    ninaBaseMoney: null,      // бюджет на момент включения (потолок +70%)
    ninaHours: 0,             // отработано игровых часов (для зарплаты)
    unlockedBuildings: [],    // открытые наградой «скрытые» здания (напр. mchs)
    hasMedicalHeli: false,    // подарен ли медицинский вертолёт (городские службы)
    paused: false,            // пауза (временная механика): аэропорт заморожен
    // «Дни в плюсе»: серия игровых суток, закрытых с прибылью (задачи главы)
    profitStreak: 0,
    // Покос травы (дядя Гоша): счётчик, доступные «кредиты» на площадку и таймер
    mowCount: 0,
    mowCredits: 0,
    mowEndsTick: null,
  };
  data.airports.push(airport);
  save(data);
  return airport;
}

function getAirportByUserId(userId) {
  const data = load();
  return data.airports.find(a => a.userId === userId) || null;
}

function getAirportById(id) {
  const data = load();
  return data.airports.find(a => a.id === id) || null;
}

function updateAirport(id, patch) {
  const data = load();
  const airport = data.airports.find(a => a.id === id);
  if (!airport) return null;
  Object.assign(airport, patch);
  save(data);
  return airport;
}

function getAllAirports() {
  const data = load();
  return data.airports;
}

// ---------- buildings ----------
function addBuilding(airportId, cellIndex, buildingId, construction) {
  const data = load();
  const building = {
    id: data.nextBuildingId++,
    airportId,
    cellIndex,
    buildingId,
    builtAt: Date.now(),
    state: 'owned',     // 'owned' | 'rented' | 'listed' | 'sold'
    botName: null,       // имя компании-бота — при rented/sold
    rentPrice: null,      // согласованная цена аренды за тик — при rented
    listedPrice: null,     // цена, которую выставил игрок — при listed
    customIcon: null,       // переопределение иконки постройки (эмодзи/текст/URL картинки), задаёт админ — только этому игроку
    customName: null,        // переопределение названия постройки, задаёт админ — только этому игроку
    upgradeLevel: 1,          // текущий уровень апгрейда здания (1..def.maxUpgradeLevel)
    // --- строительство/апгрейд во времени ---
    constructionEndsTick: construction ? construction.endsTick : null, // тик завершения работ (null = готово)
    constructionType: construction ? construction.type : null,          // 'build' | 'upgrade'
    pendingUpgradeLevel: null,  // целевой уровень при апгрейде
    pendingXp: construction && construction.xp ? construction.xp : 0,     // XP к начислению по завершении стройки
  };
  data.buildings.push(building);
  save(data);
  return building;
}

function getBuildingsByAirport(airportId) {
  const data = load();
  return data.buildings.filter(b => b.airportId === airportId);
}

function findBuildingAtCell(airportId, cellIndex) {
  const data = load();
  return data.buildings.find(b => b.airportId === airportId && b.cellIndex === cellIndex) || null;
}

function updateBuildingAtCell(airportId, cellIndex, patch) {
  const data = load();
  const building = data.buildings.find(b => b.airportId === airportId && b.cellIndex === cellIndex);
  if (!building) return null;
  Object.assign(building, patch);
  save(data);
  return building;
}

function removeBuildingAtCell(airportId, cellIndex) {
  const data = load();
  const idx = data.buildings.findIndex(b => b.airportId === airportId && b.cellIndex === cellIndex);
  if (idx === -1) return false;
  data.buildings.splice(idx, 1);
  save(data);
  return true;
}

// Поменять местами две постройки (здания меняются cellIndex — внутренним
// идентификатором позиции). Любая позиция может быть пустой.
function swapCells(airportId, cellA, cellB) {
  const data = load();
  const a = data.buildings.find(b => b.airportId === airportId && b.cellIndex === cellA);
  const b = data.buildings.find(x => x.airportId === airportId && x.cellIndex === cellB);
  if (a) a.cellIndex = cellB;
  if (b) b.cellIndex = cellA;
  save(data);
  return true;
}

function removeAllBuildings(airportId) {
  const data = load();
  data.buildings = data.buildings.filter(b => b.airportId !== airportId);
  save(data);
}

// ---------- медиатека (Галерея в админке) ----------
function setBuildingLabelStyle(buildingId, style) {
  const data = load();
  data.buildingLabelStyles[buildingId] = style; // { fontSize, color }
  save(data);
  return data.buildingLabelStyles;
}

function getBuildingLabelStyles() {
  const data = load();
  return data.buildingLabelStyles;
}

function setBuildingName(buildingId, name) {
  const data = load();
  if (name) {
    data.buildingNames[buildingId] = name;
  } else {
    delete data.buildingNames[buildingId]; // пусто — вернуть дефолтное название из каталога
  }
  save(data);
  return data.buildingNames;
}

function getSettings() {
  const data = load();
  return data.settings || {};
}

function setSetting(key, value) {
  const data = load();
  if (!data.settings) data.settings = {};
  if (value === null || value === undefined) {
    delete data.settings[key];
  } else {
    data.settings[key] = value;
  }
  save(data);
  return data.settings;
}

function getBuildingNames() {
  const data = load();
  return data.buildingNames;
}

function setBuildingDescription(buildingId, description) {
  const data = load();
  if (description) {
    data.buildingDescriptions[buildingId] = description;
  } else {
    delete data.buildingDescriptions[buildingId]; // пусто — вернуть дефолтное описание из каталога
  }
  save(data);
  return data.buildingDescriptions;
}

function getBuildingDescriptions() {
  const data = load();
  return data.buildingDescriptions;
}

// ---------- самолёты ----------
function getTickCounter() {
  const data = load();
  return data.tickCounter || 0;
}

function incrementTickCounter() {
  const data = load();
  data.tickCounter = (data.tickCounter || 0) + 1;
  save(data);
  return data.tickCounter;
}

function addAircraft(airportId, typeId, ownership) {
  const data = load();
  const aircraft = {
    id: data.nextAircraftId++,
    airportId,
    typeId,
    ownership,        // 'owned' | 'lease'
    status: 'idle',    // 'idle' | 'flying' | 'waiting' | 'broken'
    wear: 0,            // износ 0..WEAR_MAX
    auto: false,         // авто-режим: сервер сам отправляет в рейс, когда свободен
    flightEndsTick: null, // на каком тике завершится текущий рейс
    repairEndsTick: null,  // до какого тика борт на ремонте в ангаре (событие), null = не ремонтируется
    upgradeLevel: 1,      // уровень апгрейда (влияет на вместимость)
    totalEarnings: 0,     // суммарный доход от самолёта (для списания при 2× цены)
    decommissioned: false, // списан (принёс 2× цены) — больше не летает, только продажа
    boughtAt: Date.now(),
  };
  data.aircraft.push(aircraft);
  save(data);
  return aircraft;
}

function getAircraftByAirport(airportId) {
  const data = load();
  return data.aircraft.filter(a => a.airportId === airportId);
}

function getAircraftById(aircraftId) {
  const data = load();
  return data.aircraft.find(a => a.id === aircraftId) || null;
}

function updateAircraft(aircraftId, patch) {
  const data = load();
  const ac = data.aircraft.find(a => a.id === aircraftId);
  if (!ac) return null;
  Object.assign(ac, patch);
  save(data);
  return ac;
}

function removeAircraft(aircraftId) {
  const data = load();
  const idx = data.aircraft.findIndex(a => a.id === aircraftId);
  if (idx === -1) return false;
  data.aircraft.splice(idx, 1);
  save(data);
  return true;
}

function removeAllAircraft(airportId) {
  const data = load();
  data.aircraft = data.aircraft.filter(a => a.airportId !== airportId);
  save(data);
}

// ---------- договоры с авиакомпаниями (конверт) ----------
function addContractOffer(airportId, offer) {
  const data = load();
  const rec = { id: data.nextContractId++, airportId, ...offer };
  data.contractOffers.push(rec);
  save(data);
  return rec;
}

function getContractOffers(airportId) {
  const data = load();
  return data.contractOffers.filter(o => o.airportId === airportId);
}

function getContractOfferById(offerId) {
  const data = load();
  return data.contractOffers.find(o => o.id === offerId) || null;
}

function updateContractOffer(offerId, patch) {
  const data = load();
  const o = data.contractOffers.find(x => x.id === offerId);
  if (!o) return null;
  Object.assign(o, patch);
  save(data);
  return o;
}

function removeContractOffer(offerId) {
  const data = load();
  data.contractOffers = data.contractOffers.filter(o => o.id !== offerId);
  save(data);
}

function addContract(airportId, contract) {
  const data = load();
  const rec = { id: data.nextContractId++, airportId, ...contract };
  data.contracts.push(rec);
  save(data);
  return rec;
}

function getContracts(airportId) {
  const data = load();
  return data.contracts.filter(c => c.airportId === airportId);
}

function getContractById(contractId) {
  const data = load();
  return data.contracts.find(c => c.id === contractId) || null;
}

function updateContract(contractId, patch) {
  const data = load();
  const c = data.contracts.find(x => x.id === contractId);
  if (!c) return null;
  Object.assign(c, patch);
  save(data);
  return c;
}

function removeContract(contractId) {
  const data = load();
  data.contracts = data.contracts.filter(c => c.id !== contractId);
  save(data);
}

// массовое обновление (используется в тике для чистки истёкших)
function setContractOffers(list) {
  const data = load();
  data.contractOffers = list;
  save(data);
}

function setContracts(list) {
  const data = load();
  data.contracts = list;
  save(data);
}

// Удалить все предложения и договоры аэропорта (сброс/рестарт).
function removeAllContracts(airportId) {
  const data = load();
  data.contractOffers = (data.contractOffers || []).filter(o => o.airportId !== airportId);
  data.contracts = (data.contracts || []).filter(c => c.airportId !== airportId);
  save(data);
}

// ---------- leaderboard ----------
function addLeaderboardEntry(username, startType, elapsedSeconds) {
  const data = load();
  data.leaderboard.push({
    id: data.nextLeaderboardId++,
    username,
    startType,
    elapsedSeconds,
    achievedAt: Date.now(),
  });
  save(data);
}

function getLeaderboard(limit = 50) {
  const data = load();
  return [...data.leaderboard]
    .sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)
    .slice(0, limit);
}

module.exports = {
  createUser, findUserByUsername, findUserByToken, findUserById, setUserPassword,
  setUserMustChangePassword, normalizeUsername, findCaseDuplicateUsernames,
  getAllUsers, setUserAdmin, setUserBan, isBanActive, deleteUser,
  createAirport, getAirportByUserId, getAirportById, updateAirport, getAllAirports,
  addBuilding, getBuildingsByAirport, findBuildingAtCell, updateBuildingAtCell, removeBuildingAtCell, removeAllBuildings, swapCells,
  addLeaderboardEntry, getLeaderboard,
  setBuildingLabelStyle, getBuildingLabelStyles,
  setBuildingName, getBuildingNames, setBuildingDescription, getBuildingDescriptions,
  getSettings, setSetting,
  addAircraft, getAircraftByAirport, getAircraftById, updateAircraft, removeAircraft, removeAllAircraft,
  getTickCounter, incrementTickCounter,
  addContractOffer, getContractOffers, getContractOfferById, updateContractOffer, removeContractOffer,
  flush,
  addContract, getContracts, getContractById, updateContract, removeContract, setContractOffers, setContracts, removeAllContracts,
};
