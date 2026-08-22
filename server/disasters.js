// Чрезвычайные происшествия.
//
// Событие либо разыгрывается случайно (раз в несколько игровых суток), либо
// вызывается админом — руками или по расписанию. Итог один: аэропорт получает
// повреждения или временные помехи, а игроку показывается модальное окно
// «что случилось, пока вас не было».
//
// Заход 2 — только мягкие события: наводнение, землетрясение (повреждение) и
// магнитная буря. Разрушительные (метеорит, пожар, птицы) добавятся отдельно.

const {
  BUILDINGS, DISASTER_ECONOMY, DISASTER_KINDS,
} = require('./gameData');

function rnd(min, max) {
  return min + Math.random() * (max - min);
}

// Случайная выборка доли элементов из массива.
function pickShare(items, shareMin, shareMax) {
  if (!items.length) return [];
  const share = rnd(shareMin, shareMax);
  const count = Math.max(1, Math.round(items.length * share));
  const pool = [...items];
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Объекты, по которым может ударить событие: только свои, целые, не в работах.
function damageableBuildings(store, airportId, filterFn) {
  return store.getBuildingsByAirport(airportId).filter(b => {
    const def = BUILDINGS[b.buildingId];
    if (!def) return false;
    if (b.ruined) return false;
    if ((b.state || 'owned') !== 'owned') return false;       // аренду содержит бот
    if (b.constructionEndsTick != null) return false;          // стройка/апгрейд
    return filterFn ? filterFn(def, b) : true;
  });
}

function addWear(store, airportId, building, amount) {
  const before = building.wear || 0;
  const after = Math.min(1, before + amount);
  store.updateBuildingAtCell(airportId, building.cellIndex, { wear: after });
  return { before, after };
}

// ---------- сами события ----------

// Наводнение: заливает ВПП и стоянки, но не все сразу.
function runFlood(store, airport) {
  const cfg = DISASTER_ECONOMY.FLOOD;
  const targets = damageableBuildings(store, airport.id, (def) => def.isRunway || def.standSize);
  if (!targets.length) return null;

  const hit = pickShare(targets, cfg.SHARE_MIN, cfg.SHARE_MAX);
  const details = [];
  for (const b of hit) {
    const def = BUILDINGS[b.buildingId];
    let dmg = rnd(cfg.DAMAGE_MIN, cfg.DAMAGE_MAX);
    // грунтовую полосу размывает сильнее — она без твёрдого покрытия
    if (b.buildingId === 'runway_small') dmg = Math.min(0.9, dmg * cfg.SMALL_RUNWAY_EXTRA);
    const r = addWear(store, airport.id, b, dmg);
    details.push(`${def.name}: повреждение ${Math.round(r.before * 100)}% → ${Math.round(r.after * 100)}%`);
  }
  return { kind: 'flood', details };
}

// Землетрясение: трясёт любые здания. Разрушать пока не умеет — это заход 3.
function runEarthquake(store, airport) {
  const cfg = DISASTER_ECONOMY.EARTHQUAKE;
  const targets = damageableBuildings(store, airport.id);
  if (!targets.length) return null;

  const hit = pickShare(targets, cfg.SHARE_MIN, cfg.SHARE_MAX);
  const details = [];
  for (const b of hit) {
    const def = BUILDINGS[b.buildingId];
    const r = addWear(store, airport.id, b, rnd(cfg.DAMAGE_MIN, cfg.DAMAGE_MAX));
    details.push(`${def.name}: повреждение ${Math.round(r.before * 100)}% → ${Math.round(r.after * 100)}%`);
  }
  return { kind: 'earthquake', details };
}

// Магнитная буря: временные помехи, ничего не ломается.
function runStorm(store, airport, currentTick) {
  const cfg = DISASTER_ECONOMY.STORM;
  const duration = Math.round(rnd(cfg.DURATION_MIN, cfg.DURATION_MAX));
  store.updateAirport(airport.id, { stormEndsTick: currentTick + duration });
  return {
    kind: 'storm',
    details: [
      `Помехи продлятся ${duration} мин`,
      `Вышка пропускает втрое меньше бортов`,
      `ВПП принимают вдвое меньше`,
      `Вертолётные площадки работают как обычно`,
    ],
  };
}

const RUNNERS = { flood: runFlood, earthquake: runEarthquake, storm: runStorm };

// Запустить конкретное событие. Возвращает запись о происшествии или null,
// если бить оказалось не по чему.
function trigger(store, airport, kind, currentTick) {
  const runner = RUNNERS[kind];
  if (!runner) return null;
  const result = runner(store, airport, currentTick);
  if (!result) return null;

  // Складываем в очередь показа: игрок увидит окно при следующем заходе.
  const fresh = store.getAirportById(airport.id) || airport;
  const pending = Array.isArray(fresh.pendingDisasters) ? fresh.pendingDisasters.slice() : [];
  pending.push({ kind: result.kind, at: currentTick, details: result.details });
  store.updateAirport(airport.id, {
    pendingDisasters: pending.slice(-5),         // храним только последние
    lastDisasterTick: currentTick,
  });
  return result;
}

// Случайный розыгрыш на каждом тике для одного аэропорта.
function rollRandom(store, airport, currentTick, settings) {
  if (settings && settings.disastersEnabled === false) return null;
  if (!DISASTER_ECONOMY.RANDOM_ENABLED) return null;

  const last = airport.lastDisasterTick || 0;
  if (currentTick - last < DISASTER_ECONOMY.GLOBAL_COOLDOWN_TICKS) return null;

  for (const kind of DISASTER_KINDS) {
    const mean = DISASTER_ECONOMY.MEAN_INTERVAL[kind];
    if (!mean) continue;
    if (Math.random() < 1 / mean) {
      return trigger(store, airport, kind, currentTick);
    }
  }
  return null;
}

// Идёт ли сейчас магнитная буря.
function stormActive(airport, currentTick) {
  return airport && airport.stormEndsTick != null && currentTick < airport.stormEndsTick;
}

module.exports = { trigger, rollRandom, stormActive, DISASTER_KINDS };
