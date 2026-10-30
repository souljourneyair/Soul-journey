'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const game = require('../gameData');

const {
  CONFIG, CALENDAR, tickToClock, tickToDate,
  BUILDINGS, BUILD_LIMITS, XP_FOR_LEVEL, xpRequiredForLevel, levelFromXp,
  BOT_ECONOMY, BOT_COMPANY_NAMES, generateRentOffers, rentAcceptChance,
  UPGRADE_ECONOMY, upgradeCost, upgradeMultiplier, buildDurationTicks, upgradeDurationTicks,
  AIRCRAFT_TYPES, AIRCRAFT_ECONOMY, aircraftSlotsOf, buyoutPrice, resalePrice, repairCost,
  aircraftCapacity, decommissionThreshold, aircraftUpgradeCost,
  standAcceptsSizes, standServiceMinutes, standCapacity,
  RUNWAY_ECONOMY, runwayWearPerLanding, runwayRepairCost, runwayRepairTicks,
  DAMAGE_ECONOMY, damageMultiplier, damageRepairCost, damageRepairTicks, ruinedDemolishCost,
  ADMIN_ECONOMY, adminUpkeepDiscount, adminBuildSpeedMult, adminMaxOffers,
  BANK, bankRate, BUILDING_REPUTATION, buildingReputationFor,
  DISASTER_ECONOMY, buildingInvestedValue, lossCompensation, fireFine,
  CHAPTERS, chapterById, nextChapterId, POINTS, pointById,
  CONTRACT_ECONOMY, contractPayPerTick, contractPayPerArrival, contractDurationTicks,
  APRON_ECONOMY, CHARTER,
  FUEL_SUPPLIERS, FUEL_ECONOMY, fuelStorageCapacity, getFuelSupplier,
  fuelMarketMultiplier, MARKET_ECONOMY, marketStepPrice,
  TAX, PASSENGER_ECONOMY, terminalThroughput,
} = game;

test('calendar constants describe a consistent 30-day month and 12-month year', () => {
  assert.equal(CALENDAR.TICKS_PER_DAY, 12);
  assert.equal(CALENDAR.TICKS_PER_WEEK, 7 * CALENDAR.TICKS_PER_DAY);
  assert.equal(CALENDAR.TICKS_PER_MONTH, 30 * CALENDAR.TICKS_PER_DAY);
  assert.equal(CALENDAR.TICKS_PER_YEAR, 12 * CALENDAR.TICKS_PER_MONTH);
});

test('tickToClock wraps through the day and tickToDate advances month and year', () => {
  assert.equal(tickToClock(0), '00:00');
  assert.equal(tickToClock(1), '02:00');
  assert.equal(tickToClock(11), '22:00');
  assert.equal(tickToClock(12), '00:00');
  assert.equal(tickToClock(-1), '22:00');

  assert.deepEqual(tickToDate(0), { day: 1, month: 1, year: 1 });
  assert.deepEqual(tickToDate(12), { day: 2, month: 1, year: 1 });
  assert.deepEqual(tickToDate(CALENDAR.TICKS_PER_MONTH), { day: 1, month: 2, year: 1 });
  assert.deepEqual(tickToDate(CALENDAR.TICKS_PER_YEAR), { day: 1, month: 1, year: 2 });
});

test('XP thresholds are strictly increasing and cover every playable level', () => {
  assert.equal(XP_FOR_LEVEL.length, CONFIG.MAX_LEVEL + 1);
  assert.equal(XP_FOR_LEVEL[0], 0);
  for (let level = 1; level < XP_FOR_LEVEL.length; level++) {
    assert.ok(XP_FOR_LEVEL[level] > XP_FOR_LEVEL[level - 1],
      `XP threshold for level ${level} must exceed the previous level`);
    assert.equal(xpRequiredForLevel(level), XP_FOR_LEVEL[level]);
    assert.equal(levelFromXp(XP_FOR_LEVEL[level]), level);
    assert.equal(levelFromXp(XP_FOR_LEVEL[level] - 1), level - 1);
  }
  assert.equal(levelFromXp(XP_FOR_LEVEL.at(-1) + 1_000_000), CONFIG.MAX_LEVEL);
});

test('building catalog has unique matching IDs and finite economy values', () => {
  const ids = Object.keys(BUILDINGS);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);

  for (const [id, def] of Object.entries(BUILDINGS)) {
    assert.equal(def.id, id, `catalog key and ID must match for ${id}`);
    assert.ok(Number.isFinite(def.cost) && def.cost > 0, `${id} must have a positive finite cost`);
    assert.ok(Number.isFinite(def.income), `${id} must have finite income`);
    if (def.xp != null) assert.ok(Number.isFinite(def.xp) && def.xp >= 0, `${id} XP must be finite and non-negative`);
    if (def.maxUpgradeLevel != null) {
      assert.ok(Number.isInteger(def.maxUpgradeLevel) && def.maxUpgradeLevel >= 1,
        `${id} maxUpgradeLevel must be a positive integer`);
    }
  }
});

test('starter administration and hub prerequisites remain in the building catalog', () => {
  assert.equal(BUILDINGS.admin.starter, true);
  assert.equal(BUILDINGS.admin.unique, true);
  assert.equal(BUILDINGS.admin.removable, false);
  assert.equal(BUILDINGS.helipad.starter, true);
  for (const id of CONFIG.HUB_BUILDINGS) {
    assert.ok(BUILDINGS[id], `hub prerequisite ${id} must exist`);
  }
});

test('all configured building limits refer to known buildings and are positive integers', () => {
  for (const [id, limit] of Object.entries(BUILD_LIMITS)) {
    assert.ok(BUILDINGS[id], `limit references unknown building ${id}`);
    assert.ok(Number.isSafeInteger(limit) && limit > 0,
      `limit for ${id} must be a positive integer`);
  }
});

test('construction and upgrade costs follow the building-specific multiplier', () => {
  const standard = { id: 'test', cost: 10_000 };
  const discounted = { id: 'test-discounted', cost: 10_000, upgradeCostMult: 0.2 };

  assert.equal(upgradeCost(standard, 2), Math.round(10_000 * UPGRADE_ECONOMY.COST_MULTIPLIER * 2));
  assert.equal(upgradeCost(discounted, 3), Math.round(10_000 * 0.2 * 3));
  assert.ok(upgradeCost({ cost: 0 }, 2) > 0, 'fallback prevents zero-cost upgrades');
  assert.equal(upgradeMultiplier(1), 1);
  assert.equal(upgradeMultiplier(2), 1 + UPGRADE_ECONOMY.INCOME_BONUS_PER_LEVEL);
  assert.ok(upgradeMultiplier(5) > upgradeMultiplier(4));
});

test('construction and upgrade durations stay positive and later upgrades take longer', () => {
  const def = { cost: 20_000, buildTicks: 10 };
  assert.equal(buildDurationTicks(def), Math.max(1, Math.round(10 * CONFIG.BUILD_TIME_SCALE)));
  assert.ok(upgradeDurationTicks(def, 3) > upgradeDurationTicks(def, 2));
  assert.ok(buildDurationTicks({ cost: 0, buildTicks: 0 }) >= 1);
  for (const [id, building] of Object.entries(BUILDINGS)) {
    assert.ok(buildDurationTicks(building) >= 1, `${id} build duration must be positive`);
  }
});

test('administration upgrades improve discounts and never accelerate builds below the safety floor', () => {
  assert.equal(adminUpkeepDiscount(0), 0);
  assert.ok(adminUpkeepDiscount(5) >= adminUpkeepDiscount(1));
  assert.equal(adminBuildSpeedMult(0), 1);
  assert.ok(adminBuildSpeedMult(5) <= adminBuildSpeedMult(1));
  assert.ok(adminBuildSpeedMult(99) >= 0.5);
  assert.ok(adminMaxOffers(5) >= adminMaxOffers(1));
});

test('stand capacities and accepted aircraft sizes follow the progression rules', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(level => standCapacity('small', level)), [1, 2, 3, 4, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map(level => standCapacity('medium', level)), [2, 4, 6, 8, 10]);
  assert.deepEqual([1, 2, 3, 4, 5].map(level => standCapacity('large', level)), [2, 4, 6, 8, 10]);
  assert.equal(standCapacity('unknown', 3), 0);
  assert.deepEqual(standAcceptsSizes('small', 5), ['small']);
  assert.deepEqual(standAcceptsSizes('medium', 2), ['medium']);
  assert.deepEqual(standAcceptsSizes('medium', 3), ['medium', 'small']);
  assert.deepEqual(standAcceptsSizes('large', 3), ['large', 'medium', 'small']);
  assert.deepEqual(standAcceptsSizes('unknown', 3), []);
});

test('stand service time is non-increasing as stand level improves', () => {
  const minutes = [1, 2, 3, 4, 5].map(standServiceMinutes);
  for (let i = 1; i < minutes.length; i++) {
    assert.ok(minutes[i] <= minutes[i - 1]);
  }
  assert.ok(minutes.at(-1) < minutes[0]);
});

test('aircraft catalog has consistent upgrade capacity and costs', () => {
  assert.deepEqual(Object.keys(AIRCRAFT_TYPES).sort(), ['large', 'medium', 'small']);
  for (const [id, type] of Object.entries(AIRCRAFT_TYPES)) {
    assert.equal(type.id, id);
    assert.ok(Number.isFinite(type.buyCost) && type.buyCost > 0);
    assert.ok(Number.isFinite(type.leaseDeposit) && type.leaseDeposit > 0);
    assert.ok(type.leaseDeposit < type.buyCost);
    assert.equal(aircraftCapacity(type, 1), type.capacityByLevel[0]);
    assert.equal(aircraftCapacity(type, 99), type.capacityByLevel.at(-1));
    assert.ok(aircraftUpgradeCost(type, 2) > 0);
    assert.ok(decommissionThreshold(type) > type.buyCost);
  }
});

test('aircraft resale and buyout prices decrease with wear and respect the buyout floor', () => {
  const type = AIRCRAFT_TYPES.small;
  assert.equal(buyoutPrice(type, 0), type.buyCost);
  assert.equal(buyoutPrice(type, 1), Math.round(type.buyCost * AIRCRAFT_ECONOMY.BUYOUT_MIN_RATE));
  assert.equal(resalePrice(type, 0), Math.round(type.buyCost * AIRCRAFT_ECONOMY.RESALE_RATE));
  assert.ok(buyoutPrice(type, 0.5) < buyoutPrice(type, 0));
  assert.ok(resalePrice(type, 0.5) < resalePrice(type, 0));
  assert.equal(resalePrice(type, 1), 0);
});

test('aircraft repair cost never falls below its configured minimum', () => {
  const type = AIRCRAFT_TYPES.medium;
  assert.equal(repairCost(0, type.buyCost), AIRCRAFT_ECONOMY.REPAIR_FAST_MIN_COST);
  assert.ok(repairCost(0.5, type.buyCost) > repairCost(0.1, type.buyCost));
});

test('runway wear scales with aircraft size and inverse landing capacity', () => {
  const light = runwayWearPerLanding(100, 'small');
  const medium = runwayWearPerLanding(100, 'medium');
  const heavy = runwayWearPerLanding(100, 'large');
  assert.ok(light > 0);
  assert.ok(medium > light);
  assert.ok(heavy > medium);
  assert.ok(runwayWearPerLanding(200, 'small') < light);
  assert.equal(runwayWearPerLanding(0, 'small'), 0);
  assert.ok(Math.abs(light * 100 - RUNWAY_ECONOMY.FULL_LOAD_WEAR_PER_DAY
    * RUNWAY_ECONOMY.WEAR_BY_SIZE.small) < 1e-12);
});

test('runway repair cost and duration retain their minimums', () => {
  const runway = BUILDINGS.runway_small;
  assert.ok(runwayRepairCost(runway, 0) >= 500);
  assert.equal(runwayRepairTicks(0), 5);
  assert.ok(runwayRepairTicks(1) >= 5);
});

test('building damage reduces usefulness and repair never makes an object worse', () => {
  assert.equal(damageMultiplier(0), 1);
  assert.equal(damageMultiplier(0.5), 0.5);
  assert.equal(damageMultiplier(1), 0);
  assert.ok(damageMultiplier(0.2) > damageMultiplier(0.7));
  const repairingCap = DAMAGE_ECONOMY.REPAIR_CAPACITY_MULT;
  assert.equal(damageMultiplier(0.1, true), Math.min(0.9, repairingCap));
  assert.ok(Math.abs(damageMultiplier(0.9, true) - Math.min(0.1, repairingCap)) < 1e-12);
});

test('building repair costs and times rise with wear while preserving minimum charge', () => {
  const def = BUILDINGS.terminal_a;
  assert.ok(damageRepairCost(def, 0) >= 300);
  assert.ok(damageRepairCost(def, 0.6) > damageRepairCost(def, 0.2));
  assert.equal(damageRepairTicks(0), 5);
  assert.ok(damageRepairTicks(0.8) > damageRepairTicks(0.2));
  assert.ok(ruinedDemolishCost(def) > 0);
});

test('disaster compensation and fire fines include purchased upgrades only', () => {
  const def = BUILDINGS.terminal_a;
  const expected = def.cost + upgradeCost(def, 2) + upgradeCost(def, 3);
  assert.equal(buildingInvestedValue(def, 3), expected);
  assert.equal(buildingInvestedValue(def, 1), def.cost);
  assert.equal(lossCompensation(def, 3), Math.round(expected * DISASTER_ECONOMY.COMPENSATION_PCT));
  assert.equal(fireFine(def, 3),
    Math.round(expected * DISASTER_ECONOMY.FIRE.FINE_MULT)
      + Math.round(expected * DISASTER_ECONOMY.COMPENSATION_PCT));
});

test('building reputation falls with wear and reaches zero at total wear', () => {
  assert.equal(buildingReputationFor(0), BUILDING_REPUTATION.MAX_PER_PERIOD);
  assert.equal(buildingReputationFor(BUILDING_REPUTATION.FULL_UNTIL_WEAR),
    BUILDING_REPUTATION.MAX_PER_PERIOD);
  assert.ok(buildingReputationFor(0.5) < buildingReputationFor(0.2));
  assert.equal(buildingReputationFor(1), 0);
});

test('bank interest rate stays bounded and reacts to oil and gold in opposite directions', () => {
  const base = bankRate(BANK.OIL_BASE, BANK.GOLD_BASE);
  assert.ok(base >= BANK.MIN_RATE && base <= BANK.MAX_RATE);
  const oilUp = bankRate(BANK.OIL_BASE * 1.2, BANK.GOLD_BASE);
  const oilAndGoldUp = bankRate(BANK.OIL_BASE * 1.2, BANK.GOLD_BASE * 1.05);
  assert.ok(oilUp > base);
  assert.ok(oilAndGoldUp < oilUp, 'a higher gold price lowers the rate at a fixed oil price');
  assert.equal(bankRate(BANK.OIL_BASE, BANK.GOLD_BASE), BANK.MIN_RATE);
  assert.ok(bankRate(BANK.OIL_BASE * 100, BANK.GOLD_BASE) <= BANK.MAX_RATE);
});

test('fuel storage capacity follows level tiers and clamps out-of-range levels', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(fuelStorageCapacity),
    FUEL_ECONOMY.STORAGE_BY_LEVEL,
  );
  assert.equal(fuelStorageCapacity(0), FUEL_ECONOMY.STORAGE_BY_LEVEL[0]);
  assert.equal(fuelStorageCapacity(99), FUEL_ECONOMY.STORAGE_BY_LEVEL.at(-1));
});

test('fuel market multiplier is neutral inside its dead zone and bounded outside it', () => {
  const baselineOil = FUEL_ECONOMY.OIL_BASELINE;
  const baselineGold = FUEL_ECONOMY.GOLD_BASELINE;
  assert.equal(fuelMarketMultiplier(baselineOil, baselineGold), 1);
  assert.equal(fuelMarketMultiplier(baselineOil * 1.005, baselineGold), 1);
  const swing = FUEL_ECONOMY.MARKET_SWING;
  for (const oil of [0, baselineOil, baselineOil * 10]) {
    for (const gold of [0, baselineGold, baselineGold * 10]) {
      const mult = fuelMarketMultiplier(oil, gold);
      assert.ok(mult >= 1 - swing && mult <= 1 + swing);
    }
  }
  assert.ok(fuelMarketMultiplier(baselineOil * 1.2, baselineGold) > 1);
});

test('market price steps stay inside configured baseline bounds', () => {
  const base = 100;
  assert.ok(Math.abs(marketStepPrice(base, base, 0.1, 0.5, 2) - 110) < 1e-9);
  assert.equal(marketStepPrice(base, base, 10, 0.5, 2), 200);
  assert.ok(Math.abs(marketStepPrice(base, base, -10, 0.5, 2) - 50) < 1e-9);
});

test('fuel suppliers have unique IDs and can be looked up', () => {
  const ids = FUEL_SUPPLIERS.map(supplier => supplier.id);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  for (const supplier of FUEL_SUPPLIERS) {
    assert.equal(getFuelSupplier(supplier.id), supplier);
    assert.ok(Number.isFinite(supplier.pricePerUnit) && supplier.pricePerUnit > 0);
  }
  assert.equal(getFuelSupplier('__unknown__'), null);
});

test('terminal throughput rises predictably with upgrade level', () => {
  for (const terminalClass of ['terminal_a', 'terminal_b', 'terminal_c', 'terminal_d', 'terminal_e', 'terminal_f']) {
    const base = terminalThroughput(terminalClass, 1);
    assert.ok(base > 0, `missing throughput for class ${terminalClass}`);
    assert.equal(terminalThroughput(terminalClass, 2),
      Math.round(base * (1 + PASSENGER_ECONOMY.THROUGHPUT_PER_LEVEL)));
    assert.ok(terminalThroughput(terminalClass, 5) > base);
  }
  assert.equal(terminalThroughput('unknown', 1), 0);
});

test('rent offers are unique, sorted, and bounded by configured multipliers', () => {
  const base = 1_000;
  const offers = generateRentOffers(BUILDINGS.cafe, base);
  assert.equal(offers.length, Math.min(BOT_ECONOMY.RENT_OFFERS_COUNT, BOT_COMPANY_NAMES.length));
  assert.equal(new Set(offers.map(offer => offer.botName)).size, offers.length);
  for (const offer of offers) {
    assert.ok(offer.price >= Math.round(base * BOT_ECONOMY.RENT_OFFER_MIN_MULTIPLIER));
    assert.ok(offer.price <= Math.round(base * BOT_ECONOMY.RENT_OFFER_MAX_MULTIPLIER));
  }
  for (let i = 1; i < offers.length; i++) {
    assert.ok(offers[i - 1].price >= offers[i].price);
  }
});

test('rent acceptance chance is clamped and decreases as requested rent rises', () => {
  const def = BUILDINGS.cafe;
  const low = rentAcceptChance(100, def, 1_000);
  const high = rentAcceptChance(10_000, def, 1_000);
  assert.ok(low >= 0.05 && low <= 0.9);
  assert.ok(high >= 0.05 && high <= 0.9);
  assert.ok(low > high);
  assert.equal(rentAcceptChance(0, def, 1_000), 0.9);
  assert.equal(rentAcceptChance(1_000_000, def, 1_000), 0.05);
});

test('contract payment functions stay positive and inside configured random variance', () => {
  const rating = 4;
  const level = 10;
  const tickBase = CONTRACT_ECONOMY.BASE_PAY_PER_TICK
    + rating * CONTRACT_ECONOMY.PAY_PER_RATING
    + level * CONTRACT_ECONOMY.PAY_PER_LEVEL;
  const arrivalBase = CONTRACT_ECONOMY.BASE_PAY_PER_ARRIVAL
    + rating * CONTRACT_ECONOMY.ARRIVAL_PAY_PER_RATING
    + level * CONTRACT_ECONOMY.ARRIVAL_PAY_PER_LEVEL;
  const tickPay = contractPayPerTick(rating, level);
  const arrivalPay = contractPayPerArrival(rating, level);
  const variance = CONTRACT_ECONOMY.PAY_VARIANCE;

  assert.ok(tickPay >= Math.max(1, Math.round(tickBase * (1 - variance))));
  assert.ok(tickPay <= Math.max(1, Math.round(tickBase * (1 + variance))));
  assert.ok(arrivalPay >= Math.max(1, Math.round(arrivalBase * (1 - variance))));
  assert.ok(arrivalPay <= Math.max(1, Math.round(arrivalBase * (1 + variance))));
});

test('random contract duration is always a whole number of days in the configured range', () => {
  const duration = contractDurationTicks();
  assert.ok(duration >= CONTRACT_ECONOMY.MIN_DURATION_DAYS * CALENDAR.TICKS_PER_DAY);
  assert.ok(duration <= CONTRACT_ECONOMY.MAX_DURATION_DAYS * CALENDAR.TICKS_PER_DAY);
  assert.equal(duration % CALENDAR.TICKS_PER_DAY, 0);
});

test('charter options have positive seat counts and consistent per-seat pricing', () => {
  for (const seats of CHARTER.OPTIONS) {
    assert.ok(Number.isSafeInteger(seats) && seats > 0);
    assert.ok(seats * CHARTER.COST_PER_SEAT > 0);
  }
  for (const option of CHARTER.PLANE_OPTIONS) {
    assert.ok(['small', 'medium', 'large'].includes(option.size));
    assert.ok(Number.isSafeInteger(option.seats) && option.seats > 0);
  }
});

test('chapter and destination IDs are unique and lookup helpers are consistent', () => {
  const chapterIds = CHAPTERS.map(chapter => chapter.id);
  const pointIds = POINTS.map(point => point.id);
  assert.equal(new Set(chapterIds).size, chapterIds.length);
  assert.equal(new Set(pointIds).size, pointIds.length);

  for (let i = 0; i < CHAPTERS.length; i++) {
    assert.equal(chapterById(chapterIds[i]), CHAPTERS[i]);
    assert.equal(nextChapterId(chapterIds[i]), chapterIds[i + 1] ?? null);
  }
  for (const point of POINTS) {
    assert.equal(pointById(point.id), point);
    assert.ok(['heli', 'vvl', 'mvl'].includes(point.access));
  }
  assert.equal(pointById('__unknown__'), null);
});

test('tax and passenger economy constants remain within sensible bounds', () => {
  assert.ok(TAX.RATE > 0 && TAX.RATE < 1);
  assert.equal(TAX.PERIOD_TICKS, CALENDAR.TICKS_PER_WEEK);
  assert.ok(PASSENGER_ECONOMY.VISITOR_SPEND > 0);
  assert.ok(PASSENGER_ECONOMY.VISITORS_PER_XP > 0);
  assert.ok(Number.isFinite(APRON_ECONOMY.HELI_STAND_MINUTES));
});
