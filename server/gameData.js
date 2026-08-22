// Игровые данные: каталог зданий, требования уровней, конфиг мира.
// Упрощение MVP (Итерация 1): каждое здание занимает ровно 1 клетку
// (в дизайн-документе ВПП/терминалы многоклеточные — добавим в Итерации 2).

const CONFIG = {
  START_MONEY: 15000,
  START_GRID_SIZE: 4,      // 4x4 = 16 стартовых клеток
  MAX_GRID_SIZE: 8,        // максимум 8x8 = 64 клетки после всех покупок земли
  TICK_MS: 10 * 1000,      // 1 тик = 10 секунд реального времени (игровая минута)
  TARGET_LEVEL: 10,        // уровень, до которого меряем время в сингл-рейтинге
  AIRLINE_MIN_LEVEL: 5,    // с какого уровня можно создать свою авиакомпанию и покупать самолёты
  // Пассивный опыт за тик = XP_PER_TICK_BASE + уровень * XP_PER_TICK_PER_LEVEL.
  // Это вторая половина прогрессии (первая — XP за постройки): игрок получает
  // опыт и за время в игре, растущий с уровнем. Подобрано так, что активный
  // старт даёт ~3 уровень за первые игровые сутки (1440 тиков).
  XP_PER_TICK_BASE: 1,
  XP_PER_TICK_PER_LEVEL: 1,
  // Множитель длительности строительства/апгрейда. 1.0 = сроки из каталога
  // (buildTicks) как есть; меньше — быстрее (для отладки). Например 0.05 —
  // стройка в 20 раз быстрее. Вернуть в 1 для реального баланса времени.
  BUILD_TIME_SCALE: 0.05,
  // На сколько снижены доход/репутация здания, пока идёт его апгрейд (доля).
  // 0.5 = здание во время улучшения работает вполсилы. Позже проставим
  // индивидуальные значения из дизайн-документа (у админки -50%, вышки -80% и т.д.).
  UPGRADE_WORK_PENALTY: 0.5,
  // --- Содержание аэропорта (статья расхода в администрации) ---
  // Базовый расход в минуту = сумма по зданиям: UPKEEP_BASE + стоимость*UPKEEP_COST_RATE,
  // с учётом уровня апгрейда. Больше и круче аэропорт — дороже содержать.
  UPKEEP_BASE_PER_BUILDING: 2,      // фикс. часть за каждое здание
  UPKEEP_COST_RATE: 0.0015,          // доля от стоимости здания в минуту
  UPKEEP_UPGRADE_RATE: 0.3,          // +30% к содержанию за каждый уровень апгрейда
  // Простой: если аэропорт простаивает дольше этого (в минутах/тиках) — содержание растёт
  IDLE_MINUTES_BEFORE_PENALTY: 300,  // 5 игровых часов
  IDLE_UPKEEP_MULTIPLIER: 2.0,        // во сколько раз растёт содержание при долгом простое
};

// ---------- Экономика ботов-компаний (сингл-режим) ----------
// Боты — виртуальные игроки-компании. Здание (кроме несъёмных) можно
// продать боту (разовая выплата, потом можно выкупить обратно) или
// выставить на биржу аренды: либо принять готовое предложение бота, либо
// назначить свою цену и ждать, согласится ли кто-то из ботов.
const BOT_ECONOMY = {
  SELL_RATE: 0.6,              // при продаже боту игрок получает 60% от cost постройки
  DEMOLISH_REFUND_RATE: 0.3,   // при сносе возвращается 30% от cost постройки
  RENT_FAIR_MULTIPLIER: 1.8,   // "справедливая" аренда = income x1.8 — точка отсчёта для готовых предложений и вероятности принятия своей цены
  RENT_OFFER_MIN_MULTIPLIER: 1.3, // разброс готовых предложений ботов: от x1.3
  RENT_OFFER_MAX_MULTIPLIER: 2.2, //                                    до x2.2
  RENT_LISTING_MIN_MULTIPLIER: 0.5, // допустимый диапазон цены, которую может выставить сам игрок
  RENT_LISTING_MAX_MULTIPLIER: 4.0,
  RENT_OFFERS_COUNT: 3,          // сколько готовых предложений от ботов показываем на бирже
  LISTING_EXPIRE_CHANCE_PER_TICK: 0.4, // если бот не согласился в этот тик — шанс, что биржа "закроет" листинг и вернёт здание игроку
};

const BOT_COMPANY_NAMES = [
  'ОАО «Запредел»',
  'ЗАО «На пределе»',
  'ООО «Выше всех»',
  'ООО «Космос»',
  'ООО «Сатурн»',
];

function randomBotName() {
  return BOT_COMPANY_NAMES[Math.floor(Math.random() * BOT_COMPANY_NAMES.length)];
}

// Авиакомпании-боты, присылающие предложения о сотрудничестве (конверт).
const AIRLINE_BOT_NAMES = [
  'AeroNord', 'SkyBridge', 'Полярные Линии', 'ЮжВектор', 'Aurora Air',
  'ТрансКонтиненталь', 'Nimbus', 'Восток-Авиа', 'Meridian', 'Стриж',
  'CargoWings', 'Альтаир', 'BlueHorizon', 'Сапсан-Эйр', 'Zenith',
];

function randomAirlineName() {
  return AIRLINE_BOT_NAMES[Math.floor(Math.random() * AIRLINE_BOT_NAMES.length)];
}

// ==================== ТРАФИК ПАССАЖИРОВ (спрос) ====================
const TRAFFIC_ECONOMY = {
  // Генерация пассажиров/мин в пул = база_от_объектов + репутация*REP_K + уровень*LVL_K
  HELI_BASE_PER_PAD: 2,      // база на одну вертолётплощадку
  VVL_BASE_PER_TERMINAL: 3,  // база на один ВВЛ-терминал (× уровень апгрейда)
  MVL_BASE_PER_TERMINAL: 3,  // база на один МВЛ-терминал
  REP_K: 0.25,               // прибавка за единицу репутации (делится по активным пулам)
  LVL_K: 1.5,                // прибавка за уровень аэропорта
  POOL_CAP: 1200,            // потолок каждого пула (чтобы не копилось бесконечно)
  // Пропускная способность терминалов (пасс/мин) по классу, база на ур.1.
  // Итоговая = база × (1 + (уровень-1)*0.4).
  TERMINAL_THROUGHPUT: {
    A: 60, B: 120, D: 220,   // ВВЛ
    C: 100, E: 110, F: 200,  // МВЛ
  },
  TERMINAL_UPGRADE_RATE: 0.4, // +40% пропускной способности за уровень апгрейда
  // Зоны ожидания в очереди терминала (игровые минуты)
  WAIT_OK_MINUTES: 30,        // до 30 мин — норма
  WAIT_MAX_MINUTES: 120,      // свыше 2 ч — пассажир потерян
  // Штрафы
  UNHAPPY_REP_PER_PAX: 0.3,   // репутация за каждого пассажира в зоне 30мин-2ч
  UNHAPPY_TICKET_REFUND: 0.1, // компенсация 10% билета недовольному
  LOST_REP_PERCENT: 0.2,      // потеря 20% текущей репутации, если были потерянные (разово)
};

// Пропускная способность одного терминала с учётом апгрейда.
function terminalThroughput(terminalClass, upgradeLevel) {
  const base = TRAFFIC_ECONOMY.TERMINAL_THROUGHPUT[terminalClass] || 0;
  return Math.round(base * (1 + ((upgradeLevel || 1) - 1) * TRAFFIC_ECONOMY.TERMINAL_UPGRADE_RATE));
}

// ==================== ПАССАЖИРЫ: ТРАФИК И ТЕРМИНАЛЫ ====================
const PASSENGER_ECONOMY = {
  // Пропускная способность терминалов — базовые пасс/мин на ур.1, +40% за уровень апгрейда.
  TERMINAL_THROUGHPUT: {
    terminal_a: 60, terminal_b: 120, terminal_d: 220,   // ВВЛ
    terminal_c: 100, terminal_e: 110, terminal_f: 200,  // МВЛ
  },
  THROUGHPUT_PER_LEVEL: 0.4,  // +40% пропускной способности за уровень апгрейда

  // Генерация трафика (пассажиров в минуту в пул).
  HELIPAD_TRAFFIC_BASE: 2,    // за каждую вертолётплощадку
  VVL_TERMINAL_TRAFFIC_BASE: 3, // за каждый ВВЛ-терминал
  MVL_TERMINAL_TRAFFIC_BASE: 3, // за каждый МВЛ-терминал
  TRAFFIC_PER_REPUTATION: 0.25, // бонус за единицу репутации (делится по активным пулам)
  TRAFFIC_PER_LEVEL: 1.5,       // бонус за уровень аэропорта (делится по активным пулам)
  POOL_CAP: 1200,               // потолок накопления пула пассажиров

  // Очередь терминала: зоны ожидания (в игровых минутах) и штрафы.
  WAIT_OK_MINUTES: 30,          // до 30 мин — без штрафа
  WAIT_MAX_MINUTES: 120,        // >120 мин — пассажир потерян
  UNHAPPY_REP_PENALTY: 0.3,     // репутация за каждого недовольного (зона 30-120 мин)
  UNHAPPY_TICKET_REFUND: 0.1,   // компенсация 10% билета недовольному (вычет из выручки)
  LOST_REP_PENALTY_PCT: 0.2,    // потеря пассажиров → -20% от текущей репутации (разово за тик)
};

// Пропускная способность терминала с учётом апгрейда.
function terminalThroughput(buildingId, upgradeLevel) {
  const base = PASSENGER_ECONOMY.TERMINAL_THROUGHPUT[buildingId] || 0;
  return Math.round(base * (1 + ((upgradeLevel || 1) - 1) * PASSENGER_ECONOMY.THROUGHPUT_PER_LEVEL));
}

// ==================== ТОПЛИВО ====================
// Нефтяные компании-поставщики ГСМ (биржа при клике по топливному складу).
// У каждого своя цена за единицу топлива и надёжность (шанс задержки поставки).
const FUEL_SUPPLIERS = [
  { id: 'krov',   name: 'ООО «Кровь земли»',  pricePerUnit: 0.9,  note: 'Дёшево, но поставки нестабильны' },
  { id: 'neftgaz', name: 'ОАО «Нефть и газ»',  pricePerUnit: 1.1,  note: 'Надёжный крупный поставщик' },
  { id: 'poleteli', name: 'ЗАО «Полетели»',    pricePerUnit: 1.0,  note: 'Средняя цена, стабильно' },
  { id: 'dambenza', name: 'ИП «Дам бенза»',    pricePerUnit: 0.8,  note: 'Самое дешёвое топливо, мелкие партии' },
  { id: 'neftprod', name: 'АО «НефтьПродукт»', pricePerUnit: 1.25, note: 'Дорого, зато премиум-качество' },
];

const FUEL_ECONOMY = {
  // Вместимость склада по уровню апгрейда (единиц топлива).
  STORAGE_BY_LEVEL: [5000, 9000, 15000, 24000, 40000],
  // Доля расхода рейса, которую заправляют ДОМА (со склада, бесплатно, если есть запас).
  HOME_FUEL_SHARE: 0.5,
  // Наценка на топливо, купленное «на стороне» (дозаправка в Б или когда склад пуст).
  AWAY_PRICE_MULT: 1.0,
  // --- Рынок топлива (колебание цен) ---
  // Множитель цены = 1 + вклад_нефти + вклад_золота + шум, в пределах ±MARKET_SWING.
  OIL_WEIGHT: 0.6,        // вклад цены нефти (сильнее всего)
  GOLD_WEIGHT: 0.25,      // вклад цены золота (слабее)
  NOISE_WEIGHT: 0.05,     // случайный рыночный шум (небольшой, не перебивает сигнал)
  MARKET_SWING: 0.3,      // максимальное отклонение цены (±30%)
  OIL_BASELINE: 70,       // «нейтральная» цена нефти (при ней вклад = 0)
  GOLD_BASELINE: 2000,    // «нейтральная» цена золота
  OIL_SENSITIVITY: 0.012, // насколько сильно отклонение нефти от базы двигает цену
  GOLD_SENSITIVITY: 0.0003, // чувствительность к золоту
  MARKET_REPRICE_DAYS: 3, // раз в сколько игровых дней пересчитывать рыночный множитель
  // --- Контракт с поставщиком ---
  CONTRACT_MIN_LEVEL: 3,  // с какого уровня доступен контракт
  CONTRACT_AUTO_MIN_LEVEL: 6, // с какого уровня доступна кнопка «Авто»
  CONTRACT_DURATION_DAYS: 7,  // срок контракта (игровых дней)
  CONTRACT_DEFAULT_THRESHOLD: 25, // порог дозаправки по умолчанию (% вместимости)
};

// Рыночный множитель цены топлива из цен нефти/золота + шума.
// Возвращает число вокруг 1.0, ограниченное ±MARKET_SWING.
function fuelMarketMultiplier(oilPrice, goldPrice, noise) {
  const E = FUEL_ECONOMY;
  const oil = ((oilPrice != null ? oilPrice : E.OIL_BASELINE) - E.OIL_BASELINE) * E.OIL_SENSITIVITY;
  const gold = ((goldPrice != null ? goldPrice : E.GOLD_BASELINE) - E.GOLD_BASELINE) * E.GOLD_SENSITIVITY;
  const n = (noise != null ? noise : 0) * E.NOISE_WEIGHT;
  let mult = 1 + oil * E.OIL_WEIGHT + gold * E.GOLD_WEIGHT + n;
  const lo = 1 - E.MARKET_SWING, hi = 1 + E.MARKET_SWING;
  return Math.max(lo, Math.min(hi, mult));
}

// Вместимость топливного склада по уровню апгрейда.
function fuelStorageCapacity(upgradeLevel) {
  const arr = FUEL_ECONOMY.STORAGE_BY_LEVEL;
  return arr[Math.min(Math.max(1, upgradeLevel || 1), arr.length) - 1];
}

function getFuelSupplier(id) {
  return FUEL_SUPPLIERS.find(s => s.id === id) || null;
}

// ==================== ПРИЁМ БОРТОВ (пропускная способность, Слой 1) ====================
// ---------- Износ и ремонт ВПП ----------
const RUNWAY_ECONOMY = {
  // Износ считается долей от суточной квоты полосы, а не «столько-то за посадку».
  // Иначе прокачанная полоса изнашивалась бы быстрее: через неё идёт больше
  // бортов. При такой формуле любая полоса при полной загрузке стирается
  // одинаково — 4% за игровые сутки, то есть до порога 10% около 2-3 суток.
  FULL_LOAD_WEAR_PER_DAY: 0.04,
  // Тяжёлый борт бьёт полосу сильнее лёгкого.
  WEAR_BY_SIZE: { small: 0.8, medium: 1.0, large: 1.3 },
  // Полоса ветшает и без работы: 0.0005% в минуту = 0.72% за игровые сутки.
  AGING_PER_TICK: 0.000005,

  // Ниже порога ничего не происходит: полоса считается исправной.
  SAFE_WEAR: 0.10,
  // Шанс поломки борта при посадке = (износ - порог) x этот множитель.
  // При износе 100% выходит 5.4% на посадку, при 50% — 2.4%.
  BREAKDOWN_CHANCE_PER_WEAR: 0.06,
  // Потеря репутации за посадку на изношенную полосу = (износ - порог) x множитель.
  // При износе 50% выходит 100 очков за посадку, при 100% — 225.
  // Масштаб задан от прироста репутации застройкой (31-58 очков/мин, то есть
  // 45-84 тысячи за игровые сутки): при 20% износа потери едва заметны, при
  // 50% съедают пятую часть прироста, при 100% на загруженной полосе
  // перекрывают его целиком. Репутация влияет на пассажиропоток, плату по
  // договорам и частоту новых предложений, так что это бьёт и по деньгам.
  REPUTATION_HIT_PER_WEAR: 250,
  // Компенсация авиакомпании за повреждённый на посадке договорной борт,
  // кратно оплате за прилёт. Плюс борт застревает на стоянке.
  CONTRACT_DAMAGE_COMPENSATION: 3,
  CONTRACT_DAMAGE_STAND_MULT: 2,   // во столько раз дольше занимает стоянку
  CONTRACT_DAMAGE_REPUTATION_HIT: 200,  // сверх потери за саму посадку

  // Ремонт: доля от цены полосы, как у самолётов (REPAIR_PCT_OF_PRICE 0.4).
  REPAIR_PCT_OF_COST: 0.4,
  // Длительность ремонта: 200 минут при полном износе, пропорционально.
  REPAIR_TICKS_AT_FULL: 200,
  // Во время ремонта пропускная способность падает на 70%.
  REPAIR_CAPACITY_MULT: 0.3,
};

// Износ полосы за одну посадку борта размера size при суточной квоте capacity.
function runwayWearPerLanding(capacity, size) {
  if (!capacity || !isFinite(capacity)) return 0;
  const sizeMult = RUNWAY_ECONOMY.WEAR_BY_SIZE[size] || 1;
  return (RUNWAY_ECONOMY.FULL_LOAD_WEAR_PER_DAY / capacity) * sizeMult;
}

function runwayRepairCost(def, wear) {
  return Math.max(500, Math.round(def.cost * RUNWAY_ECONOMY.REPAIR_PCT_OF_COST * (wear || 0)));
}

function runwayRepairTicks(wear) {
  return Math.max(5, Math.round(RUNWAY_ECONOMY.REPAIR_TICKS_AT_FULL * (wear || 0)));
}

// ---------- Повреждения зданий (общая механика) ----------
// Одно поле wear на все здания: и медленное ветшание, и удары от ЧС.
// Смысл цифры везде одинаковый — полезность здания умножается на (1 - wear).
const DAMAGE_ECONOMY = {
  // Ветшание: 1.4% за игровые сутки. До первой пометки (10%) — около игровой
  // недели, до гаечного ключа (50%) — примерно пять недель. Осмотр зданий
  // становится делом на раз в несколько сессий, а не постоянной суетой.
  AGING_PER_TICK: 0.0000097,     // 1.4% / 1440 минут
  // Сданное в аренду здание не ветшает: его эксплуатирует и содержит бот.
  // Иначе аренда превращалась бы в ловушку «сдал, забыл, вернулся к развалинам».

  // Ниже этого повреждения ремонт не предлагается: ветшание идёт непрерывно,
  // и без порога у каждого здания сразу висела бы кнопка «починить за 300».
  MIN_REPAIRABLE_WEAR: 0.01,

  // Пороги сигналов игроку.
  NOTICE_WEAR: 0.10,   // мелкая пометка на иконке — вред уже начался
  WRENCH_WEAR: 0.50,   // гаечный ключ поверх иконки — чинить пора

  // Ремонт: та же формула, что у ВПП, чтобы игрок учил одно правило.
  REPAIR_PCT_OF_COST: 0.4,
  REPAIR_TICKS_AT_FULL: 200,
  // Во время ремонта здание работает на 30%. Но берём ХУДШЕЕ из двух, а не
  // произведение: сильно побитое здание во время ремонта не проседает ещё
  // сильнее. Иначе запуск ремонта делал бы игроку хуже, чем бездействие.
  REPAIR_CAPACITY_MULT: 0.3,

  // Снос разрушенного (сгорело/развалилось): игрок не получает возврата,
  // а платит четверть цены нового такого здания. Разрешаем уйти в минус,
  // иначе клетка запирается навсегда при пустом кошельке.
  DEMOLISH_RUINED_PCT: 0.25,

  // Кнопка «отремонтировать всё» открывается с этого уровня аэропорта.
  REPAIR_ALL_MIN_LEVEL: 7,
};

// Множитель полезности здания: доход, вместимость, пропускная способность.
// repairing — идёт ремонт (тогда не ниже REPAIR_CAPACITY_MULT, но и не хуже,
// чем уже было от повреждения).
function damageMultiplier(wear, repairing) {
  const fromWear = Math.max(0, 1 - (wear || 0));
  if (!repairing) return fromWear;
  return Math.min(fromWear, DAMAGE_ECONOMY.REPAIR_CAPACITY_MULT) === fromWear
    ? fromWear                                   // уже хуже — ремонт не ухудшает
    : DAMAGE_ECONOMY.REPAIR_CAPACITY_MULT;
}

function damageRepairCost(def, wear) {
  return Math.max(300, Math.round(def.cost * DAMAGE_ECONOMY.REPAIR_PCT_OF_COST * (wear || 0)));
}

function damageRepairTicks(wear) {
  return Math.max(5, Math.round(DAMAGE_ECONOMY.REPAIR_TICKS_AT_FULL * (wear || 0)));
}

function ruinedDemolishCost(def) {
  return Math.round(def.cost * DAMAGE_ECONOMY.DEMOLISH_RUINED_PCT);
}

const APRON_ECONOMY = {
  HELIPAD_SLOTS_PER_LEVEL: 1,     // мест на вертолётке = уровень апгрейда (ур.1=1 ... ур.5=5)
  // Сколько самолёт стоит на земле (занимает стоянку) — по уровню стоянки.
  // Апгрейд ускоряет обслуживание: ур.1 — 30 мин, ур.5 — 12 мин, то есть одна
  // стоянка пропускает в 2.5 раза больше бортов. Это единственный эффект
  // апгрейда стоянки помимо приёма меньших размеров с ур.3: дохода стоянки не
  // приносят, оплата за прилёт уже включает полное обслуживание борта.
  STAND_MINUTES_BY_LEVEL: [30, 25, 20, 16, 12],
  STAND_MINUTES: 30,              // ур.1, оставлено для совместимости
  HELI_STAND_MINUTES: 2,          // вертолёт стоит недолго — быстро освобождает площадку
  CONTRACT_ARRIVAL_INTERVAL: 30, // как часто борт по одному договору хочет прилететь (мин)
  ARRIVAL_INTERVAL_VARIANCE: 0.3, // разброс интервала прилётов ±30%
  MAX_WAIT_MINUTES: 20,           // сколько борт ждёт очереди, потом разворачивается
  TURNAWAY_PENALTY_MULT: 2,       // штраф за разворот = 2× оплаты за прилёт
  TURNAWAY_REPUTATION_HIT: 2,     // потеря репутации за развернувшийся борт
  // Интервал вышки (мин между операциями): без вышки и по уровням апгрейда
  TOWER_INTERVAL_NONE: 20,
  TOWER_INTERVAL_BY_LEVEL: [15, 12, 9, 6, 4], // ур.1..5
  // --- Договорные САМОЛЁТЫ (Этап 3) ---
  // Доля самолётных договоров среди новых предложений (когда есть стоянки+ВПП+терминал)
  PLANE_CONTRACT_SHARE: 0.5,
  // Множитель оплаты за прилёт по размеру самолёта (вертолёт = 1)
  PLANE_PAY_MULT: { small: 2, medium: 4, large: 7 },
  // Множитель оплаты для МВЛ-договоров (международные платят больше)
  MVL_CONTRACT_MULT: 1.6,
  // --- Билеты вылетающих пассажиров ---
  // Базовая цена билета (ВВЛ). МВЛ дороже (см. MVL_CONTRACT_MULT).
  TICKET_PRICE_VVL: 85,
  // Комиссия аэропорта с билетов, когда пассажиров увозит ДОГОВОРНОЙ борт (чужой).
  // Свой самолёт даёт 100% выручки, договорной — только эту долю.
  CONTRACT_COMMISSION: 0.2,
  // Насколько рынок топлива (нефть/золото) влияет на цены билетов и договоров.
  // 0 = не влияет, 1 = как на топливо. 0.5 = вдвое мягче (билеты скачут меньше).
  MARKET_INFLUENCE_ON_PRICES: 0.5,
  // Торги по договорам: доля уступки бота от разницы (игрок хочет больше).
  // Z = X + (Y-X)×это. Меньше = бот жаднее (уступает мало).
  HAGGLE_GREED: 0.35,
  // Максимальная надбавка игрока к исходной цене, которую бот вообще рассмотрит.
  // Если игрок просит больше X×(1+это) — бот сразу отказывается (наглость).
  HAGGLE_MAX_OVERASK: 0.6,
  // --- Заправка чужих (договорных) бортов ---
  // Расход топлива за прилёт по размеру борта (заправка на один вылет).
  CONTRACT_FUEL_USE: { heli: 20, small: 60, medium: 150, large: 260 },
  // Если на складе не хватает — экстренная докупка на стороне с наценкой:
  CONTRACT_FUEL_EMERGENCY_MULT: 1.5, // множитель цены недостающего топлива
  CONTRACT_FUEL_NO_STOCK_REP: 5,     // штраф репутации за борт, который не смогли заправить
};

// ==================== ДОГОВОРЫ С АВИАКОМПАНИЯМИ (конверт) ====================
const CONTRACT_ECONOMY = {
  // Базовая оплата договора в минуту (заглушка — позже "за прилёт").
  // Итоговая сумма растёт с репутацией и уровнем аэропорта.
  BASE_PAY_PER_TICK: 8,
  PAY_PER_REPUTATION: 0.02,   // +0.02/мин за единицу репутации
  PAY_PER_LEVEL: 3,            // +3/мин за уровень аэропорта
  PAY_VARIANCE: 0.3,           // разброс ±30% между предложениями
  // Оплата ЗА ПРИЛЁТ борта (Слой 1): договор платит при каждом прилёте, а не в минуту.
  BASE_PAY_PER_ARRIVAL: 70,       // базовая оплата за один прилёт
  ARRIVAL_PAY_PER_REPUTATION: 0.15, // +0.15 за единицу репутации
  ARRIVAL_PAY_PER_LEVEL: 12,       // +12 за уровень аэропорта
  // Срок договора — случайно в этом диапазоне (в игровых сутках = 1440 минут)
  MIN_DURATION_DAYS: 3,
  MAX_DURATION_DAYS: 7,
  // Сколько предложений висит в конверте одновременно
  MAX_OFFERS: 4,
  // Шанс появления нового предложения за минуту (если есть место в конверте).
  // Растёт с числом площадок/стоянок (крупнее аэропорт — больше желающих) и репутацией.
  OFFER_CHANCE_BASE: 0.05,
  OFFER_CHANCE_PER_PAD: 0.02,    // за каждую вертолётплощадку
  OFFER_CHANCE_PER_STAND: 0.015, // за каждую стоянку ВС
  OFFER_CHANCE_PER_REPUTATION: 0.0002,
  OFFER_CHANCE_MAX: 0.5,         // потолок шанса за минуту
  // "Подумаю": сколько минут предложение ждёт, если отложили, потом истекает
  THINKING_EXPIRE_MINUTES: 120,
  // Обычное предложение (не отложенное) тоже живёт ограниченное время
  OFFER_EXPIRE_MINUTES: 240,
};

// Рассчитать оплату предложения с учётом репутации и уровня аэропорта.
function contractPayPerTick(reputation, level) {
  const base = CONTRACT_ECONOMY.BASE_PAY_PER_TICK
    + reputation * CONTRACT_ECONOMY.PAY_PER_REPUTATION
    + level * CONTRACT_ECONOMY.PAY_PER_LEVEL;
  const variance = 1 + (Math.random() * 2 - 1) * CONTRACT_ECONOMY.PAY_VARIANCE;
  return Math.max(1, Math.round(base * variance));
}

// Оплата за один прилёт борта по договору (Слой 1) — с учётом репутации/уровня.
function contractPayPerArrival(reputation, level) {
  const base = CONTRACT_ECONOMY.BASE_PAY_PER_ARRIVAL
    + reputation * CONTRACT_ECONOMY.ARRIVAL_PAY_PER_REPUTATION
    + level * CONTRACT_ECONOMY.ARRIVAL_PAY_PER_LEVEL;
  const variance = 1 + (Math.random() * 2 - 1) * CONTRACT_ECONOMY.PAY_VARIANCE;
  return Math.max(1, Math.round(base * variance));
}

// Срок нового договора в минутах (тиках).
function contractDurationTicks() {
  const days = CONTRACT_ECONOMY.MIN_DURATION_DAYS
    + Math.floor(Math.random() * (CONTRACT_ECONOMY.MAX_DURATION_DAYS - CONTRACT_ECONOMY.MIN_DURATION_DAYS + 1));
  return days * 1440;
}

function randomBotNames(count) {
  const pool = [...BOT_COMPANY_NAMES];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// Готовые предложения ботов по аренде для конкретного здания — генерируются
// заново при каждом открытии биржи (цены каждый раз немного разные).
function generateRentOffers(def, effectiveIncome) {
  const base = effectiveIncome || def.income;
  const names = randomBotNames(Math.min(BOT_ECONOMY.RENT_OFFERS_COUNT, BOT_COMPANY_NAMES.length));
  return names.map(botName => {
    const mult = BOT_ECONOMY.RENT_OFFER_MIN_MULTIPLIER +
      Math.random() * (BOT_ECONOMY.RENT_OFFER_MAX_MULTIPLIER - BOT_ECONOMY.RENT_OFFER_MIN_MULTIPLIER);
    return { botName, price: Math.round(base * mult) };
  }).sort((a, b) => b.price - a.price);
}

// Вероятность, что боты согласятся на цену, которую выставил сам игрок —
// чем выше цена относительно "справедливой", тем ниже шанс.
function rentAcceptChance(askPrice, def, effectiveIncome) {
  const base = effectiveIncome || def.income;
  const fairPrice = base * BOT_ECONOMY.RENT_FAIR_MULTIPLIER;
  const ratio = askPrice / fairPrice;
  return Math.max(0.05, Math.min(0.9, 1.6 - ratio * 0.9));
}

// Стоимость расширения территории (каждая покупка добавляет "кольцо" клеток
// вокруг стартового участка, пока не дойдём до MAX_GRID_SIZE)
const LAND_EXPANSION = [
  { cost: 8000, minLevel: 3 },
  { cost: 20000, minLevel: 4 },
  { cost: 45000, minLevel: 6 },
];

// Кумулятивный XP, необходимый для достижения уровня N (индекс = уровень)
// Индекс массива = уровень аэропорта. Новый игрок стартует на уровне 0 без
// зданий; постройка админздания (+150 XP) и вертолётки (+150 XP) даёт 300 XP —
// ровно порог уровня 1. Дальше пороги как раньше.
const XP_FOR_LEVEL = [
  0,      // ур.0 - старт (0 XP, зданий нет)
  300,    // ур.1 - после админки + вертолётки
  1500,   // ур.2
  4000,   // ур.3
  9000,   // ур.4
  18000,  // ур.5
  32000,  // ур.6
  52000,  // ур.7
  80000,  // ур.8
  120000, // ур.9
  170000, // ур.10
];

// ---------- Апгрейды зданий (уровни I/II/III...) ----------
// Каждое здание можно улучшать до своего maxUpgradeLevel независимо от
// уровня аэропорта. Апгрейд поднимает доход и репутацию постройки и не
// меняет её тип/иконку автоматически — иконку под конкретный (тип, уровень)
// назначает админ через Галерею (см. buildingSkins в store.js), одна и та
// же для всех игроков.
const UPGRADE_ECONOMY = {
  COST_MULTIPLIER: 0.6,        // апгрейд до уровня N стоит cost * 0.6 * N
  INCOME_BONUS_PER_LEVEL: 0.3,  // каждый уровень выше 1-го добавляет +30% дохода
  REPUTATION_BONUS_PER_LEVEL: 0.3, // и +30% к репутации/тик (если она есть у здания)
};

function upgradeCost(def, targetLevel) {
  // Здание может задать свой множитель (upgradeCostMult). У стоянок он ниже
  // общего: апгрейд не даёт им дохода, только скорость обслуживания, и по
  // общей формуле оказался бы заведомо невыгоднее постройки новой стоянки.
  const mult = def.upgradeCostMult != null ? def.upgradeCostMult : UPGRADE_ECONOMY.COST_MULTIPLIER;
  return Math.round(def.cost * mult * targetLevel) || Math.round(1000 * mult * targetLevel);
}

// Время обслуживания самолёта на стоянке (игровых минут) по уровню стоянки.
function standServiceMinutes(upgradeLevel) {
  const arr = APRON_ECONOMY.STAND_MINUTES_BY_LEVEL;
  const idx = Math.min(Math.max((upgradeLevel || 1) - 1, 0), arr.length - 1);
  return arr[idx];
}

function upgradeMultiplier(upgradeLevel) {
  return 1 + (upgradeLevel - 1) * UPGRADE_ECONOMY.INCOME_BONUS_PER_LEVEL;
}

// Длительность строительства здания в тиках (с учётом ускорения BUILD_TIME_SCALE).
// Если у здания задано поле buildTicks — берём его; иначе выводим из цены
// (дороже здание — дольше строится). Минимум 1 тик.
function buildDurationTicks(def) {
  const base = def.buildTicks != null ? def.buildTicks : Math.round(10 + (def.cost || 0) / 500);
  return Math.max(1, Math.round(base * CONFIG.BUILD_TIME_SCALE));
}

// Длительность апгрейда до targetLevel в тиках. Каждый следующий уровень
// дольше предыдущего. Тоже с учётом ускорения.
function upgradeDurationTicks(def, targetLevel) {
  const base = def.buildTicks != null ? def.buildTicks : Math.round(10 + (def.cost || 0) / 500);
  const scaled = base * (0.5 + targetLevel * 0.5); // ур.2 ×1.5, ур.3 ×2.0 и т.д.
  return Math.max(1, Math.round(scaled * CONFIG.BUILD_TIME_SCALE));
}

// Каталог построек. income — доход за тик. xp — сколько опыта даёт постройка
// (единоразово, в момент покупки). minLevel — с какого уровня доступно.
// maxUpgradeLevel — до какого уровня апгрейда можно прокачать конкретный
// экземпляр здания (админ и вертолётная стоянка — 5, всё остальное — 3).
const BUILDINGS = {
  admin: {
    id: 'admin', name: 'Здание администрации', minLevel: 0,
    cost: 3000, income: 15, reputation: 1, xp: 500, removable: false, maxUpgradeLevel: 5,
    starter: true, unique: true,
    desc: 'Штаб аэропорта. Приносит доход и репутацию, можно улучшать. Обязательная первая постройка в единственном экземпляре, снести нельзя.',
  },
  helipad: {
    id: 'helipad', name: 'Вертолётная стоянка', minLevel: 0,
    cost: 2500, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, nonRentable: true, reputation: 0, xp: 300, removable: true, maxUpgradeLevel: 5,
    starter: true,
    desc: 'Источник дохода — мелкие вертолётные чартеры. Обычное здание: можно строить, улучшать, сдавать, продавать и сносить.',
  },
  tower: {
    id: 'tower', name: 'Диспетчерская вышка', minLevel: 2,
    cost: 8000, income: 40, reputation: 0, xp: 1200, removable: true, maxUpgradeLevel: 5,
    desc: 'Задаёт интервал между операциями на каждой ВПП: без вышки 20 мин, ур.1 — 15, ур.2 — 12, ур.3 — 9, ур.4 — 6, ур.5 — 4 мин. Интервал действует на каждую полосу отдельно, поэтому вторая и третья ВПП добавляют пропускной способности. Несколько вышек делят интервал между собой. Обязательна для полётов своих самолётов.',
  },
  runway_small: {
    id: 'runway_small', name: 'Малая ВПП', minLevel: 3,
    cost: 12000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, reputation: 0, xp: 1600, removable: true, maxUpgradeLevel: 5,
    isRunway: true, lineType: 'vvl',
    upgradeCostMult: 0.2,
    accepts: ['small'],                              // только малые самолёты
    landingsPerDay: [40, 64, 112, 208, 320],         // посадок за игровые сутки по уровню
    surfaceByLevel: [
      'Грунтовая полоса, ничем не оснащена',
      'Гравийная полоса, ничем не оснащена',
      'Бетон, оснащена рулёжными огнями',
      'Асфальт, оснащена глиссадой и огнями PAPI',
      'Самое современное покрытие, оснащена по последнему слову техники',
    ],
    desc: 'Принимает только малые самолёты внутренних авиалиний (ВВЛ). Апгрейд повышает пропускную способность: 40 посадок за игровые сутки на ур.1, 320 на ур.5.',
  },
  terminal_a: {
    id: 'terminal_a', name: 'Терминал A', minLevel: 3,
    cost: 15000, income: 75, reputation: 1, xp: 1900, removable: true, maxUpgradeLevel: 5,
    lineType: 'vvl', terminalClass: 'A',
    desc: 'Пассажирский терминал внутренних авиалиний (ВВЛ). Увеличивает приём пассажиров.',
  },
  fuel_depot: {
    id: 'fuel_depot', name: 'Топливный склад', minLevel: 3,
    cost: 10000, income: 0, reputation: 0, xp: 1400, removable: true, maxUpgradeLevel: 5,
    desc: 'Компания-поставщик авиатоплива. Прямого дохода не приносит, но даёт дешёвую домашнюю заправку. Можно выбрать поставщика.',
  },
  airline_office: {
    id: 'airline_office', name: 'Офис авиакомпании', minLevel: 5,
    cost: 12000, income: 20, reputation: 1, xp: 2200, removable: true, maxUpgradeLevel: 3,
    unique: true,               // только один офис на аэропорт
    requiresAirline: true,      // доступен в каталоге только после создания АК
    rentable: false,            // нельзя сдавать в аренду / продавать — только снести
    officeIncomeWithoutAircraft: -60, // убыток в минуту, пока нет самолётов
    desc: 'Штаб вашей авиакомпании. Открывает покупку и лизинг самолётов. Пока нет ни одного самолёта — приносит убыток. Нельзя сдать или продать, только снести (все самолёты при этом продаются).',
  },
  stand_small: {
    id: 'stand_small', name: 'Малая стоянка ВС', minLevel: 4,
    cost: 5000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, nonRentable: true, reputation: 0, xp: 700, removable: true, maxUpgradeLevel: 5,
    upgradeCostMult: 0.2, standSize: 'small',   // вмещает маленькие самолёты
    aircraftSlots: 1,
    desc: 'Стоянка для маленького самолёта. Вмещает один борт. Апгрейд ускоряет обслуживание: ур.1 — 30 мин, ур.5 — 12 мин, то есть вдвое с половиной больше прилётов через ту же стоянку.',
  },
  stand_medium: {
    id: 'stand_medium', name: 'Средняя стоянка ВС', minLevel: 6,
    cost: 14000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, nonRentable: true, reputation: 0, xp: 1700, removable: true, maxUpgradeLevel: 5,
    upgradeCostMult: 0.2, standSize: 'medium',  // вмещает средние; с ур.3 — ещё и маленькие
    aircraftSlots: 1,
    desc: 'Стоянка для среднего (узкофюзеляжного) самолёта. Вмещает один борт. Апгрейд ускоряет обслуживание: ур.1 — 30 мин, ур.5 — 12 мин. С ур.3 вмещает также маленькие самолёты.',
  },
  stand_large: {
    id: 'stand_large', name: 'Большая стоянка ВС', minLevel: 8,
    cost: 32000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, nonRentable: true, reputation: 0, xp: 3600, removable: true, maxUpgradeLevel: 5,
    upgradeCostMult: 0.2, standSize: 'large',   // вмещает большие; с ур.3 — ещё средние и маленькие
    aircraftSlots: 1,
    desc: 'Стоянка для большого (широкофюзеляжного) самолёта. Вмещает один борт. Апгрейд ускоряет обслуживание: ур.1 — 30 мин, ур.5 — 12 мин. С ур.3 вмещает также средние и маленькие самолёты.',
  },
  hangar: {
    id: 'hangar', name: 'Ангар', minLevel: 4,
    cost: 8000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, reputation: 0, xp: 900, removable: true, maxUpgradeLevel: 4,
    aircraftSlots: 1, // базово 1 место, +1 за каждый уровень апгрейда (ур.1→1 ... ур.4→4)
    aircraftSlotsPerLevel: true,
    desc: 'Хранит и обслуживает самолёты: 1 место на 1 уровне, до 4 на максимальном.',
  },
  runway_full: {
    id: 'runway_full', name: 'Средняя ВПП', minLevel: 5,
    cost: 45000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, reputation: 0, xp: 4600, removable: true, maxUpgradeLevel: 5,
    isRunway: true, lineType: 'both',
    upgradeCostMult: 0.2,
    accepts: ['small', 'medium'],
    landingsPerDay: [80, 128, 224, 448, 560],
    surfaceByLevel: [
      'Бетон, оснащена рулёжными огнями',
      'Бетон на гравийной подушке, оснащена рулёжными огнями',
      'Асфальт, оснащена рулёжными и осевыми огнями',
      'Многослойная ВПП, оснащена глиссадой и огнями PAPI',
      'Самое современное покрытие, оснащена по последнему слову техники',
    ],
    desc: 'Принимает малые и средние самолёты внутренних и международных авиалиний (ВВЛ+МВЛ). Апгрейд повышает пропускную способность: 80 посадок за игровые сутки на ур.1, 560 на ур.5.',
  },
  cargo_terminal: {
    id: 'cargo_terminal', name: 'Грузовой терминал', minLevel: 5,
    cost: 16000, income: 90, reputation: 0, xp: 2600, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Грузовые рейсы — отдельный поток дохода.',
  },
  fire_station: {
    id: 'fire_station', name: 'Пожарная часть', minLevel: 5,
    cost: 7000, income: 8, reputation: 2, xp: 800, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Требуется для сертификации крупных ВПП.',
  },
  terminal_b: {
    id: 'terminal_b', name: 'Терминал B', minLevel: 5,
    cost: 35000, income: 150, reputation: 2, xp: 3800, removable: true, maxUpgradeLevel: 5,
    lineType: 'vvl', terminalClass: 'B',
    desc: 'Пассажирский терминал внутренних авиалиний (ВВЛ). Больше пассажиров, чем терминал A.',
  },
  cafe: {
    id: 'cafe', name: 'Кафе / дьюти-фри', minLevel: 6,
    cost: 6000, income: 35, reputation: 3, xp: 700, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Доп. доход с пассажиропотока, растит репутацию.',
  },
  hotel: {
    id: 'hotel', name: 'Гостиница', minLevel: 6,
    cost: 15000, income: 65, reputation: 4, xp: 1900, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Пассивный доход и репутация.',
  },
  runway_big: {
    id: 'runway_big', name: 'Большая ВПП', minLevel: 8,
    cost: 90000, income: 0,  // инфраструктура: доход от работы, не пассивный
    infrastructure: true, reputation: 0, xp: 8000, removable: true, maxUpgradeLevel: 5,
    isRunway: true, lineType: 'both',
    upgradeCostMult: 0.2,
    accepts: ['small', 'medium', 'large'],
    landingsPerDay: [160, 240, 360, 520, 760],
    surfaceByLevel: [
      'Бетон, оснащена рулёжными огнями',
      'Бетон на гравийной подушке, оснащена рулёжными огнями',
      'Асфальт, оснащена рулёжными и осевыми огнями',
      'Многослойная ВПП, оснащена глиссадой и огнями PAPI',
      'Самое современное покрытие, оснащена по последнему слову техники',
    ],
    desc: 'Принимает малые, средние и большие самолёты внутренних и международных авиалиний (ВВЛ+МВЛ). Апгрейд повышает пропускную способность: 160 посадок за игровые сутки на ур.1, 760 на ур.5.',
  },
  vip_lounge: {
    id: 'vip_lounge', name: 'VIP-зал', minLevel: 7,
    cost: 18000, income: 80, reputation: 4, xp: 2400, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Премиум-сборы, репутация.',
  },
  terminal_d: {
    id: 'terminal_d', name: 'Терминал D', minLevel: 7,
    cost: 70000, income: 270, reputation: 3, xp: 6800, removable: true, maxUpgradeLevel: 5,
    lineType: 'vvl', terminalClass: 'D',
    desc: 'Крупнейший пассажирский терминал внутренних авиалиний (ВВЛ).',
  },
  terminal_c: {
    id: 'terminal_c', name: 'Терминал C', minLevel: 5,
    cost: 40000, income: 170, reputation: 2, xp: 4200, removable: true, maxUpgradeLevel: 5,
    lineType: 'mvl', terminalClass: 'C',
    desc: 'Пассажирский терминал международных авиалиний (МВЛ). Обслуживает зарубежные рейсы.',
  },
  terminal_e: {
    id: 'terminal_e', name: 'Терминал E', minLevel: 5,
    cost: 42000, income: 175, reputation: 2, xp: 4400, removable: true, maxUpgradeLevel: 5,
    lineType: 'mvl', terminalClass: 'E',
    desc: 'Пассажирский терминал международных авиалиний (МВЛ). Обслуживает зарубежные рейсы.',
  },
  terminal_f: {
    id: 'terminal_f', name: 'Терминал F', minLevel: 8,
    cost: 95000, income: 350, reputation: 3, xp: 8400, removable: true, maxUpgradeLevel: 5,
    lineType: 'mvl', terminalClass: 'F',
    desc: 'Крупный пассажирский терминал международных авиалиний (МВЛ). Больше пассажиров, чем терминал E.',
  },
  conference_center: {
    id: 'conference_center', name: 'Конференц-центр', minLevel: 8,
    cost: 25000, income: 100, reputation: 3, xp: 3400, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Бизнес-доход, репутация для хаб-статуса.',
  },
  cargo_hub: {
    id: 'cargo_hub', name: 'Грузовой хаб', minLevel: 9,
    cost: 40000, income: 210, reputation: 0, xp: 5800, removable: true, maxUpgradeLevel: 3,
    hidden: true,
    desc: 'Автоматизация багажа и крупный грузовой поток.',
  },
};

// Максимальное количество зданий каждого типа на один аэропорт.
// Здания, не указанные здесь, не имеют лимита (кроме unique — тех всегда по 1).
// Это ДОБАВЛЕНИЕ поверх параметров зданий — существующую экономику не меняет.
const BUILD_LIMITS = {
  helipad: 5,          // вертолётные площадки
  runway_small: 2,     // малая ВПП
  runway_full: 3,      // средняя ВПП
  runway_big: 6,       // большая ВПП
  tower: 3,            // диспетчерская вышка
  stand_small: 10,     // малая стоянка ВС
  stand_medium: 20,    // средняя стоянка ВС
  stand_large: 20,     // большая стоянка ВС
  fuel_depot: 3,       // топливный склад
  terminal_a: 1, terminal_b: 1, terminal_c: 1,
  terminal_d: 1, terminal_e: 1, terminal_f: 1, // терминалы — по одному каждого типа
};

function xpRequiredForLevel(level) {
  return XP_FOR_LEVEL[Math.min(level, XP_FOR_LEVEL.length - 1)];
}

function levelFromXp(xp) {
  let level = 0;
  for (let l = 0; l < XP_FOR_LEVEL.length; l++) {
    if (xp >= XP_FOR_LEVEL[l]) level = l;
  }
  return Math.min(level, CONFIG.TARGET_LEVEL);
}

// ==================== САМОЛЁТЫ (Итерация 2, ядро) ====================
// Самолёты не занимают клетки — им нужны "места" (слоты): стоянка = 1 слот,
// ангар = 1..4 слота по уровню апгрейда. Рейс требует свободной ВПП на взлёт
// и на посадку. Пока самолёт в рейсе — слот за ним закреплён. Если по
// возвращении нет свободной ВПП/слота — самолёт кружит и копит штраф.
const AIRCRAFT_TYPES = {
  small: {
    id: 'small', name: 'Маленький самолёт', minLevel: 4,
    lineType: 'vvl',           // летает только по внутренним авиалиниям
    buyCost: 200000,           // цена покупки нового
    leaseDeposit: 20000,       // разовый взнос при взятии в лизинг
    leasePerTick: 40,         // лизинговый платёж за минуту
    maxUpgradeLevel: 3,
    capacityByLevel: [10, 20, 50],  // вместимость по уровню апгрейда
    fuelTankGallons: 40,        // объём баков (галлонов)
    fuelTankHours: 3,           // = столько игровых часов полёта на полном баке
    flightTicks: 3,             // базовая длительность рейса (мин)
    fuelPerFlight: 500,         // расход топлива за рейс
    revenuePerPax: 90,          // выручка за одного пассажира
    idlePenaltyPerTick: 200,
    idleRepPenaltyPerTick: 1,
    desc: 'Маленький самолёт: небольшие грузы и пассажиры. Летает только по ВВЛ (внутренние линии).',
  },
  medium: {
    id: 'medium', name: 'Узкофюзеляжный самолёт', minLevel: 6,
    lineType: 'both',          // ВВЛ + МВЛ
    buyCost: 500000,
    leaseDeposit: 50000,
    leasePerTick: 250,
    maxUpgradeLevel: 3,
    capacityByLevel: [90, 150, 200],
    fuelTankGallons: 80,
    fuelTankHours: 6,
    flightTicks: 4,
    fuelPerFlight: 4200,
    revenuePerPax: 85,
    idlePenaltyPerTick: 500,
    idleRepPenaltyPerTick: 2,
    desc: 'Узкофюзеляжный среднемагистральный самолёт до 200 человек. Сертифицирован для ВВЛ и МВЛ.',
  },
  large: {
    id: 'large', name: 'Широкофюзеляжный самолёт', minLevel: 8,
    lineType: 'both',
    buyCost: 1000000,
    leaseDeposit: 100000,
    leasePerTick: 130,
    maxUpgradeLevel: 3,
    capacityByLevel: [120, 250, 400],
    fuelTankGallons: 160,
    fuelTankHours: 12,
    flightTicks: 6,
    fuelPerFlight: 7000,
    revenuePerPax: 80,
    idlePenaltyPerTick: 1200,
    idleRepPenaltyPerTick: 3,
    desc: 'Широкофюзеляжный самолёт до 400 человек. Сертифицирован для ВВЛ и МВЛ.',
  },
};

const AIRCRAFT_ECONOMY = {
  // Загрузка рейса — случайная доля вместимости в этом диапазоне (влияет на выручку)
  LOAD_FACTOR_MIN: 0.55,
  LOAD_FACTOR_MAX: 1.0,
  // Риск задержки: с этой вероятностью рейс длится на 1 тик дольше и топлива тратит больше
  DELAY_CHANCE: 0.2,
  DELAY_EXTRA_FUEL_RATE: 0.5, // +50% топлива к рейсу при задержке
  // Выкуп лизингового самолёта: остаточная цена = buyCost * (1 - износ), но не ниже минимума
  BUYOUT_MIN_RATE: 0.35,      // выкуп не может стоить меньше 35% от новой цены
  // Износ: растёт за каждый завершённый рейс, влияет на цену выкупа/перепродажи
  WEAR_PER_FLIGHT: 0.005,     // +0.5% износа за рейс (120 рейсов до потолка)
  WEAR_MAX: 0.6,              // максимум 60% износа (дальше не растёт)
  // Перепродажа собственного самолёта (не лизингового)
  RESALE_RATE: 0.5,          // база 50% от новой цены, дальше минус износ
  // --- Поломки ---
  // Шанс поломки после рейса = износ * множитель (при 60% износа ≈ 30% шанс)
  BREAKDOWN_CHANCE_PER_WEAR: 0.5,
  // --- Ремонт ---
  REPAIR_PCT_OF_PRICE: 0.4,          // ремонт = износ(доля) × это × цена самолёта
  REPAIR_FAST_MIN_COST: 2000,        // но не дешевле этого
  ANGAR_REPAIR_PER_TICK: 0.03,       // ангар сам снижает износ на 3% за тик (если есть место)
  // --- Ресурс под списание ---
  // Самолёт списывается, когда суммарный доход от него достигает этого множителя
  // от цены покупки. По документу: окупил себя в 2 раза — «Списан», только продажа.
  DECOMMISSION_EARNINGS_MULT: 2,
  // --- Апгрейд самолёта (повышает вместимость) ---
  // Цена апгрейда = доля от цены покупки за каждый следующий уровень.
  UPGRADE_COST_RATE: [0, 0.4, 0.7], // ур.1→2 = 40% цены, ур.2→3 = 70%
  // --- Международные рейсы (МВЛ) ---
  MVL_REVENUE_MULT: 1.6, // билет на МВЛ дороже
  MVL_FUEL_MULT: 1.8,    // но и топлива тратит больше (дальше лететь)
};

// Цена апгрейда самолёта до targetLevel (2 или 3).
function aircraftUpgradeCost(typeDef, targetLevel) {
  const rate = AIRCRAFT_ECONOMY.UPGRADE_COST_RATE[targetLevel - 1] || 0.5;
  return Math.round(typeDef.buyCost * rate);
}

// Какие размеры самолётов вмещает стоянка данного типа и уровня.
// Малая: всегда только small. Средняя: medium, с ур.3 ещё small.
// Большая: large, с ур.3 ещё medium и small.
function standAcceptsSizes(standSize, upgradeLevel) {
  const lvl = upgradeLevel || 1;
  if (standSize === 'small') return ['small'];
  if (standSize === 'medium') return lvl >= 3 ? ['medium', 'small'] : ['medium'];
  if (standSize === 'large') return lvl >= 3 ? ['large', 'medium', 'small'] : ['large'];
  return [];
}

// Размер самолёта по его типу (для подбора стоянки).
function aircraftSize(typeId) {
  if (typeId === 'small') return 'small';
  if (typeId === 'medium') return 'medium';
  if (typeId === 'large') return 'large';
  return 'small';
}

// Вместимость самолёта с учётом уровня апгрейда.
function aircraftCapacity(typeDef, upgradeLevel) {
  const arr = typeDef.capacityByLevel || [typeDef.capacity || 0];
  const idx = Math.min(Math.max(1, upgradeLevel || 1), arr.length) - 1;
  return arr[idx];
}

// Порог дохода, при котором самолёт списывается (2× цены покупки).
function decommissionThreshold(typeDef) {
  return typeDef.buyCost * AIRCRAFT_ECONOMY.DECOMMISSION_EARNINGS_MULT;
}

// Сколько мест под самолёты даёт здание в зависимости от уровня апгрейда.
function aircraftSlotsOf(def, upgradeLevel) {
  if (!def || !def.aircraftSlots) return 0;
  if (def.aircraftSlotsPerLevel) return upgradeLevel; // ангар: слотов = уровень (1..4)
  return def.aircraftSlots; // стоянка: всегда 1
}

// Остаточная цена выкупа лизингового самолёта с учётом износа.
function buyoutPrice(typeDef, wear) {
  const rate = Math.max(AIRCRAFT_ECONOMY.BUYOUT_MIN_RATE, 1 - wear);
  return Math.round(typeDef.buyCost * rate);
}

// Цена перепродажи собственного самолёта с учётом износа.
function resalePrice(typeDef, wear) {
  return Math.round(typeDef.buyCost * AIRCRAFT_ECONOMY.RESALE_RATE * (1 - wear));
}

// Цена быстрого (платного) ремонта — процент от цены самолёта, пропорционально износу.
function repairCost(wear, buyCost) {
  const price = buyCost || 0;
  return Math.max(
    AIRCRAFT_ECONOMY.REPAIR_FAST_MIN_COST,
    Math.round(wear * AIRCRAFT_ECONOMY.REPAIR_PCT_OF_PRICE * price)
  );
}

module.exports = {
  CONFIG, LAND_EXPANSION, BUILDINGS, BUILD_LIMITS, XP_FOR_LEVEL, xpRequiredForLevel, levelFromXp,
  BOT_ECONOMY, BOT_COMPANY_NAMES, randomBotName, randomBotNames, generateRentOffers, rentAcceptChance,
  UPGRADE_ECONOMY, upgradeCost, upgradeMultiplier, buildDurationTicks, upgradeDurationTicks,
  AIRCRAFT_TYPES, AIRCRAFT_ECONOMY, aircraftSlotsOf, buyoutPrice, resalePrice, repairCost,
  aircraftCapacity, decommissionThreshold, aircraftUpgradeCost,
  standAcceptsSizes, aircraftSize, standServiceMinutes,
  RUNWAY_ECONOMY, runwayWearPerLanding, runwayRepairCost, runwayRepairTicks,
  DAMAGE_ECONOMY, damageMultiplier, damageRepairCost, damageRepairTicks, ruinedDemolishCost,
  AIRLINE_BOT_NAMES, randomAirlineName, CONTRACT_ECONOMY, contractPayPerTick, contractDurationTicks,
  APRON_ECONOMY, contractPayPerArrival,
  FUEL_SUPPLIERS, FUEL_ECONOMY, fuelStorageCapacity, getFuelSupplier,
  fuelMarketMultiplier,
  PASSENGER_ECONOMY, terminalThroughput,
};
