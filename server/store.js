// Лёгкое файловое хранилище на чистом Node.js fs — без нативных зависимостей.
//
// КЭШ С ПРОВЕРКОЙ ВНЕШНИХ ИЗМЕНЕНИЙ.
//
// Раньше каждая функция перечитывала data.json с диска — это защищало от
// потери изменений, если файл правит что-то извне (например, скрипт
// server/scripts/reset-password.js при работающем сервере). На одном игроке
// незаметно, но нагрузка росла квадратично: при 51 аэропорте один тик делал
// 7 800 чтений и перемалывал 3.6 ГБ, занимая 8 из 10 секунд между тиками.
// Ещё десяток игроков — и тики начали бы накладываться.
//
// Теперь данные живут в памяти, а безопасность внешних правок обеспечена
// иначе: перед выдачей кэша проверяется время изменения файла (stat вместо
// чтения и разбора — в тысячу раз дешевле), и при чужой записи кэш
// сбрасывается. Проверка не чаще раза в STAT_CHECK_MS, чтобы не сыпать
// системными вызовами.
//
// Запись отложенная: изменения копятся в памяти и сбрасываются на диск раз в
// FLUSH_MS, а также при остановке сервера. Цена — при аварийном падении
// теряется до полусекунды игры вместо последнего действия.
//
// При росте нагрузки — замена на Postgres/SQLite делается без изменения
// остального кода, только этого файла.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

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
  airports: [],      // { id, userId, startType, money, reputation, xp, level, gridSize, landExpansionsBought, startedAt, reachedLevel10At }
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
let cacheMtime = 0;          // время изменения файла, каким мы его знаем
let dirty = false;           // есть несохранённые изменения
let lastStatCheck = 0;
let flushTimer = null;

function readFromDisk() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // Мягкая миграция: если файл создан до появления какого-то поля — подставляем дефолт,
    // чтобы обновление кода не ломало уже работающий data.json на сервере.
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
    if (data.settings.oilPrice === undefined) data.settings.oilPrice = 70;   // база нефти
    if (data.settings.goldPrice === undefined) data.settings.goldPrice = 2000; // база золота
    if (data.settings.fuelMarketMult === undefined) data.settings.fuelMarketMult = 1.0; // текущий рыночный множитель
    if (data.settings.fuelMarketRepricedTick === undefined) data.settings.fuelMarketRepricedTick = 0;
    if (data.nextAircraftId === undefined) data.nextAircraftId = 1;
    if (!data.aircraft) data.aircraft = [];
    (data.aircraft || []).forEach(a => {
      if (a.auto === undefined) a.auto = false;
      if (a.upgradeLevel === undefined) a.upgradeLevel = 1;
      if (a.totalEarnings === undefined) a.totalEarnings = 0;
      if (a.decommissioned === undefined) a.decommissioned = false;
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
      if (!a.termQueue) a.termQueue = [];
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
    if (data.buildings) data.buildings = data.buildings.filter(b => b.buildingId !== 'runway_3');
    (data.users || []).forEach(u => {
      if (u.isAdmin === undefined) u.isAdmin = false;
      if (u.bannedUntil === undefined) u.bannedUntil = null;
    });
    return data;
  } catch (e) {
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
}

function load() {
  const now = Date.now();
  // Пока есть несохранённые изменения, наша копия свежее любой на диске.
  // Иначе сверяемся с файлом, но не чаще раза в четверть секунды.
  if (cache && (dirty || now - lastStatCheck < STAT_CHECK_MS)) return cache;
  lastStatCheck = now;

  let mtime = 0;
  try { mtime = fs.statSync(DATA_FILE).mtimeMs; } catch (e) { mtime = 0; }
  if (!cache || mtime !== cacheMtime) {
    cache = readFromDisk();
    cacheMtime = mtime;
  }
  return cache;
}

// Немедленно записать накопленное на диск.
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty || !cache) return;
  // Пишем во временный файл и переименовываем — атомарно, не побьём файл при падении сервера.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, DATA_FILE);
  dirty = false;
  try { cacheMtime = fs.statSync(DATA_FILE).mtimeMs; } catch (e) { /* не критично */ }
}

function save(data) {
  cache = data;
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

// Не теряем последние изменения при остановке сервера.
process.on('exit', flush);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { flush(); process.exit(0); });
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- users ----------
function createUser(username, passwordHash) {
  const data = load();
  const user = {
    id: data.nextUserId++,
    username,
    passwordHash,
    token: newToken(),
    createdAt: Date.now(),
    isAdmin: false,
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

function setUserPassword(username, passwordHash) {
  const data = load();
  const key = normalizeUsername(username);
  const user = data.users.find(u => normalizeUsername(u.username) === key);
  if (!user) return null;
  user.passwordHash = passwordHash;
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
function createAirport(userId, startType, money, gridSize) {
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
    gridSize,
    landExpansionsBought: 0,
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
    customIcon: null,       // переопределение иконки клетки (эмодзи/текст/URL картинки), задаёт админ — только этому игроку
    customName: null,        // переопределение названия клетки, задаёт админ — только этому игроку
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

// Поменять местами содержимое двух клеток (здания меняются cellIndex).
// Любая из клеток может быть пустой — тогда здание просто переезжает.
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
  normalizeUsername, findCaseDuplicateUsernames,
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
