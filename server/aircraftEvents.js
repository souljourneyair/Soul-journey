// Случайные события с самолётами.
//
// Разыгрываются раз в игровую неделю для каждого аэропорта. Событие выбирает
// случайный самолёт — договорной борт на стоянке или собственный борт игрока —
// и применяет эффект: ремонт в ангаре (с платой авиакомпании или бесплатный),
// задержку, убыток своей АК или страховку. Новости об инцидентах попадают
// в раздел «Новости» через переданный логгер.

const { AIRCRAFT_EVENTS, AIRCRAFT_TYPES } = require('./gameData');

// Наземный транспорт для сюжета «столкновение на перроне».
const GROUND_VEHICLES = [
  'автомобилем сопровождения Follow me', 'амбулифтом', 'легковым автомобилем',
  'микроавтобусом', 'тягачом', 'багажной тележкой', 'трапом',
];

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Логгер новостей — передаётся из index.js (чтобы модуль не зависел от store).
let logNews = null;
function setNewsLogger(fn) { logNews = fn; }

// Договорные самолёты, стоящие на стоянке (craft === 'plane').
function contractPlanes(airport) {
  return (airport.apronBorts || []).filter(b => (b.craft || 'heli') === 'plane');
}

// Собственные самолёты игрока, которые сейчас на земле (не в рейсе, не в круге).
function ownPlanes(store, airportId) {
  return store.getAircraftByAirport(airportId).filter(a =>
    !a.decommissioned && a.status !== 'flying' && a.status !== 'waiting');
}

// Имя типа самолёта по его id (для текстов новостей).
function typeName(ac) {
  const t = AIRCRAFT_TYPES[ac.typeId];
  return t ? t.name : 'Самолёт';
}

// Продлить стоянку договорного борта на N минут (ремонт/задержка) и, при
// необходимости, пометить его как «на ремонте» для расписания.
function extendContractBoard(store, airport, board, minutes, repairing) {
  const fresh = store.getAirportById(airport.id);
  store.updateAirport(airport.id, {
    apronBorts: (fresh.apronBorts || []).map(b =>
      b === board ? { ...b, departsTick: Math.max(b.departsTick || 0, 0) + minutes, repairing: !!repairing } : b),
  });
}

// Поставить собственный самолёт на ремонт в ангар до указанного тика.
function groundOwnPlane(store, ac, untilTick) {
  store.updateAircraft(ac.id, { repairEndsTick: untilTick });
}

// ==================== события 1–4: отказ техники, платит договорной борт ====================
const REPAIRS = {
  brake: {
    title: 'Отказ тормозов',
    text: (airline, pay, minutes) =>
      `У самолёта авиакомпании «${airline}» при рулении отказали тормоза. Борт провёл в ангаре ${minutes} минут, авиакомпания оплатила ремонт — ${pay.toLocaleString('ru-RU')} у.е.`,
  },
  flaps: {
    title: 'Отказ закрылков',
    text: (airline, pay, minutes) =>
      `Перед взлётом у борта «${airline}» не выпустились закрылки. Ремонт занял ${minutes} минут и обошёлся авиакомпании в ${pay.toLocaleString('ru-RU')} у.е.`,
  },
  fuel_leak: {
    title: 'Утечка топлива',
    text: (airline, pay, minutes) =>
      `На перроне у самолёта «${airline}» обнаружили утечку топлива. Борт ${minutes} минут ремонтировали в ангаре, авиакомпания перечислила ${pay.toLocaleString('ru-RU')} у.е.`,
  },
  engine: {
    title: 'Двигатель не запустился',
    text: (airline, pay, minutes) =>
      `У борта «${airline}» не запустился двигатель. Ремонт в ангаре занял ${minutes} минут, авиакомпания оплатила ${pay.toLocaleString('ru-RU')} у.е.`,
  },
};

function runRepair(store, airport, currentTick, kind) {
  const cfg = AIRCRAFT_EVENTS[kind.toUpperCase()];
  const board = rnd(contractPlanes(airport));
  const pay = Math.round((board.payPerArrival || 40) * cfg.payMult);
  extendContractBoard(store, airport, board, cfg.repairMinutes, true);
  const fresh = store.getAirportById(airport.id);
  store.updateAirport(airport.id, { money: fresh.money + pay });
  const t = REPAIRS[kind];
  return { title: t.title, text: t.text(board.airline, pay, cfg.repairMinutes) };
}

// ==================== событие 5: деструктивный пассажир ====================
function runPassenger(store, airport, currentTick) {
  const minutes = AIRCRAFT_EVENTS.PASSENGER_DELAY_MINUTES;
  const board = rnd(contractPlanes(airport));
  const own = ownPlanes(store, airport.id);

  // Свой борт, если он есть; иначе договорной (или наоборот — 50/50 при обоих).
  let target = null;
  if (board && own) target = Math.random() < 0.5 ? { type: 'contract', ref: board } : { type: 'own', ref: own };
  else if (board) target = { type: 'contract', ref: board };
  else if (own) target = { type: 'own', ref: own };
  else return null;

  if (target.type === 'contract') {
    extendContractBoard(store, airport, target.ref, minutes, false);
    return {
      title: 'Деструктивный пассажир',
      text: `На борту «${target.ref.airline}» буйный пассажир устроил скандал перед вылетом. Борт задержали на ${minutes} минуты, пока нарушителя снимали с рейса.`,
    };
  }

  // Свой борт: авиакомпания игрока терпит убыток на компенсациях.
  const size = target.ref.typeId; // small | medium | large
  const loss = AIRCRAFT_EVENTS.PASSENGER_OWN_LOSS[size] || AIRCRAFT_EVENTS.PASSENGER_OWN_LOSS.small;
  groundOwnPlane(store, target.ref, currentTick + minutes);
  const fresh = store.getAirportById(airport.id);
  store.updateAirport(airport.id, { money: fresh.money - loss });
  return {
    title: 'Деструктивный пассажир',
    text: `Дебошир на борту вашего ${typeName(target.ref)} устроил скандал, вылет задержали на ${minutes} минуты. Авиакомпания понесла убыток ${loss.toLocaleString('ru-RU')} у.е. на компенсациях и возвратах.`,
  };
}

// ==================== событие 6: столкновение с наземным транспортом ====================
function runCollision(store, airport, currentTick) {
  const minutes = AIRCRAFT_EVENTS.COLLISION_REPAIR_MINUTES;
  const board = rnd(contractPlanes(airport));
  const own = ownPlanes(store, airport.id);

  let target = null;
  if (board && own) target = Math.random() < 0.5 ? { type: 'contract', ref: board } : { type: 'own', ref: own };
  else if (board) target = { type: 'contract', ref: board };
  else if (own) target = { type: 'own', ref: own };
  else return null;

  const vehicle = rnd(GROUND_VEHICLES);
  if (target.type === 'contract') {
    extendContractBoard(store, airport, target.ref, minutes, true);
    return {
      title: 'Столкновение на перроне',
      text: `Самолёт «${target.ref.airline}» столкнулся с ${vehicle} на перроне. Стороны договорились о мировом соглашении — ремонт в ангаре займёт час и будет бесплатным.`,
    };
  }
  groundOwnPlane(store, target.ref, currentTick + minutes);
  return {
    title: 'Столкновение на перроне',
    text: `Ваш ${typeName(target.ref)} столкнулся с ${vehicle} на перроне. Стороны договорились о мировом соглашении — ремонт в ангаре займёт час и будет бесплатным.`,
  };
}

// ==================== событие 7: травма перронного работника ====================
function runInjury(store, airport) {
  const ins = AIRCRAFT_EVENTS.INJURY_INSURANCE;
  const fresh = store.getAirportById(airport.id);
  store.updateAirport(airport.id, { money: fresh.money - ins });
  return {
    title: 'Травма на перроне',
    text: `Перронный работник получил травму при обслуживании воздушного судна. Ему оказали первую помощь, а аэропорт выплатил страховку — ${ins.toLocaleString('ru-RU')} у.е.`,
  };
}

// ==================== розыгрыш ====================
// Разыграть одно событие для аэропорта. Возвращает новость { title, text }
// или null, если бить не по чему. Эффекты применяются сразу через store.
function roll(store, airport, currentTick) {
  const hasContract = contractPlanes(airport).length > 0;
  const hasOwn = ownPlanes(store, airport.id).length > 0;

  // Список доступных событий: без самолётов остаётся только травма (если есть
  // хоть какая-то инфраструктура). Без инфраструктуры не разыгрываем ничего.
  const pool = [];
  if (hasContract) pool.push('brake', 'flaps', 'fuel_leak', 'engine');
  if (hasContract || hasOwn) pool.push('passenger', 'collision');
  const hasInfra = store.getBuildingsByAirport(airport.id).length > 0;
  if (hasInfra) pool.push('injury');
  if (!pool.length) return null;

  const kind = rnd(pool);
  let result = null;
  if (kind === 'brake' || kind === 'flaps' || kind === 'fuel_leak' || kind === 'engine') {
    result = runRepair(store, airport, currentTick, kind);
  } else if (kind === 'passenger') {
    result = runPassenger(store, airport, currentTick);
  } else if (kind === 'collision') {
    result = runCollision(store, airport, currentTick);
  } else if (kind === 'injury') {
    result = runInjury(store, airport);
  }

  if (result && logNews) logNews(airport.id, result.title, result.text);
  return result;
}

module.exports = { roll, setNewsLogger };
