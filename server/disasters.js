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
  BUILDINGS, DISASTER_ECONOMY, DISASTER_KINDS, levelFromXp,
  buildingInvestedValue, lossCompensation, fireFine,
  AIRCRAFT_TYPES, aircraftSize,
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

// Здания, которые нельзя уничтожить целиком: без админздания аэропорт
// перестаёт работать, а игрок с пустым счётом не сможет его отстроить и
// застрянет. Повреждать его можно, сносить — нет.
const INDESTRUCTIBLE = ['admin'];

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

// Есть ли работающая пожарная часть — от неё зависит, потушат пожар или нет.
function hasFireStation(store, airportId) {
  return store.getBuildingsByAirport(airportId).some(b =>
    b.buildingId === 'fire_station' && !b.ruined
    && (b.state || 'owned') === 'owned' && b.constructionEndsTick == null);
}

// Пожар. Без пожарной части здание выгорает дотла и игрок платит по счёту;
// с пожарной частью огонь тушат, но повреждения случайные.
function runFire(store, airport, currentTick) {
  const cfg = DISASTER_ECONOMY.FIRE;
  const targets = damageableBuildings(store, airport.id);
  if (!targets.length) return null;

  const b = targets[Math.floor(Math.random() * targets.length)];
  const def = BUILDINGS[b.buildingId];
  const level = b.upgradeLevel || 1;
  // админздание горит, но не дотла — иначе аэропорт может встать намертво
  const protectedByStation = hasFireStation(store, airport.id) || INDESTRUCTIBLE.includes(b.buildingId);
  const details = [];
  let charge = 0;

  if (!protectedByStation) {
    // выгорело дотла: остались развалины, платим штраф и компенсацию
    store.updateBuildingAtCell(airport.id, b.cellIndex, { ruined: true, wear: 1 });
    charge = fireFine(def, level);
    details.push(`${def.name} выгорел дотла — пожарной части в аэропорту нет`);
    details.push(`Штраф и компенсация: ${charge.toLocaleString('ru-RU')} у.е.`);
  } else {
    // пожар потушен, но повреждения случайные
    const isApron = def.standSize || b.buildingId === 'helipad';
    const max = isApron ? cfg.APRON_DAMAGE_MAX : cfg.DAMAGE_MAX;
    const dmg = rnd(cfg.DAMAGE_MIN, max);
    if (!isApron && dmg > cfg.RUIN_THRESHOLD) {
      store.updateBuildingAtCell(airport.id, b.cellIndex, { ruined: true, wear: 1 });
      charge = lossCompensation(def, level);
      details.push(`${def.name}: выгорел на ${Math.round(dmg * 100)}% — восстановлению не подлежит`);
      details.push(`Компенсация: ${charge.toLocaleString('ru-RU')} у.е.`);
    } else {
      const r = addWear(store, airport.id, b, dmg);
      details.push(`${def.name}: пожар потушен, повреждение ${Math.round(r.before * 100)}% → ${Math.round(r.after * 100)}%`);
    }
  }

  // Борта, стоявшие на сгоревшей стоянке, гибнут вместе с ней.
  if ((def.standSize || b.buildingId === 'helipad') && !protectedByStation) {
    const lost = burnAircraftAt(store, airport, b, details);
    charge += lost.payout;   // за чужой сгоревший борт платит аэропорт: его вина
  }

  if (charge !== 0) {
    const fresh = store.getAirportById(airport.id);
    store.updateAirport(airport.id, { money: fresh.money - charge });
  }
  return { kind: 'fire', details };
}

// Гибель бортов на сгоревшей стоянке. Свой самолёт теряется безвозвратно,
// а за сгоревший договорной борт аэропорт возмещает авиакомпании четырёхкратную
// оплату за прилёт: борт сгорел на его территории и по его вине.
function burnAircraftAt(store, airport, building, details) {
  let payout = 0;
  const cfg = DISASTER_ECONOMY.FIRE;
  const fleet = store.getAircraftByAirport(airport.id)
    .filter(a => a.status !== 'flying' && !a.decommissioned);
  if (fleet.length && Math.random() < 0.5) {
    const ac = fleet[Math.floor(Math.random() * fleet.length)];
    const type = AIRCRAFT_TYPES[ac.typeId];
    store.updateAircraft(ac.id, { decommissioned: true, status: 'broken', auto: false });
    details.push(`${type ? type.name : 'Самолёт'} сгорел на стоянке и списан`);
  }
  const apron = (airport.apronBorts || []).filter(x => x.craft === 'plane');
  if (apron.length) {
    const bort = apron[Math.floor(Math.random() * apron.length)];
    payout = Math.round((bort.payPerArrival || 40) * cfg.CONTRACT_AIRCRAFT_PAYOUT);
    store.updateAirport(airport.id, {
      apronBorts: (airport.apronBorts || []).filter(x => x !== bort),
    });
    details.push(`Борт «${bort.airline}» сгорел на стоянке — аэропорт возместил компании ${payout.toLocaleString('ru-RU')} у.е.`);
  }
  return { payout };
}

// Прогноз метеорита: событие не бьёт сразу, а объявляется заранее. Повлиять
// на исход игрок не может — это стихия, — но хотя бы узнаёт о ней и понимает,
// откуда взялись убытки, когда вернётся в игру.
function forecastMeteor(store, airport, currentTick) {
  const cfg = DISASTER_ECONOMY.METEOR;
  const lead = Math.round(rnd(cfg.FORECAST_LEAD_MIN, cfg.FORECAST_LEAD_MAX));
  const big = Math.random() < cfg.BIG_CHANCE;
  store.updateAirport(airport.id, {
    meteorAtTick: currentTick + lead,
    meteorBig: big,
    lastDisasterTick: currentTick,   // прогноз тоже занимает защитный интервал
  });
  return {
    kind: 'meteor_forecast',
    lead,
    notify: big
      ? `☄️ Обсерватория предупреждает: к аэропорту приближается крупный метеорит. Расчётное время падения — через ${lead} мин.`
      : `☄️ Обсерватория предупреждает: через ${lead} мин ожидается метеоритный дождь.`,
  };
}

// Настало ли время объявленного метеорита.
function meteorDue(airport, currentTick) {
  return airport && airport.meteorAtTick != null && currentTick >= airport.meteorAtTick;
}

// Метеорит: либо один крупный (промах или снос здания), либо дождь мелких.
function runMeteor(store, airport, currentTick) {
  const cfg = DISASTER_ECONOMY.METEOR;
  const targets = damageableBuildings(store, airport.id);
  if (!targets.length) return null;
  const details = [];

  if (Math.random() < cfg.BIG_CHANCE) {
    if (Math.random() < cfg.BIG_MISS_CHANCE) {
      details.push('Крупный метеорит упал рядом с аэропортом — постройки не задеты');
      return { kind: 'meteor', details };
    }
    const destroyable = targets.filter(t => !INDESTRUCTIBLE.includes(t.buildingId));
    if (!destroyable.length) {
      details.push('Крупный метеорит упал на пустыре — постройки не задеты');
      return { kind: 'meteor', details };
    }
    const b = destroyable[Math.floor(Math.random() * destroyable.length)];
    const def = BUILDINGS[b.buildingId];
    const comp = lossCompensation(def, b.upgradeLevel || 1);
    store.removeBuildingAtCell(airport.id, b.cellIndex);
    const fresh = store.getAirportById(airport.id);
    store.updateAirport(airport.id, { money: fresh.money - comp });
    details.push(`Прямое попадание в объект «${def.name}» — здание уничтожено, клетка свободна`);
    details.push(`Компенсация: ${comp.toLocaleString('ru-RU')} у.е.`);
    return { kind: 'meteor', details };
  }

  const hit = pickShare(targets, cfg.SHOWER_SHARE_MIN, cfg.SHOWER_SHARE_MAX);
  for (const b of hit) {
    const def = BUILDINGS[b.buildingId];
    const r = addWear(store, airport.id, b, rnd(cfg.SHOWER_DAMAGE_MIN, cfg.SHOWER_DAMAGE_MAX));
    details.push(`${def.name}: повреждение ${Math.round(r.before * 100)}% → ${Math.round(r.after * 100)}%`);
  }
  if (!details.length) details.push('Мелкие метеориты выпали на пустыре — обошлось');
  return { kind: 'meteor', details };
}

// Птицы на взлёте. Лёгкое столкновение борт переживает, серьёзное отправляет
// его на ремонт. За договорной борт авиакомпания платит аэропорту.
function runBirds(store, airport, currentTick) {
  const cfg = DISASTER_ECONOMY.BIRDS;
  const details = [];
  const flying = store.getAircraftByAirport(airport.id)
    .filter(a => a.status === 'flying' && !a.decommissioned);
  const apron = (airport.apronBorts || []).filter(x => x.craft === 'plane');

  // предпочитаем свой борт в воздухе, иначе договорной на стоянке
  if (flying.length) {
    const ac = flying[Math.floor(Math.random() * flying.length)];
    const type = AIRCRAFT_TYPES[ac.typeId];
    if (Math.random() < cfg.MINOR_CHANCE) {
      details.push(`${type ? type.name : 'Борт'} столкнулся с птицами на взлёте — повреждения незначительные, рейс продолжается`);
    } else {
      const dmg = rnd(cfg.DAMAGE_MIN, cfg.DAMAGE_MAX);
      const newWear = Math.min(1, (ac.wear || 0) + dmg);
      store.updateAircraft(ac.id, {
        status: 'broken', wear: newWear, flightEndsTick: null, flightPax: null, auto: false,
      });
      details.push(`${type ? type.name : 'Борт'} принял стаю птиц в двигатель — экстренная посадка, износ ${Math.round(newWear * 100)}%`);
      details.push('Рейс прерван, борт нужно ремонтировать в ангаре');
    }
    return { kind: 'birds', details };
  }

  if (apron.length) {
    const bort = apron[Math.floor(Math.random() * apron.length)];
    if (Math.random() < cfg.MINOR_CHANCE) {
      details.push(`Борт «${bort.airline}» задел птиц на взлёте — обошлось, рейс продолжен`);
    } else {
      const payout = Math.round((bort.payPerArrival || 40) * cfg.CONTRACT_REPAIR_PAYOUT);
      const fresh = store.getAirportById(airport.id);
      store.updateAirport(airport.id, {
        money: fresh.money + payout,
        apronBorts: (fresh.apronBorts || []).map(x =>
          x === bort ? { ...x, departsTick: currentTick + 60, damaged: true } : x),
      });
      details.push(`Борт «${bort.airline}» вернулся после столкновения с птицами — ремонт в вашем ангаре`);
      details.push(`Авиакомпания оплатила ремонт: ${payout.toLocaleString('ru-RU')} у.е.`);
    }
    return { kind: 'birds', details };
  }

  return null;   // взлетать некому
}

const RUNNERS = {
  flood: runFlood, earthquake: runEarthquake, storm: runStorm,
  fire: runFire, meteor: runMeteor, birds: runBirds,
};

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

// Доступно ли происшествие такого вида на текущем уровне аэропорта.
function allowedAtLevel(kind, level) {
  const min = DISASTER_ECONOMY.DESTRUCTIVE_KINDS.includes(kind)
    ? DISASTER_ECONOMY.MIN_LEVEL.destructive
    : DISASTER_ECONOMY.MIN_LEVEL.mild;
  return level >= min;
}

// Случайный розыгрыш на каждом тике для одного аэропорта.
function rollRandom(store, airport, currentTick, settings) {
  if (settings && settings.disastersEnabled === false) return null;
  if (!DISASTER_ECONOMY.RANDOM_ENABLED) return null;

  const last = airport.lastDisasterTick || 0;
  if (currentTick - last < DISASTER_ECONOMY.GLOBAL_COOLDOWN_TICKS) return null;

  const level = levelFromXp(airport.xp || 0);
  for (const kind of DISASTER_KINDS) {
    if (!allowedAtLevel(kind, level)) continue;
    const mean = DISASTER_ECONOMY.MEAN_INTERVAL[kind];
    if (!mean) continue;
    if (Math.random() < 1 / mean) {
      // метеорит объявляется заранее, остальные события бьют сразу
      if (kind === 'meteor') return forecastMeteor(store, airport, currentTick);
      return trigger(store, airport, kind, currentTick);
    }
  }
  return null;
}

// Идёт ли сейчас магнитная буря.
function stormActive(airport, currentTick) {
  return airport && airport.stormEndsTick != null && currentTick < airport.stormEndsTick;
}

module.exports = {
  trigger, rollRandom, stormActive, forecastMeteor, meteorDue,
  allowedAtLevel, DISASTER_KINDS,
};
