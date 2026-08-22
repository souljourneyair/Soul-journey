const express = require('express');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');
const { ensureSuperuser } = require('./seed');
const {
  CONFIG, LAND_EXPANSION, BUILDINGS, BUILD_LIMITS, xpRequiredForLevel, levelFromXp,
  BOT_ECONOMY, randomBotName, generateRentOffers, rentAcceptChance,
  UPGRADE_ECONOMY, upgradeCost, upgradeMultiplier, buildDurationTicks, upgradeDurationTicks,
  AIRCRAFT_TYPES, AIRCRAFT_ECONOMY, aircraftSlotsOf, buyoutPrice, resalePrice, repairCost,
  aircraftCapacity, decommissionThreshold, aircraftUpgradeCost,
  standAcceptsSizes, aircraftSize,
  AIRLINE_BOT_NAMES, randomAirlineName, CONTRACT_ECONOMY, contractPayPerTick, contractDurationTicks,
  APRON_ECONOMY, contractPayPerArrival,
  FUEL_SUPPLIERS, FUEL_ECONOMY, fuelStorageCapacity, getFuelSupplier,
  PASSENGER_ECONOMY, terminalThroughput,
} = require('./gameData');
const mediaScan = require('./mediaScan');

// Картинки зданий и фоны экранов лежат в папках (см. docs/media-folders.md).
// init создаёт папку под каждое здание и делает первый скан.
mediaScan.init(Object.keys(BUILDINGS));

const app = express();
app.use(express.json({ limit: '30mb' })); // 30mb: видео-фон до 10MB в base64 (~13.5MB) + запас
// Понятная ошибка при превышении лимита тела (иначе фронт видит "Ошибка запроса")
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Файл слишком большой. Видео — до 10 МБ, картинка — до 5 МБ.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Некорректные данные запроса' });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// token -> Set(ws) — какие сокеты слушают обновления этого пользователя
const socketsByToken = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (!token) { ws.close(); return; }
  const user = store.findUserByToken(token);
  if (!user || store.isBanActive(user)) { ws.close(); return; }
  if (!socketsByToken.has(token)) socketsByToken.set(token, new Set());
  socketsByToken.get(token).add(ws);
  ws.on('close', () => socketsByToken.get(token)?.delete(ws));
});

function pushToUser(token, payload) {
  const sockets = socketsByToken.get(token);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function closeSocketsForToken(token) {
  const sockets = socketsByToken.get(token);
  if (!sockets) return;
  for (const ws of sockets) ws.close();
  socketsByToken.delete(token);
}

function banMessage(user) {
  if (user.bannedUntil === 'forever') return 'Аккаунт заблокирован навсегда.';
  const msLeft = user.bannedUntil - Date.now();
  const hoursLeft = Math.max(1, Math.ceil(msLeft / (3600 * 1000)));
  return `Аккаунт временно заблокирован. Осталось: ~${hoursLeft} ч.`;
}

// ---------- auth middleware ----------
function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'no_token' });
  const user = store.findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  if (store.isBanActive(user)) {
    return res.status(403).json({ error: 'banned', message: banMessage(user), bannedUntil: user.bannedUntil });
  }
  req.user = user;
  next();
}

function adminAuth(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'not_admin', message: 'Доступ только для администраторов' });
  next();
}

// ---------- auth routes ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'invalid_input', message: 'Логин от 3 символов, пароль от 4 символов' });
  }
  if (store.findUserByUsername(username)) {
    return res.status(409).json({ error: 'username_taken', message: 'Такой логин уже занят' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = store.createUser(username, hash);
  res.json({ token: user.token, userId: user.id, username: user.username, isAdmin: false });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'bad_credentials', message: 'Неверный логин или пароль' });
  }
  if (store.isBanActive(user)) {
    return res.status(403).json({ error: 'banned', message: banMessage(user), bannedUntil: user.bannedUntil });
  }
  res.json({ token: user.token, userId: user.id, username: user.username, isAdmin: !!user.isAdmin });
});

// ---------- game state helpers ----------
// Сколько всего мест под самолёты у аэропорта (сумма по стоянкам и ангарам,
// только по зданиям в собственности игрока — не sold/rented чужим).
// Здание ещё не введено в строй (идёт первичное строительство) — не участвует
// в механиках (места, ВПП, ангары). Апгрейд не считается — здание работает.
function isUnderConstruction(b) {
  return b.constructionEndsTick != null && b.constructionType === 'build';
}

// Стоимость содержания аэропорта в минуту — сумма по всем зданиям игрока
// (кроме проданных боту), растёт со стоимостью и уровнем апгрейда здания.
function upkeepPerTick(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  let upkeep = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def) continue;
    if ((b.state || 'owned') === 'sold') continue;
    const level = b.upgradeLevel || 1;
    // Обслуживающая инфраструктура (ВПП, стоянки, вертолётки, ангар) не приносит
    // пассивного дохода → содержание только базовое, без доли от стоимости.
    const perBuilding = def.infrastructure
      ? CONFIG.UPKEEP_BASE_PER_BUILDING
      : CONFIG.UPKEEP_BASE_PER_BUILDING + (def.cost || 0) * CONFIG.UPKEEP_COST_RATE;
    const upgradeMult = def.infrastructure ? 1 : (1 + (level - 1) * CONFIG.UPKEEP_UPGRADE_RATE);
    upkeep += perBuilding * upgradeMult;
  }
  return upkeep;
}

// Дно долга = суммарная базовая стоимость всех зданий игрока (по каталогу).
function debtFloor(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  let sum = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def) continue;
    if ((b.state || 'owned') === 'sold') continue;
    sum += def.cost || 0;
  }
  return sum;
}

// Активен ли аэропорт (для простоя): есть летящий/ожидающий самолёт ИЛИ
// борт по договору на стоянке / в очереди.
function isAirportActive(airportId) {
  const fleet = store.getAircraftByAirport(airportId);
  if (fleet.some(a => a.status === 'flying' || a.status === 'waiting')) return true;
  const airport = store.getAirportById(airportId);
  if (airport) {
    if ((airport.apronBorts || []).length > 0) return true;
    if ((airport.waitingBorts || []).length > 0) return true;
  }
  return false;
}

// Может ли аэропорт принимать борты по договорам (условие появления конверта):
// на старте достаточно вертолётной стоянки; иначе нужна связка вышка+ВПП+терминал.
function canAcceptContracts(airportId) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
  const has = (pred) => buildings.some(pred);
  const hasHelipad = has(b => b.buildingId === 'helipad');
  const hasTower = has(b => b.buildingId === 'tower');
  const hasRunway = has(b => { const d = BUILDINGS[b.buildingId]; return d && d.isRunway; });
  const hasTerminal = has(b => b.buildingId.includes('terminal'));
  // стартовый путь — вертолётка; полноценный — вышка + ВПП + терминал
  return hasHelipad || (hasTower && hasRunway && hasTerminal);
}

// Генерация одного предложения авиакомпании для аэропорта.
// Генерация одного предложения авиакомпании. Тип борта (вертолёт/самолёт)
// зависит от инфраструктуры аэропорта.
function makeContractOffer(airport, currentTick) {
  const base = {
    airline: randomAirlineName(),
    durationTicks: contractDurationTicks(),
    createdTick: currentTick,
    expiresTick: currentTick + CONTRACT_ECONOMY.OFFER_EXPIRE_MINUTES,
    thinking: false,
  };

  // Может ли аэропорт принимать самолёты (есть стоянка + ВПП + пассажирский терминал)?
  const stands = listStands(airport.id);
  const canPlanes = stands.length > 0 && totalRunways(airport.id) > 0 && hasPassengerTerminal(airport.id);

  // с некоторой вероятностью — самолётный договор (если есть куда принимать)
  if (canPlanes && Math.random() < APRON_ECONOMY.PLANE_CONTRACT_SHARE) {
    // выбираем размер среди тех, под кого есть стоянка
    const availSizes = [...new Set(stands.flatMap(s => s.accepts))];
    const size = availSizes[Math.floor(Math.random() * availSizes.length)];
    // МВЛ только если есть международный терминал и подходящая ВПП
    const mvlPossible = size !== 'small' && canFlyMvl(airport.id);
    const isMvl = mvlPossible && Math.random() < 0.4;
    const arrivalBase = contractPayPerArrival(airport.reputation, airport.level);
    const sizeMult = APRON_ECONOMY.PLANE_PAY_MULT[size] || 1;
    const mvlMult = isMvl ? APRON_ECONOMY.MVL_CONTRACT_MULT : 1;
    return {
      ...base,
      craft: 'plane',
      size,
      flightType: isMvl ? 'mvl' : 'vvl',
      payPerArrival: Math.round(arrivalBase * sizeMult * mvlMult * priceMarketMult()),
    };
  }

  // иначе — вертолётный договор
  return {
    ...base,
    craft: 'heli',
    size: null,
    flightType: 'vvl',
    payPerArrival: Math.round(contractPayPerArrival(airport.reputation, airport.level) * priceMarketMult()),
  };
}

// Есть ли пассажирский терминал (любой A-F).
function hasPassengerTerminal(airportId) {
  return store.getBuildingsByAirport(airportId).some(b => {
    const def = BUILDINGS[b.buildingId];
    return def && def.terminalClass && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b);
  });
}

// Суммарная пропускная способность терминалов по типу линий ('vvl' | 'mvl'), пасс/мин.
function terminalCapacity(airportId, lineType) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
  let cap = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def || !def.terminalClass || def.lineType !== lineType) continue;
    cap += terminalThroughput(b.buildingId, b.upgradeLevel || 1);
  }
  return cap;
}

// Число вертолётплощадок (для генерации heli-трафика).
function countHelipads(airportId) {
  return store.getBuildingsByAirport(airportId).filter(b =>
    b.buildingId === 'helipad' && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b)).length;
}

// Максимальный уровень апгрейда среди вертолётных площадок (для потолка пассажиров).
function maxHelipadLevel(airportId) {
  const pads = store.getBuildingsByAirport(airportId).filter(b =>
    b.buildingId === 'helipad' && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
  let max = 1;
  for (const b of pads) max = Math.max(max, b.upgradeLevel || 1);
  return max;
}

// «Очки» ВВЛ/МВЛ терминалов (сумма уровней) — база трафика.
function terminalPoints(airportId, lineType) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
  let pts = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def || !def.terminalClass || def.lineType !== lineType) continue;
    pts += (b.upgradeLevel || 1);
  }
  return pts;
}

// Генерация трафика пассажиров в пулы за тик (heli/vvl/mvl).
function generateTraffic(airport) {
  // Все три пула (heli/vvl/mvl) копятся от инфраструктуры + репутация/уровень.
  // heli — от вертолётплощадок, vvl/mvl — от терминалов.
  const heliPts = helipadPoints(airport.id);
  const vvlPts = terminalPoints(airport.id, 'vvl');
  const mvlPts = terminalPoints(airport.id, 'mvl');
  const rep = Math.max(0, airport.reputation || 0);
  const lvl = airport.level || 1;

  const activePools = (heliPts > 0 ? 1 : 0) + (vvlPts > 0 ? 1 : 0) + (mvlPts > 0 ? 1 : 0);
  const bonusEach = activePools > 0
    ? (rep * PASSENGER_ECONOMY.TRAFFIC_PER_REPUTATION + lvl * PASSENGER_ECONOMY.TRAFFIC_PER_LEVEL) / activePools
    : 0;

  const pool = airport.paxPool || { heli: 0, vvl: 0, mvl: 0 };
  const cap = PASSENGER_ECONOMY.POOL_CAP;
  if (heliPts > 0) {
    pool.heli = Math.min(cap, (pool.heli || 0) + heliPts * PASSENGER_ECONOMY.HELIPAD_TRAFFIC_BASE + bonusEach);
  } else {
    pool.heli = 0;
  }
  if (vvlPts > 0) {
    pool.vvl = Math.min(cap, (pool.vvl || 0) + vvlPts * PASSENGER_ECONOMY.VVL_TERMINAL_TRAFFIC_BASE + bonusEach);
  }
  if (mvlPts > 0) {
    pool.mvl = Math.min(cap, (pool.mvl || 0) + mvlPts * PASSENGER_ECONOMY.MVL_TERMINAL_TRAFFIC_BASE + bonusEach);
  }
  store.updateAirport(airport.id, { paxPool: pool });
  return pool;
}

// «Очки» вертолётплощадок (сумма уровней) — база heli-трафика.
function helipadPoints(airportId) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
  let pts = 0;
  for (const b of buildings) {
    if (b.buildingId === 'helipad') pts += (b.upgradeLevel || 1);
  }
  return pts;
}

// Сколько пассажиров может увезти договорной борт (вместимость по типу/размеру).
// Вертолёт — небольшая вместимость; самолёты — по размеру.
function contractCraftCapacity(craft, size) {
  if (craft === 'heli') return 8;               // вертолёт увозит до 8
  if (size === 'small') return 50;              // малый самолёт
  if (size === 'medium') return 155;            // средний
  if (size === 'large') return 310;             // большой
  return 8;
}

// Обработка очередей пассажиров в терминалах за тик.
// Каждый тип (vvl/mvl) обслуживается своей пропускной способностью (пасс/мин).
function processTerminalsTick(airport, currentTick, notifications) {
  let income = 0;
  let reputation = 0;
  let queue = (airport.termQueue || []).slice();
  if (queue.length === 0) return { income, reputation };

  let anyLost = false;
  let served = 0; // обслужено пассажиров за тик (для общего счётчика)

  for (const lineType of ['vvl', 'mvl']) {
    let capacity = terminalCapacity(airport.id, lineType);
    const groups = queue.filter(g => g.type === lineType).sort((a, b) => a.sinceTick - b.sinceTick);
    for (const g of groups) {
      if (g.count <= 0) continue;
      const waited = currentTick - g.sinceTick;

      // потерянные: ждали больше максимума — выбывают
      if (waited > PASSENGER_ECONOMY.WAIT_MAX_MINUTES) {
        anyLost = true;
        g.count = 0;
        continue;
      }
      if (capacity <= 0) continue;

      const serve = Math.min(g.count, capacity);
      capacity -= serve;
      g.count -= serve;
      served += serve;

      // штраф за недовольных (зона 30мин-2ч)
      if (waited >= PASSENGER_ECONOMY.WAIT_OK_MINUTES) {
        reputation -= serve * PASSENGER_ECONOMY.UNHAPPY_REP_PENALTY;
        income -= Math.round(serve * (g.ticket || 0) * PASSENGER_ECONOMY.UNHAPPY_TICKET_REFUND);
      }
    }
  }

  if (anyLost) {
    const cur = airport.reputation || 0;
    reputation -= cur * PASSENGER_ECONOMY.LOST_REP_PENALTY_PCT;
    notifications.push('😠 Пассажиры не дождались обслуживания и ушли! Репутация резко упала. Нужны терминалы мощнее.');
  }

  queue = queue.filter(g => g.count > 0);
  const patch = { termQueue: queue };
  if (served > 0) patch.paxServed = (airport.paxServed || 0) + served;
  store.updateAirport(airport.id, patch);
  return { income, reputation };
}

// Поставить группу пассажиров в очередь терминала.
function enqueuePax(airportId, count, lineType, ticket, currentTick) {
  if (count <= 0) return;
  const fresh = store.getAirportById(airportId);
  const queue = (fresh.termQueue || []).slice();
  queue.push({ count, sinceTick: currentTick, type: lineType, ticket });
  store.updateAirport(airportId, { termQueue: queue });
}

// Взять пассажиров из пула нужного типа (для загрузки рейса). Возвращает сколько взято.
function drawFromPool(airportId, lineType, want) {
  const fresh = store.getAirportById(airportId);
  const pool = fresh.paxPool || { heli: 0, vvl: 0, mvl: 0 };
  const key = lineType === 'mvl' ? 'mvl' : 'vvl';
  const avail = Math.floor(pool[key] || 0);
  const taken = Math.min(avail, want);
  pool[key] = (pool[key] || 0) - taken;
  store.updateAirport(airportId, { paxPool: pool });
  return taken;
}





// Суммарная вместимость топливных складов (сумма по построенным, с учётом апгрейда).
function totalFuelCapacity(airportId) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b) && b.buildingId === 'fuel_depot');
  let cap = 0;
  for (const b of buildings) cap += fuelStorageCapacity(b.upgradeLevel || 1);
  return cap;
}

// Есть ли построенный топливный склад.
function hasFuelDepot(airportId) {
  return store.getBuildingsByAirport(airportId).some(b =>
    b.buildingId === 'fuel_depot' && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
}

// Цена единицы топлива у выбранного поставщика (или средняя по умолчанию).
// Импортируем нужные функции рынка
const { fuelMarketMultiplier } = require('./gameData');

// Текущий рыночный множитель цены топлива (из глобальных settings).
function currentFuelMarketMult() {
  const s = store.getSettings();
  return s.fuelMarketMult != null ? s.fuelMarketMult : 1.0;
}

// Ценовой множитель для билетов и договоров: смягчённое влияние рынка топлива.
// При MARKET_INFLUENCE_ON_PRICES=0.5 отклонение вдвое меньше, чем у топлива.
function priceMarketMult() {
  const fuelMult = currentFuelMarketMult();
  return 1 + (fuelMult - 1) * APRON_ECONOMY.MARKET_INFLUENCE_ON_PRICES;
}

function fuelUnitPrice(airport) {
  // Если есть активный контракт — цена зафиксирована контрактом.
  if (airport.fuelContract && store.getTickCounter() < airport.fuelContract.endsTick) {
    return airport.fuelContract.pricePerUnit;
  }
  // Иначе — рыночная цена: база поставщика × рыночный множитель.
  const supplier = getFuelSupplier(airport.fuelSupplier) || FUEL_SUPPLIERS[2];
  return +(supplier.pricePerUnit * currentFuelMarketMult()).toFixed(3);
}

// Заправка чужого (договорного) борта со склада при прилёте.
// Возвращает { moneyPenalty, repPenalty } — штрафы, если топлива не хватило.
// Оплата за топливо зашита в «прилёт», поэтому при наличии топлива просто
// списываем его. При нехватке — экстренная докупка на стороне (наценка) +
// удар по репутации.
function refuelContractCraft(airport, craft, size) {
  // Пока у аэропорта нет топливного склада (открывается с 3 ур.), договорные борты
  // заправляются не у нас — никакого расхода топлива и штрафов.
  if (!hasFuelDepot(airport.id)) return { moneyPenalty: 0, repPenalty: 0 };

  const use = APRON_ECONOMY.CONTRACT_FUEL_USE[craft === 'heli' ? 'heli' : (size || 'small')] || 0;
  if (use <= 0) return { moneyPenalty: 0, repPenalty: 0 };

  const stored = airport.fuelStored || 0;
  const fromStore = Math.min(use, stored);
  const shortage = use - fromStore;

  if (fromStore > 0) {
    store.updateAirport(airport.id, { fuelStored: stored - fromStore });
  }
  if (shortage > 0) {
    const price = fuelUnitPrice(airport);
    const moneyPenalty = Math.round(shortage * price * APRON_ECONOMY.CONTRACT_FUEL_EMERGENCY_MULT);
    return { moneyPenalty, repPenalty: APRON_ECONOMY.CONTRACT_FUEL_NO_STOCK_REP };
  }
  return { moneyPenalty: 0, repPenalty: 0 };
}

// Сколько всего мест под приём бортов (сейчас — вертолётные стоянки, по апгрейду).
function totalApronSlots(airportId) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    (b.state || 'owned') !== 'sold' && b.state !== 'rented' && !isUnderConstruction(b));
  let slots = 0;
  for (const b of buildings) {
    if (b.buildingId === 'helipad') {
      slots += (b.upgradeLevel || 1) * APRON_ECONOMY.HELIPAD_SLOTS_PER_LEVEL;
    }
  }
  return slots;
}

// Минимальный интервал между операциями (мин) с учётом вышек.
// Без вышки — TOWER_INTERVAL_NONE. Несколько вышек работают параллельно
// (эффективный интервал = минимальный интервал / число вышек).
function towerInterval(airportId) {
  const buildings = store.getBuildingsByAirport(airportId).filter(b =>
    ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b) && b.buildingId === 'tower');
  if (buildings.length === 0) return APRON_ECONOMY.TOWER_INTERVAL_NONE;
  // берём лучший (минимальный) интервал среди вышек и делим на их число
  let best = APRON_ECONOMY.TOWER_INTERVAL_NONE;
  for (const b of buildings) {
    const lvl = b.upgradeLevel || 1;
    const iv = APRON_ECONOMY.TOWER_INTERVAL_BY_LEVEL[lvl - 1] || APRON_ECONOMY.TOWER_INTERVAL_BY_LEVEL[0];
    if (iv < best) best = iv;
  }
  return Math.max(1, Math.round(best / buildings.length));
}

// Есть ли построенная диспетчерская вышка (обязательна для полётов своих самолётов).
function hasTower(airportId) {
  return store.getBuildingsByAirport(airportId).some(b =>
    b.buildingId === 'tower' && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b));
}

// Есть ли международный терминал (C/E/F, lineType 'mvl') — нужен для МВЛ-рейсов.
function hasInternationalTerminal(airportId) {
  return store.getBuildingsByAirport(airportId).some(b => {
    const def = BUILDINGS[b.buildingId];
    return def && def.terminalClass && def.lineType === 'mvl'
      && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b);
  });
}

// Есть ли ВПП, поддерживающая МВЛ (средняя/большая — lineType 'both').
function hasMvlRunway(airportId) {
  return store.getBuildingsByAirport(airportId).some(b => {
    const def = BUILDINGS[b.buildingId];
    return def && def.isRunway && def.lineType === 'both'
      && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b);
  });
}

// Может ли аэропорт выполнять МВЛ-рейсы (международный терминал + подходящая ВПП).
function canFlyMvl(airportId) {
  return hasInternationalTerminal(airportId) && hasMvlRunway(airportId);
}

function totalAircraftSlots(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  let slots = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def || !def.aircraftSlots) continue;
    if ((b.state || 'owned') === 'sold') continue; // продано боту — не считаем
    if (isUnderConstruction(b)) continue; // ещё строится
    slots += aircraftSlotsOf(def, b.upgradeLevel || 1);
  }
  return slots;
}

// Список стоянок аэропорта с их вместимостью по размерам (для привязки самолётов).
// Возвращает массив { id, standSize, level, accepts: [...размеры] } по одному на место.
function listStands(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  const stands = [];
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def || !def.standSize) continue;
    if ((b.state || 'owned') === 'sold') continue;
    if (b.state === 'rented') continue; // сданная в аренду стоянка не работает на операции
    if (isUnderConstruction(b)) continue;
    stands.push({
      buildingId: b.buildingId,
      standSize: def.standSize,
      level: b.upgradeLevel || 1,
      accepts: standAcceptsSizes(def.standSize, b.upgradeLevel || 1),
    });
  }
  return stands;
}

// Мягкий вариант: стоянку занимает только борт НА ЗЕМЛЕ. Летящие самолёты
// стоянку временно освобождают. Проверяем, поместится ли новый самолёт с учётом
// тех, кто сейчас реально стоит (свои idle/broken/waiting + договорные самолёты).
function canPlaceAircraft(airportId, newSize, excludeAircraftId = null) {
  const stands = listStands(airportId);
  // свои самолёты, физически стоящие на земле (не в полёте)
  const groundedOwn = store.getAircraftByAirport(airportId)
    .filter(a => a.id !== excludeAircraftId && a.status !== 'flying')
    .map(a => aircraftSize(a.typeId));
  // договорные самолёты, стоящие на стоянках прямо сейчас
  const airport = store.getAirportById(airportId);
  const contractPlanes = airport && airport.apronBorts
    ? airport.apronBorts.filter(b => b.craft === 'plane').map(b => b.size)
    : [];
  const toPlace = [...groundedOwn, ...contractPlanes, newSize];
  return assignAll(stands, toPlace);
}

// Жадное сопоставление: можно ли разместить все самолёты toPlace на стоянках stands.
// Размещаем крупные первыми (им меньше подходящих стоянок), каждому — наименее
// избыточную свободную стоянку.
function assignAll(stands, toPlace) {
  const sizeRank = { large: 3, medium: 2, small: 1 };
  const planes = [...toPlace].sort((a, b) => sizeRank[b] - sizeRank[a]); // крупные первыми
  const used = new Array(stands.length).fill(false);
  for (const size of planes) {
    // ищем свободную стоянку, которая вмещает size, с минимальной «избыточностью»
    let best = -1, bestRank = 99;
    for (let i = 0; i < stands.length; i++) {
      if (used[i]) continue;
      if (!stands[i].accepts.includes(size)) continue;
      const rank = sizeRank[stands[i].standSize];
      if (rank < bestRank) { bestRank = rank; best = i; }
    }
    if (best === -1) return false; // не нашлось места
    used[best] = true;
  }
  return true;
}

// Сколько ВПП есть у игрока (для одновременных операций взлёта/посадки).
function totalRunways(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  let n = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (def && def.isRunway && ((b.state || 'owned') !== 'sold' && b.state !== 'rented') && !isUnderConstruction(b)) n++;
  }
  return n;
}

// Сколько ВПП сейчас заняты операциями (самолёты, которые взлетают/садятся
// в этот тик, укладываются в число ВПП). Для простоты: занятость ВПП
// проверяется в момент запуска рейса и в момент посадки (в тике).
function serializeAircraft(airportId) {
  const list = store.getAircraftByAirport(airportId);
  const nowTick = store.getTickCounter();
  return list.map(a => {
    const t = AIRCRAFT_TYPES[a.typeId];
    const threshold = decommissionThreshold(t);
    return {
      id: a.id,
      typeId: a.typeId,
      typeName: t.name,
      lineType: t.lineType,          // 'vvl' | 'both'
      ownership: a.ownership,       // 'owned' | 'lease'
      status: a.status,             // 'idle' | 'flying' | 'waiting' | 'broken'
      flightType: a.flightType || null, // 'vvl' | 'mvl' — тип текущего рейса
      auto: !!a.auto,
      wear: Math.round((a.wear || 0) * 100), // в процентах для UI
      upgradeLevel: a.upgradeLevel || 1,
      maxUpgradeLevel: t.maxUpgradeLevel || 3,
      capacity: aircraftCapacity(t, a.upgradeLevel || 1),
      nextUpgradeCost: (a.upgradeLevel || 1) < (t.maxUpgradeLevel || 3)
        ? aircraftUpgradeCost(t, (a.upgradeLevel || 1) + 1) : null,
      nextCapacity: (a.upgradeLevel || 1) < (t.maxUpgradeLevel || 3)
        ? aircraftCapacity(t, (a.upgradeLevel || 1) + 1) : null,
      ticksLeft: a.status === 'flying' && a.flightEndsTick ? Math.max(0, a.flightEndsTick - nowTick) : 0,
      buyoutPrice: a.ownership === 'lease' ? buyoutPrice(t, a.wear || 0) : null,
      resalePrice: a.ownership === 'owned' ? resalePrice(t, a.wear || 0) : null,
      leasePerTick: a.ownership === 'lease' ? t.leasePerTick : null,
      repairCost: (a.wear || 0) > 0 ? repairCost(a.wear || 0, t.buyCost) : 0,
      // ресурс списания: доход накоплен / порог (2× цены), и флаг «списан»
      totalEarnings: Math.round(a.totalEarnings || 0),
      decommissionThreshold: threshold,
      decommissionProgress: Math.min(1, (a.totalEarnings || 0) / threshold),
      decommissioned: !!a.decommissioned,
    };
  });
}

function serializeAirport(airport) {
  const buildings = store.getBuildingsByAirport(airport.id);
  const nextExpansion = LAND_EXPANSION[airport.landExpansionsBought] || null;
  const usedSlots = store.getAircraftByAirport(airport.id).length;
  return {
    startType: airport.startType,
    name: airport.name || null,
    airline: airport.airline || null,
    airlineOfferSeen: !!airport.airlineOfferSeen,
    // предложение создать АК доступно на 5+ уровне, пока АК не создана.
    // (флаг airlineOfferSeen больше не гасит его — окно всё равно можно закрыть,
    //  а в шапке всегда есть кнопка «Создать АК»)
    airlineOfferAvailable: airport.level >= CONFIG.AIRLINE_MIN_LEVEL && !airport.airline,
    canUseAircraft: !!airport.airline && hasBuiltOffice(airport.id), // самолёты — после АК и офиса
    hasOffice: hasBuiltOffice(airport.id),
    officeAvailable: !!airport.airline, // офис можно строить, когда создана АК
    upkeepPerTick: upkeepPerTick(airport.id),  // текущее содержание в минуту
    expensesPerTick: totalExpensesPerTick(airport.id), // общие расходы/мин (содержание + лизинг)
    debtFloor: debtFloor(airport.id),           // предел долга (дно)
    bankrupt: !!airport.bankrupt,               // игра окончена банкротством
    envelopeOffers: store.getContractOffers(airport.id).length,   // предложений в конверте
    activeContracts: store.getContracts(airport.id).length,        // активных договоров
    canAcceptContracts: canAcceptContracts(airport.id),
    apronSlots: (() => {
      const borts = airport.apronBorts || [];
      const heliUsed = borts.filter(b => (b.craft || 'heli') === 'heli').length;
      const planeContract = borts.filter(b => b.craft === 'plane').length;
      const ownPlanes = store.getAircraftByAirport(airport.id).length;
      const stands = listStands(airport.id).length;
      return {
        heli: { used: heliUsed, total: totalApronSlots(airport.id) },       // вертолётные места
        plane: { used: planeContract + ownPlanes, total: stands },          // стоянки (свои + договорные)
        // для обратной совместимости старое поле — вертолётные места
        used: heliUsed, total: totalApronSlots(airport.id),
      };
    })(),
    apronWaiting: (airport.waitingBorts || []).length,  // бортов в очереди на посадку
    towerInterval: towerInterval(airport.id),           // текущий интервал вышки (мин)
    hasTower: hasTower(airport.id),                      // есть вышка (нужна для полётов)
    canFlyMvl: canFlyMvl(airport.id),                    // можно ли выполнять МВЛ-рейсы
    fuel: { stored: airport.fuelStored || 0, capacity: totalFuelCapacity(airport.id), hasDepot: hasFuelDepot(airport.id) },
    paxPool: {
      heli: Math.floor((airport.paxPool || {}).heli || 0),
      vvl: Math.floor((airport.paxPool || {}).vvl || 0),
      mvl: Math.floor((airport.paxPool || {}).mvl || 0),
    },
    heliFlow: airport.heliFlow || { arrived: 0, departed: 0 },
    heliCarried: airport.heliCarried || 0,
    paxServed: airport.paxServed || 0,
    terminalCapacity: { vvl: terminalCapacity(airport.id, 'vvl'), mvl: terminalCapacity(airport.id, 'mvl') },
    termQueue: (airport.termQueue || []).reduce((sum, g) => sum + g.count, 0),
    money: airport.money,
    reputation: airport.reputation,
    xp: airport.xp,
    level: airport.level,
    xpForNextLevel: xpRequiredForLevel(Math.min(airport.level + 1, CONFIG.TARGET_LEVEL)),
    gridSize: airport.gridSize,
    maxGridSize: CONFIG.MAX_GRID_SIZE,
    landExpansionsBought: airport.landExpansionsBought,
    nextExpansion,
    startedAt: airport.startedAt,
    reachedLevel10At: airport.reachedLevel10At,
    buildings: buildings.map(b => {
      const def = BUILDINGS[b.buildingId];
      const level = b.upgradeLevel || 1;
      const maxLevel = def ? def.maxUpgradeLevel : 1;
      const nowTick = store.getTickCounter();
      const constructing = b.constructionEndsTick != null;
      // общая длительность текущих работ — чтобы фронт рисовал кольцо прогресса
      let constructionTotal = 0;
      if (constructing) {
        constructionTotal = b.constructionType === 'upgrade'
          ? upgradeDurationTicks(def, b.pendingUpgradeLevel || (b.upgradeLevel || 1) + 1)
          : buildDurationTicks(def);
      }
      return {
        cellIndex: b.cellIndex, buildingId: b.buildingId, builtAt: b.builtAt,
        state: b.state || 'owned', botName: b.botName || null,
        rentPrice: b.rentPrice || null, listedPrice: b.listedPrice || null,
        customIcon: b.customIcon || null, customName: b.customName || null,
        upgradeLevel: level, maxUpgradeLevel: maxLevel,
        nextUpgradeCost: (def && level < maxLevel) ? upgradeCost(def, level + 1) : null,
        // состояние работ: тип ('build'|'upgrade'), сколько тиков осталось / всего, целевой уровень
        constructionType: constructing ? b.constructionType : null,
        constructionTicksLeft: constructing ? Math.max(0, b.constructionEndsTick - nowTick) : 0,
        constructionTotal,
        pendingUpgradeLevel: b.pendingUpgradeLevel || null,
      };
    }),
    catalog: BUILDINGS,
    buildLimits: BUILD_LIMITS,
    botEconomy: BOT_ECONOMY,
    upgradeEconomy: UPGRADE_ECONOMY,
    // картинки зданий из папок uploads/buildings/<id>/ — источник правды
    buildingMedia: mediaScan.buildingsManifest(),
    buildingSkins: store.getBuildingSkins(), // устарело, снести после миграции
    buildingLabelStyles: store.getBuildingLabelStyles(),
    buildingNames: store.getBuildingNames(),
    buildingDescriptions: store.getBuildingDescriptions(),
    // --- авиапарк ---
    aircraft: serializeAircraft(airport.id),
    aircraftTypes: AIRCRAFT_TYPES,
    aircraftEconomy: AIRCRAFT_ECONOMY,
    aircraftSlots: { used: usedSlots, total: totalAircraftSlots(airport.id) },
    standSpace: {
      small: canPlaceAircraft(airport.id, 'small'),
      medium: canPlaceAircraft(airport.id, 'medium'),
      large: canPlaceAircraft(airport.id, 'large'),
    },
    runways: totalRunways(airport.id),
  };
}

// ---------- game routes ----------
app.get('/api/me', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  res.json({ username: req.user.username, hasAirport: !!airport, isAdmin: !!req.user.isAdmin });
});

app.post('/api/start-game', auth, (req, res) => {
  if (store.getAirportByUserId(req.user.id)) return res.status(409).json({ error: 'already_started' });

  // Путь B ("с воздуха") — Итерация 2, пока форсим путь A.
  // Новый игрок стартует на уровне 0 БЕЗ построек — админздание и вертолётную
  // стоянку он ставит сам за стартовый капитал, получая за них опыт до 1 уровня.
  const airport = store.createAirport(req.user.id, 'A', CONFIG.START_MONEY, CONFIG.START_GRID_SIZE);

  res.json(serializeAirport(airport));
});

// Начать сначала после банкротства: полный сброс аэропорта (уровень 0, стартовые
// деньги, без зданий/самолётов, сброс названия и АК — совсем заново).
app.post('/api/airport/restart', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  store.removeAllBuildings(airport.id);
  store.removeAllAircraft(airport.id);
  store.removeAllContracts(airport.id);
  const updated = store.updateAirport(airport.id, {
    name: null, airline: null, airlineOfferSeen: false,
    money: CONFIG.START_MONEY, reputation: 0, xp: 0, level: 0,
    gridSize: CONFIG.START_GRID_SIZE, landExpansionsBought: 0,
    reachedLevel10At: null, startedAt: Date.now(),
    idleSinceTick: null, bankrupt: false,
    apronBorts: [], waitingBorts: [],
    fuelStored: 0, fuelSupplier: null, fuelContract: null, fuelAutoContract: false, fuelRefillThreshold: 25,
    paxPool: { heli: 0, vvl: 0, mvl: 0 }, termQueue: [],
    heliCarried: 0, paxServed: 0, heliFlow: { arrived: 0, departed: 0 },
  });
  res.json(serializeAirport(updated));
});

// Удалить свой аккаунт полностью (без подтверждения на сервере — подтверждение на клиенте).
app.post('/api/account/delete', auth, (req, res) => {
  store.deleteUser(req.user.id);
  res.json({ deleted: true });
});

app.get('/api/state', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  res.json(serializeAirport(airport));
});

// Установка названия аэропорта (при первом входе).
app.post('/api/airport/name', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const name = String((req.body && req.body.name) || '').trim();
  if (name.length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'bad_name', message: 'Название от 2 до 40 символов' });
  }
  const updated = store.updateAirport(airport.id, { name });
  res.json(serializeAirport(updated));
});

// Создание собственной авиакомпании (с 5 уровня). Открывает доступ к самолётам.
app.post('/api/airport/create-airline', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  if (airport.airline) return res.status(400).json({ error: 'already_created', message: 'Авиакомпания уже создана' });
  if (airport.level < CONFIG.AIRLINE_MIN_LEVEL) {
    return res.status(400).json({ error: 'level_too_low', message: `Авиакомпанию можно создать с ${CONFIG.AIRLINE_MIN_LEVEL} уровня` });
  }
  const airline = String((req.body && req.body.name) || '').trim();
  if (airline.length < 2 || airline.length > 40) {
    return res.status(400).json({ error: 'bad_name', message: 'Название от 2 до 40 символов' });
  }
  const updated = store.updateAirport(airport.id, { airline, airlineOfferSeen: true });
  res.json(serializeAirport(updated));
});

// Отклонение предложения создать АК (пятиуровневое письмо). Появится кнопка «Создать АК».
app.post('/api/airport/dismiss-airline-offer', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const updated = store.updateAirport(airport.id, { airlineOfferSeen: true });
  res.json(serializeAirport(updated));
});

// ==================== КОНВЕРТ (договоры с авиакомпаниями) ====================
function serializeEnvelope(airportId) {
  const nowTick = store.getTickCounter();
  const offers = store.getContractOffers(airportId).map(o => ({
    id: o.id, airline: o.airline,
    payPerArrival: o.payPerArrival || o.payPerTick,
    craft: o.craft || 'heli', size: o.size || null,
    flightType: o.flightType || 'vvl',
    durationDays: Math.round(o.durationTicks / 1440),
    minutesLeft: Math.max(0, o.expiresTick - nowTick),
    thinking: !!o.thinking,
    botCounter: o.botCounter != null ? o.botCounter : null, // встречное предложение бота (после торга)
    playerOffer: o.playerOffer != null ? o.playerOffer : null,
  }));
  const contracts = store.getContracts(airportId).map(c => ({
    id: c.id, airline: c.airline,
    payPerArrival: c.payPerArrival || c.payPerTick,
    craft: c.craft || 'heli', size: c.size || null,
    flightType: c.flightType || 'vvl',
    minutesLeft: Math.max(0, c.endsTick - nowTick),
    daysLeft: Math.max(0, Math.round((c.endsTick - nowTick) / 1440)),
  }));
  return { offers, contracts, canAccept: canAcceptContracts(airportId) };
}

app.get('/api/envelope', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  res.json(serializeEnvelope(airport.id));
});

// Принять предложение → заключить договор
app.post('/api/envelope/accept', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { offerId } = req.body || {};
  const offer = store.getContractOfferById(offerId);
  if (!offer || offer.airportId !== airport.id) return res.status(404).json({ error: 'no_offer' });

  const nowTick = store.getTickCounter();
  const arrivalInterval = APRON_ECONOMY.CONTRACT_ARRIVAL_INTERVAL;
  store.addContract(airport.id, {
    airline: offer.airline,
    payPerTick: offer.payPerTick,
    payPerArrival: offer.payPerArrival || contractPayPerArrival(airport.reputation, airport.level),
    craft: offer.craft || 'heli',       // 'heli' | 'plane'
    size: offer.size || null,           // размер самолёта (для plane)
    flightType: offer.flightType || 'vvl',

    endsTick: nowTick + offer.durationTicks,
    signedTick: nowTick,
    nextArrivalTick: nowTick + Math.round(arrivalInterval * (0.5 + Math.random())),
  });
  store.removeContractOffer(offer.id);
  res.json(serializeEnvelope(airport.id));
});

// Отклонить предложение → исчезает
app.post('/api/envelope/decline', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { offerId } = req.body || {};
  const offer = store.getContractOfferById(offerId);
  if (!offer || offer.airportId !== airport.id) return res.status(404).json({ error: 'no_offer' });
  store.removeContractOffer(offer.id);
  res.json(serializeEnvelope(airport.id));
});

// Торговаться: игрок предлагает свою цену за прилёт.
app.post('/api/envelope/haggle', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { offerId, price } = req.body || {};
  const offer = store.getContractOfferById(offerId);
  if (!offer || offer.airportId !== airport.id) return res.status(404).json({ error: 'no_offer' });

  const playerOffer = Math.round(Number(price));
  if (!isFinite(playerOffer) || playerOffer <= 0) {
    return res.status(400).json({ error: 'bad_price', message: 'Некорректная цена' });
  }
  // уже торговались один раз — второй раз нельзя (бот назвал финальную)
  if (offer.botCounter != null) {
    return res.status(400).json({ error: 'already_haggled', message: 'Поставщик уже назвал финальную цену — примите её или откажитесь' });
  }

  const original = offer.payPerArrival;
  // игрок просит не больше исходного — бот с радостью соглашается на цену игрока
  if (playerOffer <= original) {
    store.updateContractOffer(offer.id, { payPerArrival: playerOffer, haggleResult: 'accepted' });
    return res.json({ result: 'accepted', price: playerOffer, ...serializeEnvelope(airport.id) });
  }
  // игрок наглеет — просит слишком много: бот уходит
  const maxAsk = original * (1 + APRON_ECONOMY.HAGGLE_MAX_OVERASK);
  if (playerOffer > maxAsk) {
    store.removeContractOffer(offer.id);
    return res.json({ result: 'walked', ...serializeEnvelope(airport.id) });
  }
  // бот делает встречное предложение между исходной и запросом игрока
  const counter = Math.round(original + (playerOffer - original) * APRON_ECONOMY.HAGGLE_GREED);
  store.updateContractOffer(offer.id, { botCounter: counter, playerOffer });
  res.json({ result: 'counter', counter, ...serializeEnvelope(airport.id) });
});

// Принять встречное предложение бота (после торга).
app.post('/api/envelope/haggle/accept', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { offerId } = req.body || {};
  const offer = store.getContractOfferById(offerId);
  if (!offer || offer.airportId !== airport.id) return res.status(404).json({ error: 'no_offer' });
  if (offer.botCounter == null) return res.status(400).json({ error: 'no_counter', message: 'Нет встречного предложения' });
  // фиксируем цену встречного предложения и заключаем договор
  store.updateContractOffer(offer.id, { payPerArrival: offer.botCounter });
  const nowTick = store.getTickCounter();
  const arrivalInterval = APRON_ECONOMY.CONTRACT_ARRIVAL_INTERVAL;
  store.addContract(airport.id, {
    airline: offer.airline,
    payPerTick: offer.payPerTick,
    payPerArrival: offer.botCounter,
    craft: offer.craft || 'heli',
    size: offer.size || null,
    flightType: offer.flightType || 'vvl',
    endsTick: nowTick + offer.durationTicks,
    signedTick: nowTick,
    nextArrivalTick: nowTick + Math.round(arrivalInterval * (0.5 + Math.random())),
  });
  store.removeContractOffer(offer.id);
  res.json({ result: 'signed', ...serializeEnvelope(airport.id) });
});

// Подумать → продлевает жизнь предложения (но потом всё равно истечёт)
app.post('/api/envelope/think', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { offerId } = req.body || {};
  const offer = store.getContractOfferById(offerId);
  if (!offer || offer.airportId !== airport.id) return res.status(404).json({ error: 'no_offer' });
  const nowTick = store.getTickCounter();
  store.updateContractOffer(offer.id, {
    thinking: true,
    expiresTick: nowTick + CONTRACT_ECONOMY.THINKING_EXPIRE_MINUTES,
  });
  res.json(serializeEnvelope(airport.id));
});

// Расторгнуть действующий договор
app.post('/api/envelope/terminate', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { contractId } = req.body || {};
  const contract = store.getContractById(contractId);
  if (!contract || contract.airportId !== airport.id) return res.status(404).json({ error: 'no_contract' });
  store.removeContract(contract.id);
  res.json(serializeEnvelope(airport.id));
});

// ==================== ТОПЛИВНЫЙ СКЛАД И БИРЖА ПОСТАВЩИКОВ ====================
function serializeFuel(airport) {
  const capacity = totalFuelCapacity(airport.id);
  const marketMult = currentFuelMarketMult();
  const nowTick = store.getTickCounter();
  const contract = airport.fuelContract && nowTick < airport.fuelContract.endsTick
    ? {
        supplierId: airport.fuelContract.supplierId,
        pricePerUnit: airport.fuelContract.pricePerUnit,
        minutesLeft: Math.max(0, airport.fuelContract.endsTick - nowTick),
        daysLeft: Math.max(0, Math.round((airport.fuelContract.endsTick - nowTick) / 1440)),
      }
    : null;
  // поставщики с их текущей рыночной ценой (база × рыночный множитель)
  const suppliers = FUEL_SUPPLIERS.map(s => ({
    ...s,
    marketPrice: +(s.pricePerUnit * marketMult).toFixed(3),
  }));
  return {
    hasDepot: hasFuelDepot(airport.id),
    stored: airport.fuelStored || 0,
    capacity,
    supplier: airport.fuelSupplier || null,
    suppliers,
    unitPrice: fuelUnitPrice(airport),
    marketMult: +marketMult.toFixed(3),
    contract,
    autoContract: !!airport.fuelAutoContract,
    refillThreshold: airport.fuelRefillThreshold != null ? airport.fuelRefillThreshold : 25,
    canContract: airport.level >= FUEL_ECONOMY.CONTRACT_MIN_LEVEL,
    canAuto: airport.level >= FUEL_ECONOMY.CONTRACT_AUTO_MIN_LEVEL,
    contractDurationDays: FUEL_ECONOMY.CONTRACT_DURATION_DAYS,
  };
}

app.get('/api/fuel', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  res.json(serializeFuel(airport));
});

// Выбрать поставщика топлива (биржа).
app.post('/api/fuel/supplier', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { supplierId } = req.body || {};
  if (!getFuelSupplier(supplierId)) return res.status(400).json({ error: 'bad_supplier', message: 'Неизвестный поставщик' });
  store.updateAirport(airport.id, { fuelSupplier: supplierId });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeFuel(fresh));
});

// Пополнить склад топливом у выбранного поставщика.
app.post('/api/fuel/refill', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  if (!hasFuelDepot(airport.id)) return res.status(400).json({ error: 'no_depot', message: 'Сначала постройте топливный склад' });
  const capacity = totalFuelCapacity(airport.id);
  const stored = airport.fuelStored || 0;
  let { amount } = req.body || {};
  // если не указано — заполняем склад доверху
  const space = capacity - stored;
  if (space <= 0) return res.status(400).json({ error: 'full', message: 'Склад уже полон' });
  amount = (typeof amount === 'number' && amount > 0) ? Math.min(amount, space) : space;
  const price = fuelUnitPrice(airport);
  const cost = Math.round(amount * price);
  if (airport.money < cost) {
    // купим сколько хватает денег
    const affordable = Math.floor(airport.money / price);
    if (affordable <= 0) return res.status(400).json({ error: 'not_enough_money', message: 'Недостаточно денег на топливо' });
    amount = affordable;
  }
  const finalCost = Math.round(amount * price);
  store.updateAirport(airport.id, {
    fuelStored: stored + amount,
    money: airport.money - finalCost,
  });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeFuel(fresh));
});

// Заключить контракт с поставщиком (фиксация цены на срок).
app.post('/api/fuel/contract', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  if (airport.level < FUEL_ECONOMY.CONTRACT_MIN_LEVEL) {
    return res.status(400).json({ error: 'low_level', message: `Контракт доступен с уровня ${FUEL_ECONOMY.CONTRACT_MIN_LEVEL}` });
  }
  const { supplierId } = req.body || {};
  const supplier = getFuelSupplier(supplierId);
  if (!supplier) return res.status(400).json({ error: 'bad_supplier', message: 'Неизвестный поставщик' });
  // фиксируем текущую рыночную цену этого поставщика
  const price = +(supplier.pricePerUnit * currentFuelMarketMult()).toFixed(3);
  const nowTick = store.getTickCounter();
  store.updateAirport(airport.id, {
    fuelSupplier: supplierId,
    fuelContract: { supplierId, pricePerUnit: price, endsTick: nowTick + FUEL_ECONOMY.CONTRACT_DURATION_DAYS * 1440 },
  });
  res.json(serializeFuel(store.getAirportByUserId(req.user.id)));
});

// Расторгнуть контракт с поставщиком.
app.post('/api/fuel/contract/cancel', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  store.updateAirport(airport.id, { fuelContract: null });
  res.json(serializeFuel(store.getAirportByUserId(req.user.id)));
});

// Установить порог автодозаправки по контракту (% вместимости).
app.post('/api/fuel/threshold', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  let { threshold } = req.body || {};
  threshold = Number(threshold);
  if (!isFinite(threshold) || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'invalid_threshold', message: 'Порог должен быть от 0 до 100%' });
  }
  store.updateAirport(airport.id, { fuelRefillThreshold: Math.round(threshold) });
  res.json(serializeFuel(store.getAirportByUserId(req.user.id)));
});

// Включить/выключить автопродление контракта (ур.6+).
app.post('/api/fuel/contract/auto', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  if (airport.level < FUEL_ECONOMY.CONTRACT_AUTO_MIN_LEVEL) {
    return res.status(400).json({ error: 'low_level', message: `Авто доступно с уровня ${FUEL_ECONOMY.CONTRACT_AUTO_MIN_LEVEL}` });
  }
  const { enabled } = req.body || {};
  store.updateAirport(airport.id, { fuelAutoContract: !!enabled });
  res.json(serializeFuel(store.getAirportByUserId(req.user.id)));
});

app.post('/api/build', auth, (req, res) => {
  const { cellIndex, buildingId } = req.body || {};
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });

  const def = BUILDINGS[buildingId];
  if (!def) return res.status(400).json({ error: 'unknown_building' });
  // Уникальные здания (админздание) — не более одного на аэропорт.
  if (def.unique) {
    const already = store.getBuildingsByAirport(airport.id).some(b => b.buildingId === buildingId);
    if (already) return res.status(400).json({ error: 'already_built', message: 'Это здание уже построено' });
  }
  // Лимит количества зданий данного типа (не считая проданные боту).
  const limit = BUILD_LIMITS[buildingId];
  if (limit != null) {
    const count = store.getBuildingsByAirport(airport.id)
      .filter(b => b.buildingId === buildingId && (b.state || 'owned') !== 'sold').length;
    if (count >= limit) {
      return res.status(400).json({ error: 'limit_reached', message: `Достигнут лимит: максимум ${limit} шт. этого здания` });
    }
  }
  if (airport.level < def.minLevel) return res.status(400).json({ error: 'level_too_low', message: `Нужен уровень ${def.minLevel}` });
  if (airport.money < def.cost) return res.status(400).json({ error: 'not_enough_money' });

  const maxCells = airport.gridSize * airport.gridSize;
  if (typeof cellIndex !== 'number' || cellIndex < 0 || cellIndex >= maxCells) {
    return res.status(400).json({ error: 'invalid_cell' });
  }
  if (store.findBuildingAtCell(airport.id, cellIndex)) {
    return res.status(400).json({ error: 'cell_occupied' });
  }

  // Деньги списываются сразу. XP начислим при ЗАВЕРШЕНИИ стройки (в тике),
  // поэтому уровень пока не трогаем.
  const newMoney = airport.money - def.cost;
  const endsTick = store.getTickCounter() + buildDurationTicks(def);
  store.addBuilding(airport.id, cellIndex, buildingId, { type: 'build', endsTick, xp: def.xp });
  const updated = store.updateAirport(airport.id, { money: newMoney });

  res.json(serializeAirport(updated));
});

// ---------- управление зданием: аренда / продажа / выкуп / снос ----------
function getOwnedBuildingOr404(req, res) {
  const { cellIndex } = req.body || {};
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) { res.status(404).json({ error: 'no_airport' }); return null; }
  const building = store.findBuildingAtCell(airport.id, cellIndex);
  if (!building) { res.status(404).json({ error: 'no_building' }); return null; }
  const def = BUILDINGS[building.buildingId];
  return { airport, building, def };
}

// ---------- биржа аренды ----------
app.post('/api/building/rent-offers', auth, (req, res) => {
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { def, building } = ctx;
  if (!def.removable) return res.status(400).json({ error: 'not_removable', message: 'Это здание нельзя сдать в аренду' });
  if (def.nonRentable) return res.status(400).json({ error: 'non_rentable', message: 'Это здание нельзя сдавать в аренду' });
  if (building.state !== 'owned') return res.status(400).json({ error: 'wrong_state', message: 'Здание сейчас не свободно' });

  const effIncome = def.income * upgradeMultiplier(building.upgradeLevel || 1);
  res.json({ offers: generateRentOffers(def, effIncome) });
});

app.post('/api/building/rent-accept', auth, (req, res) => {
  const { botName, price } = req.body || {};
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building, def } = ctx;
  if (!def.removable) return res.status(400).json({ error: 'not_removable', message: 'Это здание нельзя сдать в аренду' });
  if (def.nonRentable) return res.status(400).json({ error: 'non_rentable', message: 'Это здание нельзя сдавать в аренду' });
  if (building.state !== 'owned') return res.status(400).json({ error: 'wrong_state', message: 'Здание сейчас не свободно' });

  // Не доверяем цене от клиента напрямую — проверяем, что она укладывается
  // в диапазон предложений с учётом апгрейда (как при генерации офферов).
  const effIncome = def.income * upgradeMultiplier(building.upgradeLevel || 1);
  const minPrice = Math.round(effIncome * BOT_ECONOMY.RENT_OFFER_MIN_MULTIPLIER);
  const maxPrice = Math.round(effIncome * BOT_ECONOMY.RENT_OFFER_MAX_MULTIPLIER);
  if (typeof price !== 'number' || price < minPrice || price > maxPrice) {
    return res.status(400).json({ error: 'invalid_price' });
  }

  const updated = store.updateBuildingAtCell(airport.id, building.cellIndex, {
    state: 'rented', botName: botName || randomBotName(), rentPrice: Math.round(price), listedPrice: null,
  });
  res.json({ building: updated, airport: serializeAirport(airport) });
});

app.post('/api/building/rent-list', auth, (req, res) => {
  const { askPrice } = req.body || {};
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building, def } = ctx;
  if (!def.removable) return res.status(400).json({ error: 'not_removable', message: 'Это здание нельзя сдать в аренду' });
  if (def.nonRentable) return res.status(400).json({ error: 'non_rentable', message: 'Это здание нельзя сдавать в аренду' });
  if (building.state !== 'owned') return res.status(400).json({ error: 'wrong_state', message: 'Здание сейчас не свободно' });

  // Доход с учётом уровня апгрейда — от него считаем границы цены аренды,
  // чтобы прокачанное здание можно было сдать дороже.
  const effectiveIncome = def.income * upgradeMultiplier(building.upgradeLevel || 1);
  const minPrice = Math.round(effectiveIncome * BOT_ECONOMY.RENT_LISTING_MIN_MULTIPLIER);
  const maxPrice = Math.round(effectiveIncome * BOT_ECONOMY.RENT_LISTING_MAX_MULTIPLIER);
  if (typeof askPrice !== 'number' || askPrice < minPrice || askPrice > maxPrice) {
    return res.status(400).json({ error: 'invalid_price', message: `Цена должна быть от ${minPrice} до ${maxPrice} у.е.` });
  }

  const updated = store.updateBuildingAtCell(airport.id, building.cellIndex, {
    state: 'listed', listedPrice: Math.round(askPrice), botName: null,
  });
  res.json({ building: updated, airport: serializeAirport(airport) });
});

app.post('/api/building/rent-cancel-listing', auth, (req, res) => {
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building } = ctx;
  if (building.state !== 'listed') return res.status(400).json({ error: 'wrong_state', message: 'Здание сейчас не выставлено на бирже' });

  const updated = store.updateBuildingAtCell(airport.id, building.cellIndex, {
    state: 'owned', listedPrice: null,
  });
  res.json({ building: updated, airport: serializeAirport(airport) });
});

app.post('/api/building/unrent', auth, (req, res) => {
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building } = ctx;
  if (building.state !== 'rented') return res.status(400).json({ error: 'wrong_state', message: 'Здание не сдано в аренду' });

  const updated = store.updateBuildingAtCell(airport.id, building.cellIndex, {
    state: 'owned', botName: null, rentPrice: null,
  });
  res.json({ building: updated, airport: serializeAirport(airport) });
});

// Продажа зданий отключена по дизайну: со зданием можно только строить,
// улучшать, сдавать в аренду и сносить. Эндпоинт оставлен как заглушка,
// чтобы старый клиент получал понятную ошибку.
app.post('/api/building/sell', auth, (req, res) => {
  res.status(400).json({ error: 'disabled', message: 'Продажа зданий недоступна. Можно сдать в аренду или снести.' });
});

app.post('/api/building/buyback', auth, (req, res) => {
  res.status(400).json({ error: 'disabled', message: 'Выкуп недоступен: продажа зданий отключена.' });
});

app.post('/api/building/demolish', auth, (req, res) => {
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building, def } = ctx;
  if (!def.removable) return res.status(400).json({ error: 'not_removable', message: 'Это здание нельзя снести' });
  if (building.state !== 'owned') return res.status(400).json({ error: 'wrong_state', message: 'Сначала верните здание себе (отмените аренду или выкупите)' });

  const refund = Math.round(def.cost * BOT_ECONOMY.DEMOLISH_REFUND_RATE);
  let extraRefund = 0;
  let soldPlanes = 0;
  // при сносе офиса все самолёты продаются (свои) / возвращаются (лизинг)
  if (def.id === 'airline_office') {
    const fleet = store.getAircraftByAirport(airport.id);
    for (const ac of fleet) {
      const t = AIRCRAFT_TYPES[ac.typeId];
      if (ac.ownership === 'owned') {
        extraRefund += resalePrice(t, ac.wear || 0); // возврат за продажу своего
      }
      store.removeAircraft(ac.id);
      soldPlanes++;
    }
  }
  store.removeBuildingAtCell(airport.id, building.cellIndex);
  const updatedAirport = store.updateAirport(airport.id, { money: airport.money + refund + extraRefund });

  const resp = serializeAirport(updatedAirport);
  if (soldPlanes > 0) resp._demolishNote = `Офис снесён. Самолётов продано/возвращено: ${soldPlanes}.`;
  res.json(resp);
});

// Поменять местами две клетки (перестановка объектов на территории).
app.post('/api/building/swap', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });
  const { cellA, cellB } = req.body || {};
  if (typeof cellA !== 'number' || typeof cellB !== 'number' || cellA === cellB) {
    return res.status(400).json({ error: 'bad_cells', message: 'Нужно выбрать две разные клетки' });
  }
  const total = airport.gridSize * airport.gridSize;
  if (cellA < 0 || cellA >= total || cellB < 0 || cellB >= total) {
    return res.status(400).json({ error: 'out_of_range', message: 'Клетка вне территории' });
  }
  store.swapCells(airport.id, cellA, cellB);
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

app.post('/api/building/upgrade', auth, (req, res) => {
  const ctx = getOwnedBuildingOr404(req, res);
  if (!ctx) return;
  const { airport, building, def } = ctx;
  // Апгрейд доступен для любого здания, включая несносимое админздание —
  // это отдельная механика от продажи/сноса.
  if (building.state !== 'owned') return res.status(400).json({ error: 'wrong_state', message: 'Нельзя улучшать здание, пока оно в аренде или продано' });
  // нельзя запустить второй процесс, пока идёт стройка/апгрейд
  if (building.constructionEndsTick != null) {
    return res.status(400).json({ error: 'busy', message: 'Здание сейчас в работе — дождитесь завершения' });
  }

  const currentLevel = building.upgradeLevel || 1;
  if (currentLevel >= def.maxUpgradeLevel) {
    return res.status(400).json({ error: 'max_level_reached', message: 'Достигнут максимальный уровень апгрейда' });
  }
  const nextLevel = currentLevel + 1;
  const cost = upgradeCost(def, nextLevel);
  if (airport.money < cost) return res.status(400).json({ error: 'not_enough_money' });

  // Деньги списываются сразу, уровень применится при ЗАВЕРШЕНИИ (в тике).
  const endsTick = store.getTickCounter() + upgradeDurationTicks(def, nextLevel);
  store.updateBuildingAtCell(airport.id, building.cellIndex, {
    constructionEndsTick: endsTick,
    constructionType: 'upgrade',
    pendingUpgradeLevel: nextLevel,
  });
  const updatedAirport = store.updateAirport(airport.id, { money: airport.money - cost });

  res.json(serializeAirport(updatedAirport));
});

app.post('/api/buy-land', auth, (req, res) => {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) return res.status(404).json({ error: 'no_airport' });

  const expansion = LAND_EXPANSION[airport.landExpansionsBought];
  if (!expansion) return res.status(400).json({ error: 'max_expansion_reached' });
  if (airport.level < expansion.minLevel) return res.status(400).json({ error: 'level_too_low', message: `Нужен уровень ${expansion.minLevel}` });
  if (airport.money < expansion.cost) return res.status(400).json({ error: 'not_enough_money' });

  const newGridSize = Math.min(airport.gridSize + 2, CONFIG.MAX_GRID_SIZE);
  const updated = store.updateAirport(airport.id, {
    money: airport.money - expansion.cost,
    gridSize: newGridSize,
    landExpansionsBought: airport.landExpansionsBought + 1,
  });

  res.json(serializeAirport(updated));
});

app.get('/api/leaderboard', (req, res) => {
  const rows = store.getLeaderboard(50).map(r => ({
    username: r.username, start_type: r.startType, elapsed_seconds: r.elapsedSeconds, achieved_at: r.achievedAt,
  }));
  res.json(rows);
});

// ==================== АДМИН-ПАНЕЛЬ ====================
// Всё ниже требует auth + adminAuth (только пользователи с isAdmin: true,
// по умолчанию — только SoulJourney, см. server/seed.js).

function banStatusOf(user) {
  if (!user.bannedUntil) return { banned: false };
  if (user.bannedUntil === 'forever') return { banned: true, bannedUntil: 'forever' };
  if (Date.now() < user.bannedUntil) return { banned: true, bannedUntil: user.bannedUntil };
  return { banned: false }; // бан истёк сам по себе
}

app.get('/api/admin/players', auth, adminAuth, (req, res) => {
  const users = store.getAllUsers();
  const players = users.map(u => {
    const airport = store.getAirportByUserId(u.id);
    return {
      username: u.username,
      isAdmin: !!u.isAdmin,
      createdAt: u.createdAt,
      ...banStatusOf(u),
      hasAirport: !!airport,
      level: airport ? airport.level : null,
      money: airport ? airport.money : null,
      gridSize: airport ? airport.gridSize : null,
    };
  });
  res.json(players);
});

app.get('/api/admin/players/:username', auth, adminAuth, (req, res) => {
  const user = store.findUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const airport = store.getAirportByUserId(user.id);
  res.json({
    username: user.username,
    isAdmin: !!user.isAdmin,
    createdAt: user.createdAt,
    ...banStatusOf(user),
    airport: airport ? serializeAirport(airport) : null,
  });
});

function getTargetOr404(req, res) {
  const user = store.findUserByUsername(req.params.username);
  if (!user) { res.status(404).json({ error: 'user_not_found' }); return null; }
  const airport = store.getAirportByUserId(user.id);
  if (!airport) { res.status(404).json({ error: 'no_airport', message: 'У игрока ещё нет аэропорта' }); return null; }
  return { user, airport };
}

app.post('/api/admin/players/:username/set-money', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  const { money } = req.body || {};
  if (typeof money !== 'number' || money < 0) return res.status(400).json({ error: 'invalid_value' });
  const updated = store.updateAirport(ctx.airport.id, { money });
  res.json(serializeAirport(updated));
});

app.post('/api/admin/players/:username/set-xp', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  const { xp } = req.body || {};
  if (typeof xp !== 'number' || xp < 0) return res.status(400).json({ error: 'invalid_value' });
  const level = levelFromXp(xp);
  const updated = store.updateAirport(ctx.airport.id, { xp, level });
  res.json(serializeAirport(updated));
});

app.post('/api/admin/players/:username/set-level', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  let { level } = req.body || {};
  if (typeof level !== 'number') return res.status(400).json({ error: 'invalid_value' });
  level = Math.max(1, Math.min(CONFIG.TARGET_LEVEL, Math.round(level)));
  const xp = xpRequiredForLevel(level); // держим xp согласованным с уровнем
  const updated = store.updateAirport(ctx.airport.id, { level, xp });
  res.json(serializeAirport(updated));
});

app.post('/api/admin/players/:username/set-grid-size', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  let { gridSize } = req.body || {};
  if (typeof gridSize !== 'number') return res.status(400).json({ error: 'invalid_value' });
  gridSize = Math.max(1, Math.min(20, Math.round(gridSize)));

  const maxCells = gridSize * gridSize;
  const buildings = store.getBuildingsByAirport(ctx.airport.id);
  let removedCount = 0;
  for (const b of buildings) {
    if (b.cellIndex >= maxCells) {
      store.removeBuildingAtCell(ctx.airport.id, b.cellIndex);
      removedCount++;
    }
  }

  const updated = store.updateAirport(ctx.airport.id, { gridSize });
  res.json({ airport: serializeAirport(updated), removedBuildings: removedCount });
});

app.post('/api/admin/players/:username/save-all', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  let { money, xp, level, gridSize } = req.body || {};
  const patch = {};

  if (money !== undefined) {
    if (typeof money !== 'number' || money < 0) return res.status(400).json({ error: 'invalid_money' });
    patch.money = money;
  }
  // xp и level взаимосвязаны. Определяем, что реально изменил админ:
  // - изменился xp → он главный, пересчитываем level из xp;
  // - иначе если изменился level → синхронизируем xp под новый level.
  // Приоритет у xp: если админ вписал xp, уровень не должен его затирать.
  const curLevel = ctx.airport.level;
  const curXp = Math.floor(ctx.airport.xp);
  const levelChanged = level !== undefined && Math.round(level) !== curLevel;
  const xpChanged = xp !== undefined && Math.round(xp) !== curXp;

  if (xpChanged) {
    if (typeof xp !== 'number' || xp < 0) return res.status(400).json({ error: 'invalid_xp' });
    patch.xp = xp;
    patch.level = levelFromXp(xp);
  } else if (levelChanged) {
    if (typeof level !== 'number') return res.status(400).json({ error: 'invalid_level' });
    level = Math.max(0, Math.min(CONFIG.TARGET_LEVEL, Math.round(level)));
    patch.level = level;
    patch.xp = xpRequiredForLevel(level);
  }

  let removedBuildings = 0;
  if (gridSize !== undefined) {
    if (typeof gridSize !== 'number') return res.status(400).json({ error: 'invalid_grid' });
    gridSize = Math.max(1, Math.min(20, Math.round(gridSize)));
    patch.gridSize = gridSize;
    const maxCells = gridSize * gridSize;
    for (const b of store.getBuildingsByAirport(ctx.airport.id)) {
      if (b.cellIndex >= maxCells) {
        store.removeBuildingAtCell(ctx.airport.id, b.cellIndex);
        removedBuildings++;
      }
    }
  }

  const updated = store.updateAirport(ctx.airport.id, patch);
  res.json({ airport: serializeAirport(updated), removedBuildings });
});

app.post('/api/admin/players/:username/reset', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  // Полный сброс в состояние только что зарегистрировавшегося игрока:
  // сносим все здания и самолёты, обнуляем деньги/xp/уровень/сетку/репутацию.
  store.removeAllBuildings(ctx.airport.id);
  store.removeAllAircraft(ctx.airport.id);
  store.removeAllContracts(ctx.airport.id);
  const updated = store.updateAirport(ctx.airport.id, {
    name: null,              // сбрасываем название — при входе игрок введёт заново
    airline: null,            // сбрасываем авиакомпанию
    airlineOfferSeen: false,
    money: CONFIG.START_MONEY,
    reputation: 0,
    xp: 0,
    level: 0,
    gridSize: CONFIG.START_GRID_SIZE,
    landExpansionsBought: 0,
    reachedLevel10At: null,
    startedAt: Date.now(),
    idleSinceTick: null,
    bankrupt: false,
    apronBorts: [],
    waitingBorts: [],
    fuelStored: 0,
    fuelSupplier: null,
    fuelContract: null,
    fuelAutoContract: false,
    fuelRefillThreshold: 25,
    // пассажирская система — обнуляем пул, очередь терминала и счётчики
    paxPool: { heli: 0, vvl: 0, mvl: 0 },
    termQueue: [],
    heliCarried: 0,
    paxServed: 0,
    heliFlow: { arrived: 0, departed: 0 },
  });
  res.json(serializeAirport(updated));
});

app.post('/api/admin/players/:username/delete', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  // нельзя удалить самого себя через админку (защита от случайности)
  if (ctx.user.id === req.user.id) {
    return res.status(400).json({ error: 'cannot_delete_self', message: 'Нельзя удалить собственный аккаунт из админки' });
  }
  store.deleteUser(ctx.user.id);
  res.json({ deleted: true, username: ctx.user.username });
});

app.post('/api/admin/players/:username/assign-building', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  const { cellIndex, buildingId } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const maxCells = ctx.airport.gridSize * ctx.airport.gridSize;
  if (typeof cellIndex !== 'number' || cellIndex < 0 || cellIndex >= maxCells) {
    return res.status(400).json({ error: 'invalid_cell' });
  }

  if (store.findBuildingAtCell(ctx.airport.id, cellIndex)) {
    store.removeBuildingAtCell(ctx.airport.id, cellIndex); // заменяем то, что было
  }
  store.addBuilding(ctx.airport.id, cellIndex, buildingId);

  res.json(serializeAirport(ctx.airport));
});

app.post('/api/admin/players/:username/remove-building', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  const { cellIndex } = req.body || {};
  store.removeBuildingAtCell(ctx.airport.id, cellIndex); // force — без проверки состояния (owned/rented/sold)
  res.json(serializeAirport(ctx.airport));
});

app.post('/api/admin/players/:username/customize-cell', auth, adminAuth, (req, res) => {
  const ctx = getTargetOr404(req, res);
  if (!ctx) return;
  const { cellIndex, customIcon, customName } = req.body || {};
  const building = store.findBuildingAtCell(ctx.airport.id, cellIndex);
  if (!building) return res.status(404).json({ error: 'no_building' });

  store.updateBuildingAtCell(ctx.airport.id, cellIndex, {
    customIcon: customIcon || null,
    customName: customName || null,
  });
  res.json(serializeAirport(ctx.airport));
});

const BAN_DURATIONS = {
  '5h': 5 * 3600 * 1000,
  '1d': 24 * 3600 * 1000,
  'forever': null, // особый случай — строка 'forever' в самом bannedUntil
};

app.post('/api/admin/players/:username/ban', auth, adminAuth, (req, res) => {
  const { duration } = req.body || {};
  if (!Object.keys(BAN_DURATIONS).includes(duration)) {
    return res.status(400).json({ error: 'invalid_duration', message: 'duration должен быть 5h | 1d | forever' });
  }
  const target = store.findUserByUsername(req.params.username);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  if (target.isAdmin) return res.status(400).json({ error: 'cannot_ban_admin', message: 'Нельзя забанить администратора' });

  const bannedUntil = duration === 'forever' ? 'forever' : Date.now() + BAN_DURATIONS[duration];
  store.setUserBan(req.params.username, bannedUntil);
  closeSocketsForToken(target.token); // выкидываем из активной сессии немедленно

  res.json({ username: req.params.username, bannedUntil });
});

app.post('/api/admin/players/:username/unban', auth, adminAuth, (req, res) => {
  const target = store.findUserByUsername(req.params.username);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  store.setUserBan(req.params.username, null);
  res.json({ username: req.params.username, bannedUntil: null });
});

// ---------- Галерея: медиатека, скины зданий по (тип, уровень), стили текста ----------
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'gallery');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB
// Фоны экранов: картинки + видео (видео тяжелее, отдельный лимит)
const ALLOWED_VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv' };
const MAX_BG_VIDEO_BYTES = 10 * 1024 * 1024; // 10MB для фоновых видео
const MAX_BG_IMAGE_BYTES = 8 * 1024 * 1024;  // 8MB для фоновых картинок (фото с телефона крупнее)

app.get('/api/admin/gallery', auth, adminAuth, (req, res) => {
  res.json({
    catalog: BUILDINGS,
    buildLimits: BUILD_LIMITS,
    mediaLibrary: store.getMediaLibrary(),
    buildingMedia: mediaScan.buildingsManifest(),
    buildingSkins: store.getBuildingSkins(),
    buildingLabelStyles: store.getBuildingLabelStyles(),
    buildingNames: store.getBuildingNames(),
    buildingDescriptions: store.getBuildingDescriptions(),
  });
});

app.post('/api/admin/gallery/describe', auth, adminAuth, (req, res) => {
  const { buildingId, description } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const trimmed = (description || '').trim();
  const descriptions = store.setBuildingDescription(buildingId, trimmed || null);
  res.json({ buildingDescriptions: descriptions });
});

app.post('/api/admin/gallery/rename', auth, adminAuth, (req, res) => {
  const { buildingId, name } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const trimmed = (name || '').trim();
  const names = store.setBuildingName(buildingId, trimmed || null);
  res.json({ buildingNames: names });
});

app.post('/api/admin/gallery/upload', auth, adminAuth, (req, res) => {
  const { dataUrl, filename } = req.body || {};
  if (typeof dataUrl !== 'string') return res.status(400).json({ error: 'invalid_input' });

  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_image', message: 'Ожидается data URL картинки (base64)' });

  const mimeType = match[1];
  const ext = ALLOWED_IMAGE_TYPES[mimeType];
  if (!ext) return res.status(400).json({ error: 'unsupported_type', message: 'Поддерживаются PNG, JPEG, GIF, WEBP, SVG' });

  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'file_too_large', message: 'Максимум 5MB' });
  }

  const safeName = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
  const url = `/uploads/gallery/${safeName}`;

  const asset = store.addMediaAsset(url, filename || safeName);
  res.json(asset);
});

// Логотип игры: загрузка (админ) и публичное получение настроек.
app.post('/api/admin/logo', auth, adminAuth, (req, res) => {
  const { dataUrl } = req.body || {};
  if (typeof dataUrl !== 'string') return res.status(400).json({ error: 'invalid_input' });
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_image', message: 'Ожидается data URL картинки (base64)' });
  const ext = ALLOWED_IMAGE_TYPES[match[1]];
  if (!ext) return res.status(400).json({ error: 'unsupported_type', message: 'Поддерживаются PNG, JPEG, GIF, WEBP, SVG' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'file_too_large', message: 'Максимум 5MB' });

  const safeName = `logo_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
  const url = `/uploads/gallery/${safeName}`;
  const settings = store.setSetting('logoUrl', url);
  res.json({ logoUrl: settings.logoUrl });
});

app.post('/api/admin/logo/remove', auth, adminAuth, (req, res) => {
  const settings = store.setSetting('logoUrl', null);
  res.json({ logoUrl: settings.logoUrl || null });
});

// Фон экрана (auth = вход, game = игра): картинка или видео.
app.post('/api/admin/background', auth, adminAuth, (req, res) => {
  const { screen, dataUrl } = req.body || {};
  if (screen !== 'auth' && screen !== 'game') return res.status(400).json({ error: 'bad_screen' });
  if (typeof dataUrl !== 'string') return res.status(400).json({ error: 'invalid_input' });

  const match = dataUrl.match(/^data:([a-zA-Z0-9\/+.-]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_data', message: 'Ожидается data URL (base64)' });
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');

  let ext, kind;
  if (ALLOWED_IMAGE_TYPES[mime]) {
    ext = ALLOWED_IMAGE_TYPES[mime]; kind = 'image';
    if (buffer.length > MAX_BG_IMAGE_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Картинка — максимум ${Math.round(MAX_BG_IMAGE_BYTES/1024/1024)} МБ` });
  } else if (ALLOWED_VIDEO_TYPES[mime]) {
    ext = ALLOWED_VIDEO_TYPES[mime]; kind = 'video';
    if (buffer.length > MAX_BG_VIDEO_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Видео — максимум ${Math.round(MAX_BG_VIDEO_BYTES/1024/1024)} МБ` });
  } else {
    return res.status(400).json({ error: 'unsupported_type', message: 'Картинка (PNG/JPEG/GIF/WEBP) или видео (MP4/WEBM/OGG)' });
  }

  const safeName = `bg_${screen}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
  const url = `/uploads/gallery/${safeName}`;
  store.setSetting(screen === 'auth' ? 'authBgUrl' : 'gameBgUrl', url);
  store.setSetting(screen === 'auth' ? 'authBgKind' : 'gameBgKind', kind);
  res.json({ url, kind, screen });
});

app.post('/api/admin/background/remove', auth, adminAuth, (req, res) => {
  const { screen } = req.body || {};
  if (screen !== 'auth' && screen !== 'game') return res.status(400).json({ error: 'bad_screen' });
  store.setSetting(screen === 'auth' ? 'authBgUrl' : 'gameBgUrl', null);
  store.setSetting(screen === 'auth' ? 'authBgKind' : 'gameBgKind', null);
  res.json({ screen, url: null });
});

// ---------- Медиа-папки: картинки зданий по уровням и фоны экранов ----------
// Пересканировать папки вручную (после заливки файлов мимо админки — по SFTP/git).
app.post('/api/admin/media/rescan', auth, adminAuth, (req, res) => {
  mediaScan.rescan();
  res.json({ buildings: mediaScan.buildingsManifest(), scannedAt: mediaScan.scannedAt() });
});

// Загрузить картинку конкретного уровня здания прямо в его папку.
app.post('/api/admin/media/building', auth, adminAuth, (req, res) => {
  const { buildingId, level, dataUrl } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const lvl = String(level).toLowerCase();
  if (lvl !== 'default' && !/^[1-9]\d?$/.test(lvl)) {
    return res.status(400).json({ error: 'bad_level', message: 'Уровень — число или default' });
  }
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_image', message: 'Ожидается data URL картинки' });
  const ext = ALLOWED_IMAGE_TYPES[match[1]];
  if (!ext) return res.status(400).json({ error: 'unsupported_type', message: 'PNG, JPEG, GIF, WEBP или SVG' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'file_too_large', message: 'Максимум 5MB' });

  mediaScan.removeBuildingLevel(buildingId, lvl); // убираем прежний файл этого уровня (мог быть другой формат)
  fs.writeFileSync(mediaScan.buildingFilePath(buildingId, lvl, ext), buffer);
  mediaScan.rescan();
  res.json({ buildings: mediaScan.buildingsManifest() });
});

app.post('/api/admin/media/building/remove', auth, adminAuth, (req, res) => {
  const { buildingId, level } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const removed = mediaScan.removeBuildingLevel(buildingId, String(level).toLowerCase());
  mediaScan.rescan();
  res.json({ removed, buildings: mediaScan.buildingsManifest() });
});

// Фоны экранов: список / добавление / удаление файла.
app.get('/api/admin/media/screens', auth, adminAuth, (req, res) => {
  res.json({ auth: mediaScan.listScreen('auth'), game: mediaScan.listScreen('game') });
});

app.post('/api/admin/media/screen', auth, adminAuth, (req, res) => {
  const { screen, dataUrl, filename } = req.body || {};
  if (!mediaScan.SCREENS.includes(screen)) return res.status(400).json({ error: 'bad_screen' });
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-zA-Z0-9\/+.-]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_data', message: 'Ожидается data URL (base64)' });
  const buffer = Buffer.from(match[2], 'base64');

  let ext;
  if (ALLOWED_IMAGE_TYPES[match[1]]) {
    ext = ALLOWED_IMAGE_TYPES[match[1]];
    if (buffer.length > MAX_BG_IMAGE_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Картинка — максимум ${Math.round(MAX_BG_IMAGE_BYTES/1024/1024)} МБ` });
  } else if (ALLOWED_VIDEO_TYPES[match[1]]) {
    ext = ALLOWED_VIDEO_TYPES[match[1]];
    if (buffer.length > MAX_BG_VIDEO_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Видео — максимум ${Math.round(MAX_BG_VIDEO_BYTES/1024/1024)} МБ` });
  } else {
    return res.status(400).json({ error: 'unsupported_type', message: 'Картинка (PNG/JPEG/GIF/WEBP) или видео (MP4/WEBM/OGG)' });
  }

  const base = String(filename || 'bg').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'bg';
  const safeName = `${base}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(mediaScan.screenFilePath(screen, safeName), buffer);
  mediaScan.rescan();
  res.json({ files: mediaScan.listScreen(screen) });
});

app.post('/api/admin/media/screen/remove', auth, adminAuth, (req, res) => {
  const { screen, filename } = req.body || {};
  if (!mediaScan.SCREENS.includes(screen)) return res.status(400).json({ error: 'bad_screen' });
  mediaScan.removeScreenFile(screen, filename);
  mediaScan.rescan();
  res.json({ files: mediaScan.listScreen(screen) });
});

// Публичные настройки игры (логотип) — доступны всем залогиненным.
app.get('/api/settings', auth, (req, res) => {
  const s = store.getSettings();
  res.json({ logoUrl: s.logoUrl || null });
});

// Публичные визуальные настройки — доступны БЕЗ авторизации (нужны на входном экране).
app.get('/api/public-settings', (req, res) => {
  const s = store.getSettings();
  // Сначала папка uploads/screens/<screen>/ (случайный файл из лежащих там),
  // если пусто — старый фон из настроек.
  const authFolder = mediaScan.pickScreenBackground('auth');
  const gameFolder = mediaScan.pickScreenBackground('game');
  res.json({
    logoUrl: s.logoUrl || null,
    authBg: authFolder || (s.authBgUrl ? { url: s.authBgUrl, kind: s.authBgKind || 'image' } : null),
    gameBg: gameFolder || (s.gameBgUrl ? { url: s.gameBgUrl, kind: s.gameBgKind || 'image' } : null),
  });
});

// Настройки геймплея (админ): цены нефти и золота, влияющие на рынок топлива.
app.get('/api/admin/gameplay-settings', auth, adminAuth, (req, res) => {
  const s = store.getSettings();
  res.json({
    oilPrice: s.oilPrice != null ? s.oilPrice : 70,
    goldPrice: s.goldPrice != null ? s.goldPrice : 2000,
    fuelMarketMult: s.fuelMarketMult != null ? s.fuelMarketMult : 1.0,
  });
});

app.post('/api/admin/gameplay-settings', auth, adminAuth, (req, res) => {
  const { oilPrice, goldPrice } = req.body || {};
  if (oilPrice !== undefined) {
    const v = Number(oilPrice);
    if (!isFinite(v) || v < 0) return res.status(400).json({ error: 'invalid_oil' });
    store.setSetting('oilPrice', v);
  }
  if (goldPrice !== undefined) {
    const v = Number(goldPrice);
    if (!isFinite(v) || v < 0) return res.status(400).json({ error: 'invalid_gold' });
    store.setSetting('goldPrice', v);
  }
  // сразу пересчитываем рыночный множитель под новые цены
  const s = store.getSettings();
  const noise = (Math.random() * 2 - 1);
  const mult = fuelMarketMultiplier(s.oilPrice, s.goldPrice, noise);
  store.setSetting('fuelMarketMult', +mult.toFixed(3));
  res.json({
    oilPrice: s.oilPrice, goldPrice: s.goldPrice,
    fuelMarketMult: +mult.toFixed(3),
  });
});

app.post('/api/admin/gallery/assign', auth, adminAuth, (req, res) => {
  const { buildingId, upgradeLevel, url } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const level = Number(upgradeLevel);
  if (!level || level < 1 || level > BUILDINGS[buildingId].maxUpgradeLevel) {
    return res.status(400).json({ error: 'invalid_level' });
  }
  const skins = store.setBuildingSkin(buildingId, level, url || null);
  res.json({ buildingSkins: skins });
});

app.post('/api/admin/gallery/label-style', auth, adminAuth, (req, res) => {
  const { buildingId, fontSize, color } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const style = {};
  if (fontSize) {
    const trimmed = String(fontSize).trim();
    // Голое число ("18") — невалидный CSS для font-size, браузер тихо игнорирует
    // всё правило целиком. Если единица измерения не указана — считаем px.
    style.fontSize = /^\d+(\.\d+)?$/.test(trimmed) ? `${trimmed}px` : trimmed;
  }
  if (color) style.color = String(color).trim();
  const styles = store.setBuildingLabelStyle(buildingId, style);
  res.json({ buildingLabelStyles: styles });
});

// ==================== АВИАПАРК (самолёты) ====================
// Есть ли у аэропорта построенный (введённый в строй) офис авиакомпании.
// Офис открывает работу с самолётами (после создания АК).
function hasBuiltOffice(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  return buildings.some(b => b.buildingId === 'airline_office'
    && (b.state || 'owned') !== 'sold' && !isUnderConstruction(b));
}

// Общие расходы аэропорта в минуту: содержание зданий + лизинговые платежи.
// (Топливо — переменный расход при рейсе, показывается отдельной статьёй-запасом.)
function totalExpensesPerTick(airportId) {
  let expenses = upkeepPerTick(airportId);
  const fleet = store.getAircraftByAirport(airportId);
  for (const ac of fleet) {
    if (ac.ownership === 'lease') {
      const t = AIRCRAFT_TYPES[ac.typeId];
      if (t) expenses += t.leasePerTick || 0;
    }
  }
  return Math.round(expenses);
}

// Можно ли разместить договорный самолёт размера newSize, если на стоянках
// уже стоят свои самолёты (ownSizes) и договорные борты (contractSizes).
function canPlaceContractPlane(airportId, newSize, ownSizes, contractSizes) {
  const stands = listStands(airportId);
  const toPlace = [...ownSizes, ...contractSizes, newSize];
  return assignAll(stands, toPlace);
}

function aircraftCtx(req, res) {
  const airport = store.getAirportByUserId(req.user.id);
  if (!airport) { res.status(404).json({ error: 'no_airport' }); return null; }
  if (!airport.airline) {
    res.status(403).json({ error: 'no_airline', message: 'Сначала создайте авиакомпанию' });
    return null;
  }
  if (!hasBuiltOffice(airport.id)) {
    res.status(403).json({ error: 'no_office', message: 'Постройте офис авиакомпании, чтобы работать с самолётами' });
    return null;
  }
  return { airport };
}

// Приобретение самолёта: покупка (ownership 'owned') или лизинг ('lease').
app.post('/api/aircraft/acquire', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { typeId, mode } = req.body || {}; // mode: 'buy' | 'lease'
  const type = AIRCRAFT_TYPES[typeId];
  if (!type) return res.status(400).json({ error: 'unknown_type' });
  if (mode !== 'buy' && mode !== 'lease') return res.status(400).json({ error: 'bad_mode' });
  if (airport.level < type.minLevel) return res.status(400).json({ error: 'level_too_low', message: `Нужен уровень ${type.minLevel}` });

  // проверка свободной стоянки подходящего размера
  const size = aircraftSize(typeId);
  if (!canPlaceAircraft(airport.id, size)) {
    const sizeNames = { small: 'маленького', medium: 'среднего', large: 'большого' };
    return res.status(400).json({
      error: 'no_stand',
      message: `Нет свободной стоянки для ${sizeNames[size]} самолёта. Постройте подходящую стоянку ВС (или улучшите до ур.3, чтобы вмещала меньшие).`,
    });
  }

  const upfront = mode === 'buy' ? type.buyCost : type.leaseDeposit;
  if (airport.money < upfront) return res.status(400).json({ error: 'not_enough_money' });

  store.updateAirport(airport.id, { money: airport.money - upfront });
  const ac = store.addAircraft(airport.id, typeId, mode === 'buy' ? 'owned' : 'lease');
  const fresh = store.getAirportByUserId(req.user.id);
  res.json({ aircraftId: ac.id, airport: serializeAirport(fresh) });
});

// Выкуп лизингового самолёта в собственность по остаточной цене (с износом).
app.post('/api/aircraft/buyout', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  if (ac.ownership !== 'lease') return res.status(400).json({ error: 'not_lease', message: 'Этот самолёт уже в собственности' });

  const type = AIRCRAFT_TYPES[ac.typeId];
  const price = buyoutPrice(type, ac.wear || 0);
  if (airport.money < price) return res.status(400).json({ error: 'not_enough_money', message: `Нужно ${price.toLocaleString('ru-RU')} у.е.` });

  store.updateAirport(airport.id, { money: airport.money - price });
  store.updateAircraft(ac.id, { ownership: 'owned' });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

// Продажа/возврат самолёта. Собственный — продаём по resale (деньги игроку);
// лизинговый — просто возвращаем лизингодателю (без выплаты).
app.post('/api/aircraft/sell', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  if (ac.status !== 'idle') return res.status(400).json({ error: 'busy', message: 'Самолёт занят — дождитесь окончания рейса' });

  const type = AIRCRAFT_TYPES[ac.typeId];
  let payout = 0;
  if (ac.ownership === 'owned') payout = resalePrice(type, ac.wear || 0);
  store.removeAircraft(ac.id);
  if (payout > 0) store.updateAirport(airport.id, { money: airport.money + payout });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json({ payout, airport: serializeAirport(fresh) });
});

// Отправка самолёта в рейс. Нужна свободная ВПП (число летящих < числа ВПП).
app.post('/api/aircraft/fly', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId, flightType } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  if (ac.status !== 'idle') return res.status(400).json({ error: 'busy', message: 'Самолёт не готов к вылету' });
  if (ac.decommissioned) return res.status(400).json({ error: 'decommissioned', message: 'Самолёт списан (выработал ресурс). Его можно только продать.' });

  // Вышка обязательна для полётов
  if (!hasTower(airport.id)) {
    return res.status(400).json({ error: 'no_tower', message: 'Нужна диспетчерская вышка, чтобы выполнять рейсы' });
  }

  const runways = totalRunways(airport.id);
  if (runways === 0) return res.status(400).json({ error: 'no_runway', message: 'Нужна хотя бы одна ВПП' });

  const type = AIRCRAFT_TYPES[ac.typeId];
  // тип рейса: 'vvl' (по умолчанию) или 'mvl'
  const flight = flightType === 'mvl' ? 'mvl' : 'vvl';
  if (flight === 'mvl') {
    if (type.lineType !== 'both') {
      return res.status(400).json({ error: 'not_certified', message: 'Этот самолёт не сертифицирован для международных рейсов (только ВВЛ)' });
    }
    if (!canFlyMvl(airport.id)) {
      return res.status(400).json({ error: 'no_mvl_infra', message: 'Для МВЛ нужен международный терминал (C/E/F) и средняя или большая ВПП' });
    }
  }

  const nowTick = store.getTickCounter();
  // МВЛ летит дольше (дальше) — растягиваем рейс
  const flightTicks = flight === 'mvl' ? Math.round(type.flightTicks * 1.5) : type.flightTicks;

  // берём вылетающих пассажиров из пула нужного типа (сколько вместит самолёт)
  const capacity = aircraftCapacity(type, ac.upgradeLevel || 1);
  const departingPax = drawFromPool(airport.id, flight, capacity);
  // вылетающие проходят регистрацию/посадку через терминал (очередь)
  const ticket = flight === 'mvl'
    ? Math.round(type.revenuePerPax * AIRCRAFT_ECONOMY.MVL_REVENUE_MULT) : type.revenuePerPax;
  if (departingPax > 0) enqueuePax(airport.id, departingPax, flight, ticket, nowTick);

  store.updateAircraft(ac.id, {
    status: 'flying', flightEndsTick: nowTick + flightTicks, flightType: flight,
    flightPax: departingPax, // сколько пассажиров увёз (для выручки при возврате)
  });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

// Быстрый платный ремонт: мгновенно обнуляет износ за плату.
app.post('/api/aircraft/repair', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  if (ac.status === 'flying' || ac.status === 'waiting') {
    return res.status(400).json({ error: 'busy', message: 'Нельзя чинить самолёт в рейсе' });
  }
  if ((ac.wear || 0) <= 0) return res.status(400).json({ error: 'no_wear', message: 'Самолёт в идеальном состоянии' });

  const repairType = AIRCRAFT_TYPES[ac.typeId];
  const cost = repairCost(ac.wear || 0, repairType ? repairType.buyCost : 0);
  if (airport.money < cost) return res.status(400).json({ error: 'not_enough_money', message: `Нужно ${cost.toLocaleString('ru-RU')} у.е.` });

  store.updateAirport(airport.id, { money: airport.money - cost });
  // ремонт чинит поломку и обнуляет износ
  store.updateAircraft(ac.id, { wear: 0, status: ac.status === 'broken' ? 'idle' : ac.status });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

// Переключение авто-режима рейсов.
app.post('/api/aircraft/toggle-auto', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  store.updateAircraft(ac.id, { auto: !ac.auto });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

// Апгрейд самолёта (повышает вместимость). Мгновенный, самолёт должен быть на стоянке.
app.post('/api/aircraft/upgrade', auth, (req, res) => {
  const ctx = aircraftCtx(req, res);
  if (!ctx) return;
  const { airport } = ctx;
  const { aircraftId } = req.body || {};
  const ac = store.getAircraftById(aircraftId);
  if (!ac || ac.airportId !== airport.id) return res.status(404).json({ error: 'no_aircraft' });
  if (ac.decommissioned) return res.status(400).json({ error: 'decommissioned', message: 'Списанный самолёт нельзя улучшать' });
  if (ac.status !== 'idle') return res.status(400).json({ error: 'busy', message: 'Улучшать можно только самолёт на стоянке' });

  const type = AIRCRAFT_TYPES[ac.typeId];
  const currentLevel = ac.upgradeLevel || 1;
  const maxLevel = type.maxUpgradeLevel || 3;
  if (currentLevel >= maxLevel) return res.status(400).json({ error: 'max_level', message: 'Достигнут максимальный уровень' });

  const nextLevel = currentLevel + 1;
  const cost = aircraftUpgradeCost(type, nextLevel);
  if (airport.money < cost) return res.status(400).json({ error: 'not_enough_money', message: `Нужно ${cost.toLocaleString('ru-RU')} у.е.` });

  store.updateAirport(airport.id, { money: airport.money - cost });
  store.updateAircraft(ac.id, { upgradeLevel: nextLevel });
  const fresh = store.getAirportByUserId(req.user.id);
  res.json(serializeAirport(fresh));
});

// ---------- game tick ----------
function runTick() {
  const currentTick = store.incrementTickCounter();
  const airports = store.getAllAirports();

  // --- Рынок топлива: пересчёт множителя раз в MARKET_REPRICE_DAYS дней ---
  const settings = store.getSettings();
  const repriceInterval = FUEL_ECONOMY.MARKET_REPRICE_DAYS * 1440;
  if (currentTick - (settings.fuelMarketRepricedTick || 0) >= repriceInterval) {
    const noise = (Math.random() * 2 - 1); // -1..1
    const mult = fuelMarketMultiplier(settings.oilPrice, settings.goldPrice, noise);
    store.setSetting('fuelMarketMult', +mult.toFixed(3));
    store.setSetting('fuelMarketRepricedTick', currentTick);
  }

  for (const airport of airports) {
    const buildings = store.getBuildingsByAirport(airport.id);
    let incomePerTick = 0;

    // --- Топливный контракт: истечение и автопродление ---
    if (airport.fuelContract && currentTick >= airport.fuelContract.endsTick) {
      if (airport.fuelAutoContract && airport.level >= FUEL_ECONOMY.CONTRACT_AUTO_MIN_LEVEL) {
        // авто: случайный поставщик, фиксируем его текущую рыночную цену
        const sup = FUEL_SUPPLIERS[Math.floor(Math.random() * FUEL_SUPPLIERS.length)];
        const price = +(sup.pricePerUnit * currentFuelMarketMult()).toFixed(3);
        store.updateAirport(airport.id, {
          fuelSupplier: sup.id,
          fuelContract: { supplierId: sup.id, pricePerUnit: price, endsTick: currentTick + FUEL_ECONOMY.CONTRACT_DURATION_DAYS * 1440 },
        });
      } else {
        // контракт просто истёк — снимаем
        store.updateAirport(airport.id, { fuelContract: null });
      }
    }

    // --- Контракт поставляет топливо: дозаправка по порогу ---
    {
      const fresh = store.getAirportById(airport.id);
      if (fresh.fuelContract && currentTick < fresh.fuelContract.endsTick && hasFuelDepot(fresh.id)) {
        const capacity = totalFuelCapacity(fresh.id);
        const stored = fresh.fuelStored || 0;
        const thresholdPct = fresh.fuelRefillThreshold != null ? fresh.fuelRefillThreshold : FUEL_ECONOMY.CONTRACT_DEFAULT_THRESHOLD;
        const thresholdUnits = capacity * (thresholdPct / 100);
        if (stored < thresholdUnits) {
          // разрыв только при нулевом/отрицательном балансе
          if (fresh.money <= 0) {
            store.updateAirport(fresh.id, { fuelContract: null, fuelAutoContract: false });
            notifications.push('⛽ Контракт с поставщиком разорван — нет средств на топливо. Авто-режим отключён, включите заново на бирже.');
          } else {
            const price = fresh.fuelContract.pricePerUnit;
            const need = capacity - stored;                       // сколько до полного
            const affordable = Math.floor(fresh.money / price);   // сколько можем купить
            const buy = Math.min(need, affordable);
            if (buy > 0) {
              const cost = Math.round(buy * price);
              store.updateAirport(fresh.id, {
                fuelStored: stored + buy,
                money: fresh.money - cost,
              });
            }
          }
        }
      }
    }
    let reputationPerTick = 0;
    const notifications = [];

    for (const b of buildings) {
      const def = BUILDINGS[b.buildingId];
      if (!def) continue;
      const state = b.state || 'owned';

      // --- строительство/апгрейд во времени ---
      if (b.constructionEndsTick != null) {
        if (currentTick >= b.constructionEndsTick) {
          // работы завершены
          if (b.constructionType === 'build') {
            // достроено: начисляем отложенный XP, включаем здание
            const gainedXp = b.pendingXp || 0;
            store.updateBuildingAtCell(airport.id, b.cellIndex, {
              constructionEndsTick: null, constructionType: null, pendingXp: 0,
            });
            const fa = store.getAirportByUserId(airport.userId) || airport;
            const nx = fa.xp + gainedXp;
            const nl = levelFromXp(nx);
            const p = { xp: nx, level: nl };
            if (nl >= CONFIG.TARGET_LEVEL && !fa.reachedLevel10At) {
              p.reachedLevel10At = Date.now();
              const elapsed = Math.round((p.reachedLevel10At - fa.startedAt) / 1000);
              const u = store.findUserById(airport.userId);
              if (u) store.addLeaderboardEntry(u.username, fa.startType, elapsed);
            }
            store.updateAirport(airport.id, p);
            notifications.push(`🏗️ «${def.name}» построен и введён в эксплуатацию (+${gainedXp} XP)`);
            if (nl > fa.level) notifications.push(`⭐ Новый уровень: ${nl}!`);
          } else if (b.constructionType === 'upgrade') {
            // апгрейд завершён: применяем новый уровень
            store.updateBuildingAtCell(airport.id, b.cellIndex, {
              upgradeLevel: b.pendingUpgradeLevel || (b.upgradeLevel || 1),
              constructionEndsTick: null, constructionType: null, pendingUpgradeLevel: null,
            });
            notifications.push(`⬆️ «${def.name}» улучшен до уровня ${b.pendingUpgradeLevel}`);
          }
        }
        // пока СТРОИТСЯ (build) — здание не даёт дохода/репутации, пропускаем
        if (b.constructionType === 'build') continue;
        // пока АПГРЕЙД — здание работает, но со сниженными показателями (ниже)
      }

      if (state === 'sold') continue; // здание не игрока — ни дохода, ни репутации
      if (state === 'listed') {
        // на бирже, ещё не сдано — дохода пока нет, зато решаем, согласится ли бот
        const effIncome = def.income * upgradeMultiplier(b.upgradeLevel || 1);
        const accepted = Math.random() < rentAcceptChance(b.listedPrice, def, effIncome);
        if (accepted) {
          const botName = randomBotName();
          store.updateBuildingAtCell(airport.id, b.cellIndex, {
            state: 'rented', botName, rentPrice: b.listedPrice, listedPrice: null,
          });
          notifications.push(`✅ ${botName} согласился арендовать «${def.name}» за ${b.listedPrice} у.е./тик`);
        } else if (Math.random() < BOT_ECONOMY.LISTING_EXPIRE_CHANCE_PER_TICK) {
          store.updateBuildingAtCell(airport.id, b.cellIndex, { state: 'owned', listedPrice: null });
          notifications.push(`❌ Никто из ботов не согласился на аренду «${def.name}» за ${b.listedPrice} у.е./тик. Здание осталось у вас.`);
        }
        // иначе — остаётся выставленным, попробуем снова на следующем тике
        continue;
      }

      const upgradeMult = upgradeMultiplier(b.upgradeLevel || 1);
      // во время апгрейда показатели снижены на UPGRADE_WORK_PENALTY
      const workPenalty = (b.constructionEndsTick != null && b.constructionType === 'upgrade')
        ? (1 - CONFIG.UPGRADE_WORK_PENALTY) : 1;
      let income;
      if (def.id === 'airline_office') {
        // офис: пока нет самолётов — убыток; есть хотя бы один — обычный доход
        const fleetCount = store.getAircraftByAirport(airport.id).length;
        income = fleetCount > 0
          ? Math.round(def.income * upgradeMult * workPenalty)
          : (def.officeIncomeWithoutAircraft || -60);
      } else {
        income = state === 'rented'
          ? (b.rentPrice || def.income)
          : Math.round(def.income * upgradeMult * workPenalty);
      }
      incomePerTick += income;
      reputationPerTick += (def.reputation || 0) * upgradeMult * workPenalty;
    }

    // ---- генерация пассажирского трафика (пулы ожидающих вылета) ----
    generateTraffic(airport);

    // ---- самолёты ----
    const aircraftResult = processAircraftTick(airport, currentTick, notifications);
    incomePerTick += aircraftResult.income;
    reputationPerTick += aircraftResult.reputation;

    // ---- договоры с авиакомпаниями (конверт) + прилёты бортов ----
    const contractResult = processContractsTick(airport, currentTick, notifications);
    incomePerTick += contractResult.income;
    reputationPerTick += contractResult.reputation;

    // ---- терминалы: обслуживание очередей пассажиров (вылет+прилёт) ----
    const termResult = processTerminalsTick(store.getAirportByUserId(airport.userId) || airport, currentTick, notifications);
    incomePerTick += termResult.income;
    reputationPerTick += termResult.reputation;

    incomePerTick = Math.round(incomePerTick);
    reputationPerTick = Math.round(reputationPerTick);
    const freshAirport = store.getAirportByUserId(airport.userId) || airport;

    // --- Содержание аэропорта ---
    let upkeep = upkeepPerTick(airport.id);
    // Простой: если аэропорт неактивен, копим счётчик; при долгом простое расход растёт
    let idleSince = freshAirport.idleSinceTick;
    if (isAirportActive(airport.id)) {
      idleSince = null; // активен — сбрасываем простой
    } else {
      if (idleSince == null) idleSince = currentTick; // только начал простаивать
      const idleMinutes = currentTick - idleSince;
      if (idleMinutes >= CONFIG.IDLE_MINUTES_BEFORE_PENALTY) {
        upkeep *= CONFIG.IDLE_UPKEEP_MULTIPLIER; // штраф за долгий простой
      }
    }
    upkeep = Math.round(upkeep);

    // Баланс с учётом дохода и содержания. Может уйти в минус (долг),
    // но не глубже дна = суммарной стоимости всех зданий.
    const floor = -debtFloor(airport.id);
    let newMoney = freshAirport.money + incomePerTick - upkeep;
    let bankrupt = false;
    if (newMoney <= floor) {
      newMoney = floor;   // дно долга
      bankrupt = true;     // достигли дна — банкротство
    }

    // Репутация: если баланс в минусе — падает; иначе обычное изменение
    let repChange = reputationPerTick;
    if (newMoney < 0) repChange -= Math.max(1, Math.round(Math.abs(newMoney) / 5000)); // чем глубже долг, тем сильнее
    const newRep = Math.max(0, freshAirport.reputation + repChange);

    // Пассивный опыт за тик (растёт с уровнем) — вторая половина прогрессии.
    const xpPerTick = CONFIG.XP_PER_TICK_BASE + freshAirport.level * CONFIG.XP_PER_TICK_PER_LEVEL;
    const newXp = freshAirport.xp + xpPerTick;
    const newLevel = levelFromXp(newXp);
    const patch = { money: newMoney, reputation: newRep, xp: newXp, level: newLevel, idleSinceTick: idleSince };
    if (bankrupt) patch.bankrupt = true;
    if (newLevel > freshAirport.level) {
      notifications.push(`⭐ Новый уровень: ${newLevel}!`);
      if (newLevel >= CONFIG.TARGET_LEVEL && !freshAirport.reachedLevel10At) {
        patch.reachedLevel10At = Date.now();
      }
    }
    if (newMoney < 0 && !bankrupt) {
      notifications.push(`⚠️ Долг ${Math.abs(newMoney).toLocaleString('ru-RU')} у.е. Содержание аэропорта в минусе — репутация падает!`);
    }
    const updated = store.updateAirport(airport.id, patch);

    const user = store.findUserById(airport.userId);
    if (user) {
      pushToUser(user.token, {
        type: 'tick', income: incomePerTick - upkeep, reputation: repChange,
        upkeep, notifications, state: serializeAirport(updated),
        bankrupt,
      });
    }
  }
}

// Обработка авиапарка за тик. Возвращает суммарный доход и изменение репутации
// (могут быть отрицательными из-за лизинга/топлива/штрафов за ожидание).
function processAircraftTick(airport, currentTick, notifications) {
  const fleet = store.getAircraftByAirport(airport.id);
  if (fleet.length === 0) return { income: 0, reputation: 0 };

  let income = 0;
  let reputation = 0;
  const runways = totalRunways(airport.id);
  let landingsThisTick = 0;

  // Свободные "ремонтные" места ангаров: всего мест под самолёты в ангарах
  // минус те, кто сейчас стоит (idle/broken/waiting не в воздухе). Упрощаем:
  // ангар лечит до N самолётов за тик, где N = суммарная ёмкость ангаров.
  let hangarRepairsLeft = totalHangarSlots(airport.id);

  // Выполнить посадку самолёта: начислить выручку, поднять износ, проверить поломку.
  function landAircraft(ac, type) {
    const isMvl = ac.flightType === 'mvl';
    const capacity = aircraftCapacity(type, ac.upgradeLevel || 1);
    // пассажиры = сколько реально увезли при вылете (из пула). Столько же прилетает обратно.
    const pax = ac.flightPax != null ? ac.flightPax : capacity;
    let fuelNeeded = type.fuelPerFlight;
    if (isMvl) fuelNeeded = Math.round(fuelNeeded * AIRCRAFT_ECONOMY.MVL_FUEL_MULT); // МВЛ — дальше, топлива больше
    if (Math.random() < AIRCRAFT_ECONOMY.DELAY_CHANCE) {
      fuelNeeded = Math.round(fuelNeeded * (1 + AIRCRAFT_ECONOMY.DELAY_EXTRA_FUEL_RATE));
    }

    // Топливо: часть заправляем дома (со склада — бесплатно, если есть запас),
    // остальное покупаем у поставщика (дозаправка в Б + домашняя часть, если склад пуст).
    const fresh = store.getAirportByUserId(airport.userId) || airport;
    const homeShare = Math.round(fuelNeeded * FUEL_ECONOMY.HOME_FUEL_SHARE);
    const awayShare = fuelNeeded - homeShare; // всегда платная дозаправка «в Б»
    const stored = fresh.fuelStored || 0;
    const fromStorage = Math.min(homeShare, stored); // сколько взяли со склада бесплатно
    const homePaid = homeShare - fromStorage;         // домашняя часть, если склад не хватил — платно
    const price = fuelUnitPrice(fresh);
    const fuelCost = Math.round((awayShare + homePaid) * price);
    if (fromStorage > 0) {
      store.updateAirport(airport.id, { fuelStored: stored - fromStorage });
    }

    // Выручка: МВЛ билет дороже, рынок (нефть/золото) влияет на цену
    const baseRev = isMvl ? Math.round(type.revenuePerPax * AIRCRAFT_ECONOMY.MVL_REVENUE_MULT) : type.revenuePerPax;
    const revPerPax = Math.round(baseRev * priceMarketMult());
    const revenue = pax * revPerPax - fuelCost;
    income += revenue;

    const newWear = Math.min(AIRCRAFT_ECONOMY.WEAR_MAX, (ac.wear || 0) + AIRCRAFT_ECONOMY.WEAR_PER_FLIGHT);
    const broke = Math.random() < newWear * AIRCRAFT_ECONOMY.BREAKDOWN_CHANCE_PER_WEAR;

    // накапливаем доход для ресурса списания (учитываем только положительную выручку)
    const newEarnings = (ac.totalEarnings || 0) + Math.max(0, revenue);
    const threshold = decommissionThreshold(type);
    const nowDecommissioned = newEarnings >= threshold;

    // прибывшие пассажиры проходят через терминал (очередь на выход)
    if (pax > 0) enqueuePax(airport.id, pax, isMvl ? 'mvl' : 'vvl', revPerPax, currentTick);

    store.updateAircraft(ac.id, {
      status: 'idle',
      flightEndsTick: null,
      flightPax: null,
      wear: newWear,
      totalEarnings: newEarnings,
      decommissioned: nowDecommissioned,
      auto: nowDecommissioned ? false : ac.auto,
    });
    if (nowDecommissioned) {
      notifications.push(`🛑 ${type.name} выработал ресурс и списан (окупился 2×). Теперь его можно только продать.`);
    } else if (broke) {
      store.updateAircraft(ac.id, { status: 'broken' });
      notifications.push(`🛠️ ${type.name} сломался после рейса (износ ${Math.round(newWear * 100)}%). Нужен ремонт.`);
    } else {
      notifications.push(`🛬 ${type.name} вернулся: ${pax} пасс., выручка ${revenue.toLocaleString('ru-RU')} у.е.`);
    }
  }

  for (const ac of fleet) {
    const type = AIRCRAFT_TYPES[ac.typeId];

    // Лизинговый платёж — каждый тик, пока самолёт у игрока
    if (ac.ownership === 'lease') income -= type.leasePerTick;

    if (ac.status === 'flying') {
      if (currentTick >= ac.flightEndsTick) {
        const standFree = canPlaceAircraft(airport.id, aircraftSize(ac.typeId));
        if (landingsThisTick < runways && standFree) {
          landingsThisTick++;
          landAircraft(ac, type);
        } else {
          // нет ВПП или нет свободной стоянки — кружит, ждёт
          income -= type.idlePenaltyPerTick;
          reputation -= type.idleRepPenaltyPerTick;
          store.updateAircraft(ac.id, { status: 'waiting' });
        }
      }
    } else if (ac.status === 'waiting') {
      const standFree = canPlaceAircraft(airport.id, aircraftSize(ac.typeId));
      if (landingsThisTick < runways && standFree) {
        landingsThisTick++;
        landAircraft(ac, type);
      } else {
        income -= type.idlePenaltyPerTick;
        reputation -= type.idleRepPenaltyPerTick;
        const reason = !standFree ? 'нет свободной стоянки' : 'нет свободной ВПП';
        notifications.push(`⚠️ ${type.name} кружит — ${reason}. Идут издержки.`);
      }
    } else if (ac.status === 'broken' || ac.status === 'idle') {
      // Ангар постепенно чинит стоящие самолёты (бесплатно), если есть ёмкость
      if ((ac.wear || 0) > 0 && hangarRepairsLeft > 0) {
        hangarRepairsLeft--;
        const reduced = Math.max(0, (ac.wear || 0) - AIRCRAFT_ECONOMY.ANGAR_REPAIR_PER_TICK);
        const nowFixed = reduced <= 0;
        store.updateAircraft(ac.id, {
          wear: reduced,
          // если это была поломка и износ снизился — возвращаем в строй
          status: (ac.status === 'broken' && (nowFixed || reduced < (ac.wear || 0))) ? 'idle' : ac.status,
        });
      }
    }
  }

  // --- авто-режим: отправляем свободные самолёты с флагом auto в рейс,
  // если есть вышка и ВПП (ВПП освобождается сразу, не ограничивает число рейсов) ---
  if (runways > 0 && hasTower(airport.id)) {
    const updatedFleet = store.getAircraftByAirport(airport.id);
    for (const ac of updatedFleet) {
      if (!ac.auto) continue;
      if (ac.status !== 'idle') continue;
      if (ac.decommissioned) continue;
      const type = AIRCRAFT_TYPES[ac.typeId];
      // авто-рейс ВВЛ: берём пассажиров из ВВЛ-пула
      const capacity = aircraftCapacity(type, ac.upgradeLevel || 1);
      const departingPax = drawFromPool(airport.id, 'vvl', capacity);
      if (departingPax > 0) enqueuePax(airport.id, departingPax, 'vvl', type.revenuePerPax, currentTick);
      store.updateAircraft(ac.id, {
        status: 'flying', flightEndsTick: currentTick + type.flightTicks,
        flightType: 'vvl', flightPax: departingPax,
      });
    }
  }

  return { income, reputation };
}

// Обработка договоров и прилётов бортов за тик. Возвращает { income, reputation }.
// Модель (Слой 1): договор периодически шлёт борт → борт садится, если есть
// свободное место (иначе ждёт очереди до MAX_WAIT, потом разворот со штрафом) →
// стоит STAND_MINUTES → улетает, освобождая место. Оплата — за каждый прилёт.
function processContractsTick(airport, currentTick, notifications) {
  let income = 0;
  let reputation = 0;
  const fresh = store.getAirportByUserId(airport.userId) || airport;
  let apron = (fresh.apronBorts || []).slice();     // борты на стоянке
  let waiting = (fresh.waitingBorts || []).slice();  // в очереди
  const totalSlots = totalApronSlots(airport.id);

  // 1) Вылеты со стоянки — борт увозит вылетающих пассажиров из пула,
  //    аэропорт получает комиссию (20%) с их билетов. Освобождаем место.
  const departed = apron.filter(b => currentTick >= b.departsTick);
  apron = apron.filter(b => currentTick < b.departsTick);
  for (const b of departed) {
    // тип пула по борту: вертолёт → heli, самолёт → flightType (vvl/mvl)
    const poolType = b.craft === 'heli' ? 'heli' : (b.flightType === 'mvl' ? 'mvl' : 'vvl');
    // сколько борт может увезти (по размеру), берём из очереди на вылет
    const capacity = contractCraftCapacity(b.craft, b.size);
    const taken = drawFromPool(airport.id, poolType, capacity);
    if (taken > 0) {
      const baseTicket = poolType === 'mvl'
        ? Math.round(APRON_ECONOMY.TICKET_PRICE_VVL * APRON_ECONOMY.MVL_CONTRACT_MULT)
        : APRON_ECONOMY.TICKET_PRICE_VVL;
      const ticket = Math.round(baseTicket * priceMarketMult()); // рынок влияет на цену билета
      const commission = Math.round(taken * ticket * APRON_ECONOMY.CONTRACT_COMMISSION);
      income += commission;
      const freshP = store.getAirportByUserId(airport.userId) || airport;
      store.updateAirport(airport.id, { paxServed: (freshP.paxServed || 0) + taken });
      const icon = b.craft === 'heli' ? '🚁' : '✈️';
      notifications.push(`${icon} Борт «${b.airline}» увёз ${taken} пасс. — комиссия аэропорта +${commission} у.е.`);
    }
  }

  // 2) Доход от активных договоров: планируем прилёты + удаляем истёкшие
  const contracts = store.getContracts(airport.id);
  for (const c of contracts) {
    if (currentTick >= c.endsTick) {
      notifications.push(`📄 Договор с «${c.airline}» истёк.`);
      store.removeContract(c.id);
      continue;
    }
    // пора ли этому договору прислать борт?
    if (c.nextArrivalTick != null && currentTick >= c.nextArrivalTick) {
      waiting.push({
        contractId: c.id, airline: c.airline,
        waitingSinceTick: currentTick,
        payPerArrival: c.payPerArrival || 40,
        craft: c.craft || 'heli',
        size: c.size || null,
        flightType: c.flightType || 'vvl',
      });
      const iv = APRON_ECONOMY.CONTRACT_ARRIVAL_INTERVAL;
      const variance = 1 + (Math.random() * 2 - 1) * APRON_ECONOMY.ARRIVAL_INTERVAL_VARIANCE;
      store.updateContract(c.id, { nextArrivalTick: currentTick + Math.round(iv * variance) });
    }
  }

  // 3) Обрабатываем очередь: сажаем борты по типу площадки.
  // Вертолёты → вертолётные места (helipad). Самолёты → стоянки нужного размера
  // (с учётом своих самолётов и уже стоящих договорных бортов).
  const heliOccupied = apron.filter(b => (b.craft || 'heli') === 'heli').length;
  const heliTotal = totalApronSlots(airport.id);
  let heliFree = heliTotal - heliOccupied;

  // занятость стоянок: свои самолёты + договорные самолёты на земле
  const ownPlaneSizes = store.getAircraftByAirport(airport.id).map(a => aircraftSize(a.typeId));
  const contractPlaneSizes = apron.filter(b => b.craft === 'plane').map(b => b.size);

  const stillWaiting = [];
  for (const w of waiting) {
    const craft = w.craft || 'heli';
    if (craft === 'heli') {
      if (heliFree > 0) {
        heliFree--;
        apron.push({
          contractId: w.contractId, airline: w.airline,
          departsTick: currentTick + APRON_ECONOMY.HELI_STAND_MINUTES,
          payPerArrival: w.payPerArrival, craft: 'heli', size: null, flightType: 'vvl',
        });
        income += w.payPerArrival;
        // заправка чужого борта со склада (топливо убывает; штраф при нехватке)
        const freshFuel = store.getAirportByUserId(airport.userId) || airport;
        const rf = refuelContractCraft(freshFuel, 'heli', null);
        if (rf.moneyPenalty > 0) {
          income -= rf.moneyPenalty;
          reputation -= rf.repPenalty;
          notifications.push(`⛽ Не хватило топлива для борта «${w.airline}» — экстренная закупка ${rf.moneyPenalty} у.е., репутация упала.`);
        }
        notifications.push(`🚁 Борт «${w.airline}» прибыл (+${w.payPerArrival} у.е. за прилёт)`);
      } else if (currentTick - w.waitingSinceTick >= APRON_ECONOMY.MAX_WAIT_MINUTES) {
        const penalty = w.payPerArrival * APRON_ECONOMY.TURNAWAY_PENALTY_MULT;
        income -= penalty;
        reputation -= APRON_ECONOMY.TURNAWAY_REPUTATION_HIT;
        notifications.push(`🚁 Борт «${w.airline}» развернулся — нет вертолётного места! Штраф ${penalty} у.е.`);
      } else {
        stillWaiting.push(w);
      }
    } else {
      // самолётный борт: нужна свободная стоянка его размера
      const placed = canPlaceContractPlane(airport.id, w.size, ownPlaneSizes, contractPlaneSizes);
      if (placed) {
        contractPlaneSizes.push(w.size); // занимаем стоянку
        apron.push({
          contractId: w.contractId, airline: w.airline,
          departsTick: currentTick + APRON_ECONOMY.STAND_MINUTES,
          payPerArrival: w.payPerArrival, craft: 'plane', size: w.size, flightType: w.flightType || 'vvl',
        });
        income += w.payPerArrival;
        // заправка чужого самолёта со склада (топливо убывает; штраф при нехватке)
        const freshFuelP = store.getAirportByUserId(airport.userId) || airport;
        const rfp = refuelContractCraft(freshFuelP, 'plane', w.size);
        if (rfp.moneyPenalty > 0) {
          income -= rfp.moneyPenalty;
          reputation -= rfp.repPenalty;
          notifications.push(`⛽ Не хватило топлива для самолёта «${w.airline}» — экстренная закупка ${rfp.moneyPenalty} у.е., репутация упала.`);
        }
        const label = w.flightType === 'mvl' ? 'МВЛ' : 'ВВЛ';
        notifications.push(`✈️ Самолёт «${w.airline}» (${label}) прибыл (+${w.payPerArrival} у.е. за прилёт)`);
      } else if (currentTick - w.waitingSinceTick >= APRON_ECONOMY.MAX_WAIT_MINUTES) {
        const penalty = w.payPerArrival * APRON_ECONOMY.TURNAWAY_PENALTY_MULT;
        income -= penalty;
        reputation -= APRON_ECONOMY.TURNAWAY_REPUTATION_HIT;
        notifications.push(`✈️ Самолёт «${w.airline}» развернулся — нет свободной стоянки! Штраф ${penalty} у.е.`);
      } else {
        stillWaiting.push(w);
      }
    }
  }

  // сохраняем обновлённые списки бортов
  store.updateAirport(airport.id, { apronBorts: apron, waitingBorts: stillWaiting });

  // 4) Чистка истёкших предложений в конверте
  const offers = store.getContractOffers(airport.id);
  for (const o of offers) {
    if (currentTick >= o.expiresTick) store.removeContractOffer(o.id);
  }

  // 5) Появление новых предложений
  const activeOffers = store.getContractOffers(airport.id);
  if (canAcceptContracts(airport.id) && activeOffers.length < CONTRACT_ECONOMY.MAX_OFFERS) {
    const pads = countHelipads(airport.id);
    const stands = listStands(airport.id).length;
    const chance = Math.min(
      CONTRACT_ECONOMY.OFFER_CHANCE_MAX,
      CONTRACT_ECONOMY.OFFER_CHANCE_BASE
        + pads * CONTRACT_ECONOMY.OFFER_CHANCE_PER_PAD
        + stands * CONTRACT_ECONOMY.OFFER_CHANCE_PER_STAND
        + fresh.reputation * CONTRACT_ECONOMY.OFFER_CHANCE_PER_REPUTATION
    );
    if (Math.random() < chance) {
      const offer = makeContractOffer(fresh, currentTick);
      store.addContractOffer(airport.id, offer);
      notifications.push(`✉️ Новое предложение от «${offer.airline}»: ${offer.payPerArrival} у.е. за прилёт`);
    }
  }

  return { income, reputation };
}

// Суммарная ёмкость ангаров (для ремонта) — сколько самолётов ангары могут
// обслуживать за тик. Считаем по местам ангаров (стоянки не чинят).
function totalHangarSlots(airportId) {
  const buildings = store.getBuildingsByAirport(airportId);
  let slots = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.buildingId];
    if (!def || def.id !== 'hangar') continue;
    if ((b.state || 'owned') === 'sold') continue;
    if (isUnderConstruction(b)) continue;
    slots += aircraftSlotsOf(def, b.upgradeLevel || 1);
  }
  return slots;
}

setInterval(runTick, CONFIG.TICK_MS);

const PORT = process.env.PORT || 3000;

ensureSuperuser();

server.listen(PORT, () => {
  console.log(`Soul Journey server running on http://localhost:${PORT}`);
  console.log(`Tick interval: ${CONFIG.TICK_MS / 1000}s`);
});
