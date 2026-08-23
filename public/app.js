const API = '';
let TOKEN = localStorage.getItem('soul_journey_token') || null;
let STATE = null;
let ws = null;
let selectedCell = null;
let swapMode = false;      // включён ли режим «поменять местами»
let swapFirst = null;       // первая выбранная клетка для обмена
let lastIncomePerMin = null; // последний чистый доход за минуту (из тика), для шапки

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Заполняющийся круговой индикатор прогресса (сектор-пирог, как на референсе).
// progress: 0..1. Заполненный сектор растёт по часовой стрелке.
function progressRing(progress, size = 40) {
  const p = Math.max(0, Math.min(1, progress));
  const cx = size / 2, cy = size / 2, r = size / 2;
  // угол заполнения
  const angle = p * 360;
  const rad = (angle - 90) * Math.PI / 180;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);
  const largeArc = angle > 180 ? 1 : 0;
  // путь заполненного сектора (от центра, вверх, по дуге)
  const startX = cx, startY = cy - r;
  let filled = '';
  if (p >= 0.999) {
    filled = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--progress-fill,#12b5c4)"/>`;
  } else if (p > 0.001) {
    filled = `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z" fill="var(--progress-fill,#12b5c4)"/>`;
  }
  return `
    <svg class="progress-ring spin-slow" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--progress-rest,#f97a6d)"/>
      ${filled}
    </svg>`;
}

// Доля готовности работ по зданию (0..1)
function constructionProgress(b) {
  if (!b.constructionType || !b.constructionTotal) return 0;
  const done = b.constructionTotal - b.constructionTicksLeft;
  return done / b.constructionTotal;
}

// Картинка здания из папок uploads/buildings/<id>/ (см. docs/media-folders.md).
// Точный уровень → ближайший меньший → самый младший → default → null (эмодзи).
// Логика повторяет resolveBuilding в server/mediaScan.js — правится парой.
function resolveBuildingImage(buildingId, level) {
  const entry = STATE.buildingMedia && STATE.buildingMedia[buildingId];
  if (!entry) return null;
  const lvl = Number(level) || 1;
  const levels = entry.levels || {};
  if (levels[lvl]) return levels[lvl];
  const nums = Object.keys(levels).map(Number).sort((a, b) => a - b);
  if (nums.length) {
    let best = null;
    for (const n of nums) if (n <= lvl) best = n;
    return levels[best != null ? best : nums[0]];
  }
  return entry.default || null;
}

const BUILDING_ICONS = {
  admin: '🏢', helipad: '🚁', tower: '📡', runway_small: '🛬', terminal_a: '🏬',
  fuel_depot: '⛽', airline_office: '✈️', stand_small: '🅿️', stand_medium: '🅿️', stand_large: '🅿️', hangar: '🔧', runway_full: '🛫',
  cargo_terminal: '📦', fire_station: '🚒', terminal_b: '🏬', cafe: '☕', hotel: '🏨',
  runway_big: '🛬', vip_lounge: '💺', terminal_d: '🏬', conference_center: '🏢',
  cargo_hub: '📦', terminal_c: '🌍', terminal_e: '🌍', terminal_f: '🌐',
};

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $(`#${id}`).classList.remove('hidden');
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function queueToasts(messages) {
  messages.forEach((msg, i) => {
    setTimeout(() => toast(msg), i * 3200);
  });
}

let bannedKicked = false;

async function api(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(API + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.error === 'banned') {
    handleBanKick(data.message);
  }
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка запроса');
  return data;
}

function handleBanKick(message) {
  if (bannedKicked) return;
  bannedKicked = true;
  localStorage.removeItem('soul_journey_token');
  TOKEN = null;
  if (ws) { ws.close(); ws = null; }
  showScreen('authScreen');
  $('#loginMsg').textContent = message || 'Аккаунт заблокирован.';
}

// ===== AUTH =====
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('#loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('#registerForm').classList.toggle('hidden', tab.dataset.tab !== 'register');
  });
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/login', 'POST', {
      username: $('#loginUsername').value.trim(),
      password: $('#loginPassword').value,
    });
    onAuthed(data);
  } catch (err) {
    $('#loginMsg').textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/register', 'POST', {
      username: $('#regUsername').value.trim(),
      password: $('#regPassword').value,
    });
    onAuthed(data);
  } catch (err) {
    $('#regMsg').textContent = err.message;
  }
});

async function onAuthed(data) {
  TOKEN = data.token;
  localStorage.setItem('soul_journey_token', TOKEN);
  await bootAfterAuth();
}

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('soul_journey_token');
  TOKEN = null;
  if (ws) ws.close();
  showScreen('authScreen');
});

// «Начать сначала» — полный сброс прогресса. Двухшаговое подтверждение.
let restartConfirmPending = false;
let restartConfirmTimer = null;
$('#restartBtn') && $('#restartBtn').addEventListener('click', async () => {
  const btn = $('#restartBtn');
  if (!restartConfirmPending) {
    // первый клик — просим подтверждение
    restartConfirmPending = true;
    btn.textContent = '⚠ Точно? Весь прогресс сотрётся — нажмите ещё раз';
    btn.classList.add('confirm-armed');
    restartConfirmTimer = setTimeout(() => {
      restartConfirmPending = false;
      btn.textContent = '↺ Начать сначала';
      btn.classList.remove('confirm-armed');
    }, 4000); // окно подтверждения 4 сек
    return;
  }
  // второй клик — сбрасываем
  clearTimeout(restartConfirmTimer);
  restartConfirmPending = false;
  btn.textContent = '↺ Начать сначала';
  btn.classList.remove('confirm-armed');
  try {
    STATE = await api('/api/airport/restart', 'POST');
    // сбрасываем состояние интерфейса (открытые группы/панели от прошлой игры)
    openGroups.clear();
    openBuildingCells.clear();
    _objectsTableFingerprint = null;
    // мгновенно обновляем ВСЕ счётчики и весь интерфейс
    updateTopboard();
    renderAll();
    // снова просим название аэропорта (как при новом старте)
    $('#airportNameModal').classList.remove('hidden');
    toast('Игра начата заново. Все счётчики обнулены.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ===== START GAME =====
$$('.start-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    try {
      const state = await api('/api/start-game', 'POST', { startType: btn.dataset.start });
      STATE = state;
      enterGame();
    } catch (err) {
      toast(err.message, true);
    }
  });
});

// ===== BOOT =====
async function bootAfterAuth() {
  try {
    const me = await api('/api/me');
    if (me.username) {
      const playerEl = $('#topboardPlayer');
      if (playerEl) playerEl.textContent = me.username;
    }
    if (me.hasAirport) {
      const state = await api('/api/state');
      STATE = state;
      enterGame();
    } else {
      showScreen('startScreen');
    }
  } catch (err) {
    localStorage.removeItem('soul_journey_token');
    TOKEN = null;
    showScreen('authScreen');
  }
}

function enterGame() {
  showScreen('gameScreen');
  updateTopboard();
  renderAll();
  connectWs();
  startTimerLoop();
  loadGameLogo();

  // Банкротство имеет приоритет над всем остальным
  if (STATE.bankrupt) {
    showBankrupt();
    return;
  }
  // Первый вход без названия аэропорта — просим ввести
  if (!STATE.name) {
    $('#airportNameModal').classList.remove('hidden');
  } else {
    checkAirlineOffer();
  }
}

// Загрузка фонов экранов (вход + игра), задаются админом. Публичный доступ.
async function loadBackgrounds() {
  try {
    const res = await fetch('/api/public-settings');
    if (!res.ok) return;
    const s = await res.json();
    applyBackground('authBg', s.authBg);
    applyBackground('gameBg', s.gameBg);
  } catch (err) { /* фон необязателен */ }
}

function applyBackground(elementId, bg) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = '';
  if (!bg || !bg.url) return;
  if (bg.kind === 'video') {
    const v = document.createElement('video');
    v.src = bg.url;
    v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
    v.setAttribute('playsinline', '');
    el.appendChild(v);
    v.play().catch(() => {});
  } else {
    const img = document.createElement('img');
    img.src = bg.url;
    img.alt = '';
    el.appendChild(img);
  }
}

// Загрузка логотипа игры (общий, задаётся админом).
// Файлы лежат в public/uploads/logo/: default.* — основной, small.* —
// необязательный компактный, он подставляется на узких экранах.
async function loadGameLogo() {
  try {
    const s = await api('/api/settings');
    const logo = $('#gameLogo');
    if (!logo) return;
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const url = (narrow && s.logoSmallUrl) ? s.logoSmallUrl : s.logoUrl;
    if (url) {
      logo.src = url;
      logo.classList.remove('hidden');
    } else {
      logo.classList.add('hidden');
    }
  } catch (err) { /* логотип необязателен */ }
}

// Показать окно «Создать АК», если игрок дорос до 5 уровня и ещё не создал.
// Показываем один раз за сессию (дальше — постоянная кнопка «Создать АК» в шапке).
let airlineOfferShownThisSession = false;
function checkAirlineOffer() {
  if (!STATE || !STATE.airlineOfferAvailable) return;
  if (airlineOfferShownThisSession) return;
  // не перебиваем другие открытые окна
  if (!$('#airportNameModal').classList.contains('hidden')) return;
  if (!$('#airlineNameModal').classList.contains('hidden')) return;
  if (!$('#bankruptModal').classList.contains('hidden')) return;
  airlineOfferShownThisSession = true;
  $('#airlineOfferModal').classList.remove('hidden');
}

function showBankrupt() {
  // прячем прочие модалки, показываем экран game over
  $$('.modal').forEach(m => m.classList.add('hidden'));
  $('#bankruptModal').classList.remove('hidden');
}

function updateTopboard() {
  const airportEl = $('#topboardAirport');
  if (airportEl) airportEl.textContent = STATE.name || '';
  updateAirlineButton();
  updateEnvelopeButton();
}

// Кнопка конверта видна, когда аэропорт может принимать борты (есть договоры/предложения)
function updateEnvelopeButton() {
  const btn = $('#envelopeBtn');
  if (!btn) return;
  const show = STATE.canAcceptContracts || STATE.envelopeOffers > 0 || STATE.activeContracts > 0;
  btn.classList.toggle('hidden', !show);
  const badge = $('#envelopeBadge');
  if (badge) {
    const n = STATE.envelopeOffers || 0;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  }
}

// Кнопка «Создать АК» видна, если можно создать (5+ уровень, ещё не создана)
function updateAirlineButton() {
  const btn = $('#createAirlineBtn');
  if (!btn) return;
  const canCreate = STATE.level >= 5 && !STATE.airline;
  btn.classList.toggle('hidden', !canCreate);
}

// ===== WEBSOCKET =====
function connectWs() {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${TOKEN}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'tick') {
      lastIncomePerMin = msg.income; // чистый доход за минуту для шапки
      STATE = msg.state;
      renderAll();
      updateTopboard();
      // Банкротство — сразу game over, остальное не важно
      if (msg.bankrupt || STATE.bankrupt) {
        showBankrupt();
        return;
      }
      // Игрок только что достиг 5 уровня — показываем предложение создать АК
      checkAirlineOffer();
      // тост о балансе: показываем чистое изменение (доход минус содержание)
      if (msg.income !== 0 || msg.reputation !== 0) {
        const parts = [];
        if (msg.income !== 0) parts.push(`${msg.income > 0 ? '+' : ''}${msg.income} у.е.`);
        if (msg.reputation !== 0) parts.push(`${msg.reputation > 0 ? '+' : ''}${msg.reputation} реп.`);
        if (parts.length) toast(`${parts.join(', ')} за минуту`);
      }
      if (!$('#buildingModal').classList.contains('hidden')) {
        renderBuildingModal();
      }
      if (!$('#fleetModal').classList.contains('hidden')) {
        renderFleet();
      }
      if (!$('#envelopeModal').classList.contains('hidden')) {
        // подтягиваем свежие предложения/договоры
        api('/api/envelope').then(d => { envelopeData = d; renderEnvelope(); }).catch(() => {});
      }
    }
  };
  ws.onclose = () => setTimeout(() => { if (TOKEN && !bannedKicked) connectWs(); }, 3000);
}

// ===== TIMER =====
function startTimerLoop() {
  clearInterval(startTimerLoop._i);
  startTimerLoop._i = setInterval(() => {
    if (!STATE) return;
    const from = STATE.startedAt;
    const elapsed = STATE.reachedLevel10At ? (STATE.reachedLevel10At - from) : (Date.now() - from);
    $('#statTimer').textContent = formatDuration(elapsed);
  }, 1000);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ===== RENDER =====
function bumpStat(el) {
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}

function renderAll() {
  checkPendingDisasters();
  renderStats();
  renderRepairAllBar();
  renderObjectsTable();
  renderGrid();
  renderBuildMenu();
}

function renderStats() {
  const moneyEl = $('#statMoney');
  moneyEl.textContent = Math.floor(STATE.money).toLocaleString('ru-RU');
  moneyEl.classList.toggle('stat-negative', STATE.money < 0); // долг — красным
  $('#statLevel').textContent = STATE.level;
  $('#statRep').textContent = Math.floor(STATE.reputation);
  const upkeepEl = $('#statUpkeep');
  if (upkeepEl) upkeepEl.textContent = '−' + Math.round(STATE.upkeepPerTick || 0);
  const expEl = $('#statExpenses');
  if (expEl) expEl.textContent = '−' + Math.round(STATE.expensesPerTick || 0);
  const incomeEl = $('#statIncome');
  if (incomeEl && lastIncomePerMin !== null) {
    incomeEl.textContent = (lastIncomePerMin >= 0 ? '+' : '') + lastIncomePerMin;
    incomeEl.classList.toggle('stat-negative', lastIncomePerMin < 0);
  }
  const apronEl = $('#statApron');
  if (apronEl && STATE.apronSlots) {
    const s = STATE.apronSlots;
    const wait = STATE.apronWaiting || 0;
    // показываем вертолётные места и стоянки самолётов раздельно
    if (s.heli && s.plane) {
      apronEl.textContent = `🚁${s.heli.used}/${s.heli.total} ✈${s.plane.used}/${s.plane.total}`;
    } else {
      apronEl.textContent = `${s.used}/${s.total}`;
    }
    apronEl.classList.toggle('stat-negative', wait > 0);
  }
  // топливо: показываем запас/вместимость, скрываем если склада нет
  const fuelWrap = $('#statFuelWrap');
  if (fuelWrap && STATE.fuel) {
    if (STATE.fuel.hasDepot) {
      fuelWrap.style.display = '';
      const f = STATE.fuel;
      const pct = f.capacity > 0 ? Math.round(f.stored / f.capacity * 100) : 0;
      const el = $('#statFuel');
      el.textContent = `${Math.round(f.stored / 1000)}k/${Math.round(f.capacity / 1000)}k`;
      el.classList.toggle('stat-negative', pct < 20); // мало топлива — красным
    } else {
      fuelWrap.style.display = 'none';
    }
  }
  // пассажиры: общая сумма всех обслуженных (улетевшие+прилетевшие, верт.+самолёты)
  const paxWrap = $('#statPaxWrap');
  if (paxWrap) {
    const served = STATE.paxServed || 0;
    const queue = STATE.termQueue || 0;
    const el = $('#statPax');
    el.textContent = served.toLocaleString('ru-RU');
    el.classList.toggle('stat-negative', queue > 0);
    el.title = queue > 0 ? `В очереди терминала: ${queue}` : 'Всего обслужено пассажиров';
  }
  bumpStat($('#statMoney'));

  const currentFloor = STATE.level >= 10 ? STATE.xpForNextLevel : STATE.xpForNextLevel;
  const pct = STATE.level >= 10 ? 100 : Math.min(100, (STATE.xp / STATE.xpForNextLevel) * 100);
  $('#xpBarFill').style.width = pct + '%';
  $('#xpBarText').textContent = STATE.level >= 10
    ? (STATE.reachedLevel10At
        ? `МАКСИМАЛЬНЫЙ УРОВЕНЬ ДОСТИГНУТ — ${formatDuration(STATE.reachedLevel10At - STATE.startedAt)}`
        : 'МАКСИМАЛЬНЫЙ УРОВЕНЬ ДОСТИГНУТ')
    : `${Math.floor(STATE.xp)} / ${STATE.xpForNextLevel} XP до уровня ${STATE.level + 1}`;

  $('#buyLandBtn').disabled = !STATE.nextExpansion;
  if (STATE.nextExpansion) {
    $('#buyLandBtn').textContent = `Выкупить землю (${STATE.nextExpansion.cost.toLocaleString('ru-RU')} у.е., ур. ${STATE.nextExpansion.minLevel}+)`;
  } else {
    $('#buyLandBtn').textContent = 'Вся доступная земля выкуплена';
  }
}

// Множитель дохода по уровню апгрейда (глобальный — нужен и таблице, и панели)
function upgradeMult(lvl) {
  return 1 + (lvl - 1) * (STATE.upgradeEconomy?.INCOME_BONUS_PER_LEVEL || 0.3);
}

let _objectsTableFingerprint = null;

// Категории для группировки таблицы зданий.
// Порядок = порядок показа групп. members — id зданий этой группы.
const BUILDING_GROUPS = [
  { key: 'helipads', title: 'Вертолётный перрон', members: ['helipad'] },
  { key: 'stands', title: 'Самолётный перрон', subgroups: [
      { key: 'stand_small', title: 'Малые стоянки', members: ['stand_small'] },
      { key: 'stand_medium', title: 'Средние стоянки', members: ['stand_medium'] },
      { key: 'stand_large', title: 'Большие стоянки', members: ['stand_large'] },
    ] },
  { key: 'terminals', title: 'Терминалы', members: ['terminal_a','terminal_b','terminal_c','terminal_d','terminal_e','terminal_f'] },
  { key: 'runways', title: 'ВПП', members: ['runway_small','runway_full','runway_big'] },
  { key: 'towers', title: 'Диспетчерская', members: ['tower'] },
  { key: 'hangars', title: 'Ангары', members: ['hangar'] },
  { key: 'fuel', title: 'Топливо', members: ['fuel_depot'] },
];
// Здания вне групп (отдельные строки сверху).
const UNGROUPED_BUILDINGS = ['admin', 'airline_office'];

// Какие группы/подгруппы сейчас раскрыты (по key). Несколько могут быть открыты.
let openGroups = new Set();
// Какие здания (по cellIndex) сейчас раскрыты. Несколько одновременно.
let openBuildingCells = new Set();

function toggleGroup(key) {
  if (openGroups.has(key)) openGroups.delete(key); else openGroups.add(key);
  renderObjectsTable(true);
}
function toggleBuildingAccordion(cellIndex) {
  if (openBuildingCells.has(cellIndex)) openBuildingCells.delete(cellIndex);
  else { openBuildingCells.add(cellIndex); accRentView = 'menu'; accRentOffers = null; }
  renderObjectsTable(true);
}

// Раскрыть группу (и подгруппу), где лежит здание, и само здание — по клику с клетки.
function openBuildingInTable(buildingId, cellIndex) {
  for (const group of BUILDING_GROUPS) {
    if (group.subgroups) {
      for (const sg of group.subgroups) {
        if (sg.members.includes(buildingId)) {
          openGroups.add(group.key);
          openGroups.add(sg.key);
        }
      }
    } else if (group.members.includes(buildingId)) {
      openGroups.add(group.key);
    }
  }
  openBuildingCells.add(cellIndex);
  accRentView = 'menu'; accRentOffers = null;
}

function objectsTableFingerprint() {
  const heli = STATE.apronSlots?.heli;
  const plane = STATE.apronSlots?.plane;
  const occ = `${heli?.used}/${heli?.total}·${plane?.used}/${plane?.total}`;
  const rows = [...STATE.buildings]
    .sort((a, b) => a.cellIndex - b.cellIndex)
    .map(b => `${b.cellIndex}:${b.buildingId}:${b.state || 'owned'}:${b.upgradeLevel || 1}:${b.constructionType || ''}:${b.pendingUpgradeLevel || ''}:${b.rentPrice || ''}:${b.listedPrice || ''}`)
    .join('|');
  const fuel = STATE.fuel ? `${STATE.fuel.stored}/${STATE.fuel.capacity}` : '';
  const groups = [...openGroups].sort().join(',');
  const cells = [...openBuildingCells].sort((a,b)=>a-b).join(',');
  return `${rows}#grp:${groups}#cells:${cells}#view:${accRentView}#occ:${occ}#fuel:${fuel}`;
}

function renderObjectsTable(force) {
  const tbody = $('#objectsTableBody');
  const fp = objectsTableFingerprint();
  if (!force && fp === _objectsTableFingerprint) return;
  _objectsTableFingerprint = fp;
  tbody.innerHTML = '';

  const buildings = [...STATE.buildings].sort((a, b) => a.cellIndex - b.cellIndex);
  if (buildings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="objects-empty">Пока нет построек — откройте «Территория а/п» и постройте первый объект</td></tr>';
    return;
  }

  const byId = (id) => buildings.filter(b => b.buildingId === id);

  // 1) Здания вне групп (админ, офис) — отдельные строки
  UNGROUPED_BUILDINGS.forEach(id => {
    byId(id).forEach(b => renderBuildingRow(b, tbody, 0));
  });

  // 2) Группы (только непустые)
  BUILDING_GROUPS.forEach(group => {
    if (group.subgroups) {
      // считаем все здания во всех подгруппах
      const total = group.subgroups.reduce((n, sg) =>
        n + sg.members.reduce((m, id) => m + byId(id).length, 0), 0);
      if (total === 0) return; // пустая группа не показывается
      renderGroupHeaderRow(group.key, group.title, total, tbody, 0);
      if (openGroups.has(group.key)) {
        group.subgroups.forEach(sg => {
          const sgBuildings = sg.members.flatMap(id => byId(id));
          if (sgBuildings.length === 0) return;
          renderGroupHeaderRow(sg.key, sg.title, sgBuildings.length, tbody, 1);
          if (openGroups.has(sg.key)) {
            sgBuildings.forEach(b => renderBuildingRow(b, tbody, 2));
          }
        });
      }
    } else {
      const groupBuildings = group.members.flatMap(id => byId(id));
      if (groupBuildings.length === 0) return;
      renderGroupHeaderRow(group.key, group.title, groupBuildings.length, tbody, 0);
      if (openGroups.has(group.key)) {
        groupBuildings.forEach(b => renderBuildingRow(b, tbody, 1));
      }
    }
  });
}

// Строка-заголовок группы (кликабельная, со счётчиком и стрелкой).
function renderGroupHeaderRow(key, title, count, tbody, indent) {
  const tr = document.createElement('tr');
  tr.className = 'group-row' + (openGroups.has(key) ? ' open' : '');
  const arrow = openGroups.has(key) ? '▼' : '▶';
  tr.innerHTML = `
    <td class="group-name-cell" colspan="3" style="padding-left:${14 + indent * 22}px">
      <span class="group-arrow">${arrow}</span>
      <span class="group-title">${escapeHtml(title)}</span>
      <span class="group-count">${count}</span>
    </td>
  `;
  tr.addEventListener('click', () => toggleGroup(key));
  tbody.appendChild(tr);
}

// Строка одного здания + его аккордеон-панель. indent — уровень вложенности.
function renderBuildingRow(building, tbody, indent) {
  const def = STATE.catalog[building.buildingId];
  const state = building.state || 'owned';
  const level = building.upgradeLevel || 1;

  const baseName = building.customName || displayBuildingName(building.buildingId);
  const levelSuffix = building.maxUpgradeLevel > 1 ? ` ${toRoman(level)}` : '';
  const name = baseName + levelSuffix;

  const globalSkin = resolveBuildingImage(building.buildingId, level);
  const iconValue = building.customIcon || globalSkin || BUILDING_ICONS[building.buildingId] || '🏗️';
  const photoHtml = /^https?:\/\/|^data:image|^\/uploads\//.test(iconValue)
    ? `<img src="${iconValue}" alt="" class="obj-photo-img">`
    : `<span class="obj-photo-emoji">${iconValue}</span>`;

  let actionText = '';
  if (building.constructionType === 'build') {
    actionText = `<span class="obj-working">${progressRing(constructionProgress(building), 28)}<span>Строится</span></span>`;
  } else if (building.constructionType === 'upgrade') {
    actionText = `<span class="obj-working">${progressRing(constructionProgress(building), 28)}<span>Улучшается до ур. ${building.pendingUpgradeLevel}</span></span>`;
  } else if (state === 'sold') {
    actionText = `<span class="obj-status sold">Продано ${escapeHtml(building.botName || '')}</span>`;
  } else if (state === 'listed') {
    actionText = `<span class="obj-status listed">На бирже: ${building.listedPrice} у.е./мин — ждём</span>`;
  } else if (state === 'rented') {
    actionText = `<span class="obj-status rented">Аренда: +${building.rentPrice} у.е./мин</span><br>${escapeHtml(building.botName || '')}`;
  } else {
    if (def.infrastructure) {
      actionText = infraStatusText(building);
    } else {
      const income = Math.round(def.income * upgradeMult(level));
      const rep = Math.round((def.reputation || 0) * upgradeMult(level));
      const parts = [`+${income} у.е./мин`];
      if (rep > 0) parts.push(`+${rep} реп./мин`);
      actionText = parts.join('<br>');
    }
  }

  const tr = document.createElement('tr');
  tr.className = 'objects-row';
  const desc = displayBuildingDesc(building.buildingId);
  const levelDetail = levelDetailText(building.buildingId, level);
  const dmgRow = damageState(building);
  tr.innerHTML = `
    <td class="obj-name-cell" style="padding-left:${14 + indent * 22}px">
      <div class="obj-name-inner">
        ${indent > 0 ? '<span class="obj-branch">└</span>' : ''}
        <div class="obj-photo">${photoHtml}</div>
        <div class="obj-name-wrap">
          <span class="obj-name">${escapeHtml(name)}</span>
          ${levelDetail ? `<span class="obj-subname">${escapeHtml(levelDetail)}</span>` : ''}
          ${dmgRow.cls !== 'ok' ? `<span class="obj-damage ${dmgRow.cls}">${dmgRow.mark} ${escapeHtml(dmgRow.label)}</span>` : ''}
        </div>
      </div>
    </td>
    <td class="obj-desc">${escapeHtml(desc)}</td>
    <td class="obj-action">${actionText}</td>
  `;
  const cellIndex = building.cellIndex;
  tr.addEventListener('click', () => toggleBuildingAccordion(cellIndex));
  if (openBuildingCells.has(cellIndex)) tr.classList.add('accordion-open');
  tbody.appendChild(tr);

  const accRow = document.createElement('tr');
  accRow.className = 'obj-accordion-row';
  accRow.dataset.cell = cellIndex;
  const accCell = document.createElement('td');
  accCell.colSpan = 3;
  accCell.className = 'obj-accordion-cell';
  const accInner = document.createElement('div');
  accInner.className = 'obj-accordion-inner';
  accCell.appendChild(accInner);
  accRow.appendChild(accCell);
  tbody.appendChild(accRow);

  if (openBuildingCells.has(cellIndex)) {
    accRow.classList.add('open');
    renderBuildingPanel(cellIndex, accInner);
  }
}

function renderGrid() {
  const grid = $('#airportGrid');
  const size = STATE.gridSize;
  // Максимум 4 клетки в ширину (на всех устройствах) — остальные переносятся
  // вертикально, чтобы сетка не расползалась вширь и не было горизонтальной прокрутки.
  const cols = Math.min(size, 4);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.innerHTML = '';

  const buildingByCell = {};
  STATE.buildings.forEach(b => buildingByCell[b.cellIndex] = b);

  for (let i = 0; i < size * size; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const building = buildingByCell[i];

    if (building) {
      const def = STATE.catalog[building.buildingId];
      const state = building.state || 'owned';
      cell.classList.add('occupied');
      if (state === 'rented') cell.classList.add('state-rented');
      if (state === 'sold') cell.classList.add('state-sold');
      if (state === 'listed') cell.classList.add('state-listed');

      let badge = '';
      if (state === 'rented') badge = '<span class="cell-badge rented">АРЕНДА</span>';
      if (state === 'sold') badge = '<span class="cell-badge sold">ПРОДАНО</span>';
      if (state === 'listed') badge = '<span class="cell-badge listed">НА БИРЖЕ</span>';
      // работы показываем кольцом прогресса поверх иконки (без слова "тик")
      let workingOverlay = '';
      if (building.constructionType) {
        const prog = constructionProgress(building);
        cell.classList.add('state-working');
        workingOverlay = `<div class="cell-progress">${progressRing(prog, 48)}</div>`;
      }

      const globalSkin = resolveBuildingImage(building.buildingId, building.upgradeLevel);
      const iconValue = building.customIcon || globalSkin || BUILDING_ICONS[building.buildingId] || '🏗️';
      const dmg = damageState(building);
      const iconHtml = /^https?:\/\/|^data:image|^\/uploads\//.test(iconValue)
        ? `<img src="${iconValue}" alt="" class="cell-icon-img">`
        : `<div class="cell-icon">${iconValue}</div>`;

      const baseName = building.customName || displayBuildingName(building.buildingId);
      const levelSuffix = building.maxUpgradeLevel > 1 ? ` ${toRoman(building.upgradeLevel)}` : '';
      const displayName = baseName + levelSuffix;
      const labelStyle = STATE.buildingLabelStyles?.[building.buildingId];
      const labelStyleAttr = labelStyle
        ? ` style="${labelStyle.fontSize ? `font-size:${normalizeFontSize(labelStyle.fontSize)} !important;` : ''}${labelStyle.color ? `color:${labelStyle.color} !important;` : ''}"`
        : '';

      // Гаечный ключ с 50% повреждения, мелкая точка с 10% — двухступенчатый
      // сигнал: игрок видит, что вред уже идёт, задолго до срочного ремонта.
      const damageOverlay = dmg.mark
        ? `<span class="cell-damage ${dmg.cls}" title="${escapeHtml(dmg.label)}">${dmg.mark}</span>`
        : '';
      // класс на клетку — подсвечиваем рамку, чтобы повреждение было заметно
      // даже боковым зрением при осмотре сетки
      if (dmg.cls !== 'ok') cell.classList.add(`damage-${dmg.cls}`);
      cell.innerHTML = `
        <div class="cell-image-wrap">
          ${badge}
          ${workingOverlay}
          ${damageOverlay}
          ${iconHtml}
        </div>
        <div class="cell-label"${labelStyleAttr}>${escapeHtml(displayName)}</div>
        ${building.botName ? `<div class="cell-bot-name">${escapeHtml(building.botName)}</div>` : ''}`;
      cell.title = displayBuildingDesc(building.buildingId);
      cell.addEventListener('click', () => {
        if (swapMode) { handleSwapClick(i); return; }
        // клетки — только раскладка; управление в таблице. Раскрываем группу+здание.
        openBuildingInTable(building.buildingId, i);
        renderObjectsTable(true);
        const row = document.querySelector(`.obj-accordion-row[data-cell="${i}"]`);
        if (row) row.previousElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } else {
      cell.innerHTML = `<div class="cell-image-wrap"><span class="cell-empty-plus">+</span></div>`;
      cell.addEventListener('click', () => {
        if (swapMode) { handleSwapClick(i); return; }
        selectCell(i);
      });
    }
    if (swapMode && swapFirst === i) cell.classList.add('swap-selected');
    if (selectedCell === i) cell.querySelector('.cell-image-wrap').style.borderColor = 'var(--board-amber)';
    grid.appendChild(cell);
  }
}

function selectCell(i) {
  selectedCell = i;
  // Если пришли из бокового меню с выбранным зданием — строим сразу.
  if (pendingBuildId) {
    const toBuild = pendingBuildId;
    pendingBuildId = null;
    build(toBuild);
    return;
  }
  renderGrid();
  renderTerritoryBuildMenu();
}

function purchasableBuildings() {
  const builtIds = new Set(STATE.buildings.map(b => b.buildingId));
  // Уникальные здания (админздание) скрываем после постройки; остальные,
  // включая вертолётную стоянку, доступны к постройке всегда.
  return Object.values(STATE.catalog)
    .filter(b => !b.hidden)                            // скрытые (без механики) не показываем игроку
    .filter(b => !b.unique || !builtIds.has(b.id))
    .filter(b => !b.requiresAirline || STATE.airline) // офис — только после создания АК
    .sort((a, b) => a.minLevel - b.minLevel || a.cost - b.cost);
}

function renderBuildMenu() {
  // Боковое меню на главном экране — каталог с кнопкой "Построить"
  const menu = $('#buildMenu');
  if (!menu) return;
  menu.innerHTML = '';

  const purchasable = purchasableBuildings();

  purchasable.forEach(def => {
    const locked = STATE.level < def.minLevel;
    const tooExpensive = STATE.money < def.cost;
    // лимит количества этого здания
    const limit = (STATE.buildLimits || {})[def.id];
    const builtCount = STATE.buildings.filter(b => b.buildingId === def.id && (b.state || 'owned') !== 'sold').length;
    const limitReached = limit != null && builtCount >= limit;
    const limitLabel = limit != null ? `<span>Построено: ${builtCount}/${limit}</span>` : '';
    const item = document.createElement('div');
    item.className = 'build-item' + (locked ? ' locked' : '') + (limitReached ? ' limit-reached' : '');
    item.innerHTML = `
      <div class="build-item-top">
        <span class="build-item-name">${BUILDING_ICONS[def.id] || ''} ${displayBuildingName(def.id)}</span>
        <span class="build-item-cost">${def.cost.toLocaleString('ru-RU')} у.е.</span>
      </div>
      <div class="build-item-desc">${displayBuildingDesc(def.id)}</div>
      <div class="build-item-meta">
        <span>${def.minLevel > 0 ? `Ур. ${def.minLevel}+` : 'Стартовое'}</span>
        <span>Доход: +${def.income}/мин</span>
        ${def.reputation ? `<span>Репутация: +${def.reputation}/мин</span>` : ''}
        <span>XP: +${def.xp}</span>
        ${limitLabel}
      </div>
    `;
    if (!locked) {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary';
      btn.style.width = '100%';
      if (limitReached) {
        btn.textContent = `Лимит достигнут (${limit} шт.)`;
        btn.disabled = true;
      } else {
        btn.textContent = tooExpensive ? 'Недостаточно средств' : 'Построить';
        btn.disabled = tooExpensive;
        btn.addEventListener('click', () => startBuildFlow(def.id));
      }
      item.appendChild(btn);
    }
    menu.appendChild(item);
  });
}

// Запуск постройки из бокового меню: открываем территорию и подсказываем
// выбрать клетку для конкретного здания.
let pendingBuildId = null;
function startBuildFlow(buildingId) {
  pendingBuildId = buildingId;
  selectedCell = null;
  renderGrid();
  renderStats();
  renderTerritoryBuildMenu();
  $('#territoryModal').classList.remove('hidden');
}

function renderTerritoryBuildMenu() {
  // Меню внутри модалки территории — с кнопками постройки на выбранную клетку
  const menu = $('#territoryBuildMenu');
  if (!menu) return;
  menu.innerHTML = '';

  if (selectedCell === null) {
    if (pendingBuildId) {
      const def = STATE.catalog[pendingBuildId];
      menu.innerHTML = `<div class="build-menu-hint">Выберите пустую клетку, чтобы построить «${escapeHtml(displayBuildingName(pendingBuildId))}» (${def.cost.toLocaleString('ru-RU')} у.е.).</div>`;
    } else {
      menu.innerHTML = '<div class="build-menu-hint">Кликните по пустой клетке, чтобы выбрать, что построить.</div>';
    }
    return;
  }

  const title = document.createElement('div');
  title.className = 'panel-title';
  title.textContent = `ПОСТРОЙКА НА КЛЕТКУ №${selectedCell}`;
  menu.appendChild(title);

  const purchasable = purchasableBuildings();

  purchasable.forEach(def => {
    const locked = STATE.level < def.minLevel;
    const tooExpensive = STATE.money < def.cost;
    const limit = (STATE.buildLimits || {})[def.id];
    const builtCount = STATE.buildings.filter(b => b.buildingId === def.id && (b.state || 'owned') !== 'sold').length;
    const limitReached = limit != null && builtCount >= limit;
    const limitLabel = limit != null ? `<span>Построено: ${builtCount}/${limit}</span>` : '';
    const item = document.createElement('div');
    item.className = 'build-item' + (locked ? ' locked' : '') + (limitReached ? ' limit-reached' : '');
    item.innerHTML = `
      <div class="build-item-top">
        <span class="build-item-name">${BUILDING_ICONS[def.id] || ''} ${displayBuildingName(def.id)}</span>
        <span class="build-item-cost">${def.cost.toLocaleString('ru-RU')} у.е.</span>
      </div>
      <div class="build-item-desc">${displayBuildingDesc(def.id)}</div>
      <div class="build-item-meta">
        <span>${def.minLevel > 0 ? `Ур. ${def.minLevel}+` : 'Стартовое'}</span>
        <span>Доход: +${def.income}/мин</span>
        ${def.reputation ? `<span>Репутация: +${def.reputation}/мин</span>` : ''}
        <span>XP: +${def.xp}</span>
        ${limitLabel}
      </div>
    `;
    if (!locked) {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary';
      btn.style.width = '100%';
      if (limitReached) {
        btn.textContent = `Лимит достигнут (${limit} шт.)`;
        btn.disabled = true;
      } else {
        btn.textContent = tooExpensive ? 'Недостаточно средств' : 'Построить здесь';
        btn.disabled = tooExpensive;
        btn.addEventListener('click', () => build(def.id));
      }
      item.appendChild(btn);
    }
    menu.appendChild(item);
  });
}

async function build(buildingId) {
  try {
    const state = await api('/api/build', 'POST', { cellIndex: selectedCell, buildingId });
    STATE = state;
    selectedCell = null;
    renderAll();
    renderTerritoryBuildMenu();
    toast('Построено!');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#buyLandBtn').addEventListener('click', async () => {
  try {
    const state = await api('/api/buy-land', 'POST');
    STATE = state;
    renderAll();
    toast('Территория расширена!');
  } catch (err) {
    toast(err.message, true);
  }
});

// ===== BUILDING MODAL (аренда / продажа / выкуп / снос) =====
let buildingModalCell = null;
let accRentView = 'menu';       // 'menu' | 'exchange' — под-вид аккордеона (аренда)
let accRentOffers = null;

function openBuildingModal(cellIndex) {
  buildingModalCell = cellIndex;
  rentView = 'menu';
  rentOffers = null;
  $('#bmMsg').textContent = '';
  renderBuildingModal();
  $('#buildingModal').classList.remove('hidden');
}

function closeBuildingModal() {
  $('#buildingModal').classList.add('hidden');
  buildingModalCell = null;
}

$('#closeBuildingModal').addEventListener('click', closeBuildingModal);

let rentOffers = null;   // офферы ботов, загруженные для текущей открытой биржи
let rentView = 'menu';    // 'menu' | 'exchange' — какой экран показываем внутри модалки

function renderBuildingModal() {
  const building = STATE.buildings.find(b => b.cellIndex === buildingModalCell);
  if (!building) { closeBuildingModal(); return; }

  const def = STATE.catalog[building.buildingId];
  const state = building.state || 'owned';

  $('#bmTitle').textContent = `${displayBuildingName(building.buildingId).toUpperCase()} ${toRoman(building.upgradeLevel)}`;
  const bmSurface = $('#bmSurface');
  if (bmSurface) {
    const detail = levelDetailText(building.buildingId, building.upgradeLevel);
    bmSurface.textContent = detail;
    bmSurface.classList.toggle('hidden', !detail);
  }
  $('#bmDesc').textContent = displayBuildingDesc(building.buildingId);

  const statusLabels = {
    owned: 'В СОБСТВЕННОСТИ',
    listed: `НА БИРЖЕ — ждём предложений (ваша цена: ${building.listedPrice} у.е./мин)`,
    rented: `СДАНО В АРЕНДУ — ${building.botName || 'бот'} (${building.rentPrice} у.е./мин)`,
    sold: `ПРОДАНО ${building.botName || ''}`,
  };
  // если идут работы — статус про них
  const working = building.constructionType;
  if (working === 'build') {
    $('#bmStatus').textContent = `СТРОИТСЯ — готово на ${Math.round(constructionProgress(building) * 100)}%`;
  } else if (working === 'upgrade') {
    $('#bmStatus').textContent = `УЛУЧШАЕТСЯ до ур. ${building.pendingUpgradeLevel} — готово на ${Math.round(constructionProgress(building) * 100)}%`;
  } else {
    $('#bmStatus').textContent = statusLabels[state];
  }

  const stats = $('#bmStats');
  const econ = STATE.botEconomy;
  const upgradeLine = `<span>Уровень апгрейда: ${building.upgradeLevel}/${building.maxUpgradeLevel}${building.nextUpgradeCost ? ` · след. за ${building.nextUpgradeCost.toLocaleString('ru-RU')} у.е.` : ' (макс.)'}</span>`;

  if (working === 'build') {
    stats.innerHTML = `<div class="bm-progress">${progressRing(constructionProgress(building), 56)}<span>Идёт строительство. Здание начнёт работать после завершения.</span></div>`;
  } else if (working === 'upgrade') {
    stats.innerHTML = `<div class="bm-progress">${progressRing(constructionProgress(building), 56)}<span>Идёт улучшение до уровня ${building.pendingUpgradeLevel}. Пока показатели снижены.</span></div>${upgradeLine}`;
  } else if (!def.removable) {
    stats.innerHTML = `<span>Обязательное здание — нельзя сдать в аренду или снести</span>${upgradeLine}`;
  } else if (state === 'owned') {
    let fuelInfo = '';
    if (building.buildingId === 'fuel_depot' && STATE.fuel) {
      const f = STATE.fuel;
      const pct = f.capacity > 0 ? Math.round(f.stored / f.capacity * 100) : 0;
      fuelInfo = `
        <div class="bm-fuel">
          <span>Топливо аэропорта: ${f.stored.toLocaleString('ru-RU')} / ${f.capacity.toLocaleString('ru-RU')} ед. (${pct}%)</span>
          <div class="bm-fuel-bar"><div class="bm-fuel-fill" style="width:${pct}%"></div></div>
          <span class="bm-fuel-note">Запас общий для всех складов аэропорта. Открой топливную биржу, чтобы пополнить и выбрать поставщика.</span>
        </div>`;
    }
    stats.innerHTML = `
      <span>Доход: +${def.income}/мин (с учётом апгрейда)</span>
      ${upgradeLine}
      <span>Снос: +${Math.round(def.cost * econ.DEMOLISH_REFUND_RATE).toLocaleString('ru-RU')} у.е.</span>
      ${fuelInfo}
    `;
  } else if (state === 'listed') {
    stats.innerHTML = `<span>Пока на бирже — дохода нет, ждём решения ботов</span>`;
  } else if (state === 'rented') {
    stats.innerHTML = `<span>Сейчас приносит: +${building.rentPrice}/мин</span>${upgradeLine}`;
  } else if (state === 'sold') {
    stats.innerHTML = `<span>Выкуп обратно: ${def.cost.toLocaleString('ru-RU')} у.е.</span>`;
  }

  const actions = $('#bmActions');
  actions.innerHTML = '';

  // во время работ никаких действий — только ждём
  if (working) {
    const hint = document.createElement('div');
    hint.className = 'build-menu-hint';
    hint.textContent = working === 'build'
      ? 'Дождитесь окончания строительства.'
      : 'Дождитесь окончания улучшения.';
    actions.appendChild(hint);
    return;
  }

  if (state === 'owned' && building.nextUpgradeCost) {
    const canAffordUpgrade = STATE.money >= building.nextUpgradeCost;
    const upgradeBtn = actionBtn(
      canAffordUpgrade ? `Улучшить до ${toRoman(building.upgradeLevel + 1)} (${building.nextUpgradeCost.toLocaleString('ru-RU')} у.е.)` : 'Недостаточно средств для апгрейда',
      () => buildingAction('upgrade')
    );
    upgradeBtn.disabled = !canAffordUpgrade;
    actions.appendChild(upgradeBtn);
  }

  // для топливного склада — кнопка открытия биржи поставщиков
  if (building.buildingId === 'fuel_depot' && state === 'owned') {
    const fuelBtn = actionBtn('⛽ Топливная биржа', openFuelExchange);
    actions.appendChild(fuelBtn);
  }

  if (!def.removable) {
    // кроме апгрейда (уже добавлен выше) — больше действий нет
  } else if (state === 'owned' && rentView === 'exchange') {
    renderExchangeView(actions, building, def, econ);
  } else if (state === 'owned') {
    if (!isNonRentable(building.buildingId)) {
      actions.appendChild(actionBtn('Сдать в аренду', openExchange));
    }
    actions.appendChild(actionBtn('Снести', () => buildingAction('demolish'), true));
  } else if (state === 'listed') {
    actions.appendChild(actionBtn('Снять с биржи (вернуть себе)', () => buildingAction('rent-cancel-listing')));
  } else if (state === 'rented') {
    actions.appendChild(actionBtn('Вернуть себе (расторгнуть аренду)', () => buildingAction('unrent')));
  } else if (state === 'sold') {
    const canAfford = STATE.money >= def.cost;
    const btn = actionBtn(
      canAfford ? `Выкупить обратно (${def.cost.toLocaleString('ru-RU')} у.е.)` : 'Недостаточно средств для выкупа',
      () => buildingAction('buyback')
    );
    btn.disabled = !canAfford;
    actions.appendChild(btn);
  }
}

// Рендер панели управления зданием ВНУТРИ контейнера (для аккордеона).
// Переиспользует ту же логику, что модалка, но пишет в переданный элемент.
function renderBuildingPanel(cellIndex, container) {
  const building = STATE.buildings.find(b => b.cellIndex === cellIndex);
  if (!building) { container.innerHTML = ''; return; }
  const def = STATE.catalog[building.buildingId];
  const state = building.state || 'owned';
  const econ = STATE.botEconomy;
  const working = building.constructionType;

  // Заголовок статуса
  let statusText;
  if (working === 'build') statusText = `СТРОИТСЯ — готово на ${Math.round(constructionProgress(building) * 100)}%`;
  else if (working === 'upgrade') statusText = `УЛУЧШАЕТСЯ до ур. ${building.pendingUpgradeLevel} — ${Math.round(constructionProgress(building) * 100)}%`;
  else statusText = ({
    owned: 'В СОБСТВЕННОСТИ',
    listed: `НА БИРЖЕ — ждём предложений (${building.listedPrice} у.е./мин)`,
    rented: `СДАНО В АРЕНДУ — ${building.botName || 'бот'} (${building.rentPrice} у.е./мин)`,
    sold: `ПРОДАНО ${building.botName || ''}`,
  })[state];

  const upgradeLine = `<span>Уровень: ${building.upgradeLevel}/${building.maxUpgradeLevel}${building.nextUpgradeCost ? ` · след. за ${building.nextUpgradeCost.toLocaleString('ru-RU')} у.е.` : ' (макс.)'}</span>`;

  // Блок статистики (как в модалке)
  let statsHtml = '';
  const isInfra = def.infrastructure;
  if (working === 'build') {
    statsHtml = `<div class="bm-progress">${progressRing(constructionProgress(building), 56)}<span>Идёт строительство.</span></div>`;
  } else if (working === 'upgrade') {
    statsHtml = `<div class="bm-progress">${progressRing(constructionProgress(building), 56)}<span>Идёт улучшение до ур. ${building.pendingUpgradeLevel}.</span></div>${upgradeLine}`;
  } else if (!def.removable) {
    statsHtml = `<span>Обязательное здание — нельзя сдать или снести</span>${upgradeLine}`;
  } else if (state === 'owned') {
    let fuelInfo = '';
    if (building.buildingId === 'fuel_depot' && STATE.fuel) {
      const f = STATE.fuel;
      const pct = f.capacity > 0 ? Math.round(f.stored / f.capacity * 100) : 0;
      fuelInfo = `<div class="bm-fuel"><span>Топливо: ${f.stored.toLocaleString('ru-RU')} / ${f.capacity.toLocaleString('ru-RU')} ед. (${pct}%)</span><div class="bm-fuel-bar"><div class="bm-fuel-fill" style="width:${pct}%"></div></div></div>`;
    }
    // инфраструктура (income 0) — показываем статус, не "+0/мин"
    const incomeLine = isInfra
      ? `<span>${infraStatusText(building)}</span>`
      : `<span>Доход: +${Math.round(def.income * upgradeMult(building.upgradeLevel))}/мин</span>`;
    statsHtml = `${incomeLine}${upgradeLine}<span>Снос: +${Math.round(def.cost * econ.DEMOLISH_REFUND_RATE).toLocaleString('ru-RU')} у.е.</span>${fuelInfo}`;
  } else if (state === 'listed') {
    statsHtml = `<span>На бирже — дохода нет, ждём ботов</span>`;
  } else if (state === 'rented') {
    statsHtml = `<span>Приносит: +${building.rentPrice}/мин</span>${upgradeLine}`;
  } else if (state === 'sold') {
    statsHtml = `<span>Выкуп обратно: ${def.cost.toLocaleString('ru-RU')} у.е.</span>`;
  }

  // Состояние объекта — видно всегда, включая «Исправно», чтобы игрок мог
  // осматривать здания и понимать, где всё в порядке.
  let condHtml = '';
  if (!working && (state === 'owned' || building.ruined)) {
    const d = damageState(building);
    const eff = damageEffectText(building, def);
    condHtml = `<div class="acc-condition ${d.cls}">
      <span class="acc-condition-label">${d.mark ? d.mark + ' ' : ''}${escapeHtml(d.label)}</span>
      ${eff ? `<span class="acc-condition-eff">${escapeHtml(eff)}</span>` : ''}
    </div>`;
  }

  container.innerHTML = `
    <div class="acc-header"><span class="acc-status">${statusText}</span></div>
    ${condHtml}
    <div class="acc-stats">${statsHtml}</div>
    <div class="acc-actions"></div>
    <div class="acc-msg form-msg"></div>
  `;
  const actions = container.querySelector('.acc-actions');

  if (working) {
    actions.innerHTML = `<div class="build-menu-hint">${working === 'build' ? 'Дождитесь окончания строительства.' : 'Дождитесь окончания улучшения.'}</div>`;
    return;
  }

  if (state === 'owned' && building.nextUpgradeCost && building.repairCost > 0) {
    // Сначала ремонт: иначе апгрейд стал бы способом чинить в обход механики.
    const hint = document.createElement('div');
    hint.className = 'build-menu-hint';
    hint.textContent = 'Апгрейд недоступен, пока объект повреждён — сначала ремонт.';
    actions.appendChild(hint);
  } else if (state === 'owned' && building.nextUpgradeCost) {
    const canAfford = STATE.money >= building.nextUpgradeCost;
    const btn = actionBtn(canAfford ? `Улучшить до ${toRoman(building.upgradeLevel + 1)} (${building.nextUpgradeCost.toLocaleString('ru-RU')} у.е.)` : 'Недостаточно средств', () => buildingActionAcc(cellIndex, 'upgrade'));
    btn.disabled = !canAfford;
    actions.appendChild(btn);
  }
  if (building.buildingId === 'fuel_depot' && state === 'owned') {
    actions.appendChild(actionBtn('⛽ Топливная биржа', openFuelExchange));
  }
  // Состояние объекта: повреждение, ремонт, снос разрушенного
  if (building.ruined) {
    const cost = building.ruinedDemolishCost || 0;
    const btn = actionBtn(`💥 Снести развалины (${cost.toLocaleString('ru-RU')} у.е.)`, () => demolishRuined(cellIndex));
    actions.appendChild(btn);
  } else if (state === 'owned' && building.repairing) {
    const btn = actionBtn(`🚧 Ремонт идёт — ${building.repairTicksLeft} мин`, () => {});
    btn.disabled = true;
    actions.appendChild(btn);
  } else if (state === 'owned' && building.repairCost > 0) {
    const canAfford = STATE.money >= building.repairCost;
    const btn = actionBtn(
      canAfford
        ? `🔧 Отремонтировать — ${Math.round(building.wear * 100)}% (${building.repairCost.toLocaleString('ru-RU')} у.е.)`
        : `Не хватает средств на ремонт (${building.repairCost.toLocaleString('ru-RU')} у.е.)`,
      () => repairBuilding(cellIndex));
    btn.disabled = !canAfford;
    actions.appendChild(btn);
  }
  if (!def.removable) {
    // только апгрейд
  } else if (state === 'owned' && accRentView === 'exchange') {
    renderExchangeViewAcc(actions, cellIndex, building, def, econ);
  } else if (state === 'owned') {
    // вертолётки и стоянки нельзя сдавать в аренду (нужны для операций)
    if (!isNonRentable(building.buildingId)) {
      actions.appendChild(actionBtn('Сдать в аренду', () => openExchangeAcc(cellIndex)));
    }
    actions.appendChild(actionBtn('Снести', () => buildingActionAcc(cellIndex, 'demolish'), true));
  } else if (state === 'listed') {
    actions.appendChild(actionBtn('Снять с биржи', () => buildingActionAcc(cellIndex, 'rent-cancel-listing')));
  } else if (state === 'rented') {
    actions.appendChild(actionBtn('Вернуть себе (расторгнуть)', () => buildingActionAcc(cellIndex, 'unrent')));
  } else if (state === 'sold') {
    const canAfford = STATE.money >= def.cost;
    const btn = actionBtn(canAfford ? `Выкупить обратно (${def.cost.toLocaleString('ru-RU')} у.е.)` : 'Недостаточно средств', () => buildingActionAcc(cellIndex, 'buyback'));
    btn.disabled = !canAfford;
    actions.appendChild(btn);
  }
}

// Здания, которые нельзя сдавать в аренду (нужны для операций аэропорта):
// вертолётки и стоянки ВС. Флаг nonRentable задаётся в каталоге.
function isNonRentable(buildingId) {
  return !!STATE.catalog?.[buildingId]?.nonRentable;
}

// Вместимость конкретного инфраструктурного здания-места.
function slotCapacityOf(building) {
  const id = building.buildingId;
  const level = building.upgradeLevel || 1;
  // вертолётка: мест = уровень (ур.2 = 2 борта). Стоянка: всегда 1 место
  // (апгрейд стоянки меняет принимаемые размеры, а не число мест).
  if (id === 'helipad') return level * (STATE.apronEconomy?.HELIPAD_SLOTS_PER_LEVEL || 1);
  if (id.startsWith('stand')) return 1;
  return 1;
}

// Занятость КОНКРЕТНОЙ площадки (вариант B): общий счётчик занятых мест
// распределяется по площадкам одного типа по порядку (по cellIndex).
// Возвращает { used, total } для данного здания.
function slotOccupancyOf(building) {
  const id = building.buildingId;

  // Вертолётные площадки: сервер помнит, на какую именно площадку сел борт,
  // поэтому берём готовую занятость, а не распределяем общее число по порядку.
  // Вертолёт садится на любую свободную площадку, не обязательно на первую.
  if (id === 'helipad') {
    const pad = (STATE.helipadLoad || []).find(p => p.cellIndex === building.cellIndex);
    if (pad) return { used: pad.used, total: pad.capacity };
    return { used: 0, total: slotCapacityOf(building) };
  }

  // Стоянки ВС: одно место на стоянку, привязка борта известна с сервера.
  if (id.startsWith('stand')) {
    const total = slotCapacityOf(building);
    const used = (STATE.standLoad || []).filter(x => x.cellIndex === building.cellIndex).length;
    return { used: Math.min(used, total), total };
  }

  return { used: 0, total: slotCapacityOf(building) };
}

// Статус инфраструктурного здания вместо "+0/мин".
function infraStatusText(building) {
  const id = building.buildingId;
  if (id.startsWith('runway')) {
    // загрузка суточной квоты посадок этой полосы
    const rw = (STATE.runwayLoad || []).find(r => r.cellIndex === building.cellIndex);
    if (!rw) return '🛬 Работает';
    const wearPct = Math.round((rw.wear || 0) * 100);
    if (rw.repairing) return `🚧 Ремонт: ${rw.repairTicksLeft} мин · пропускная −70%`;
    const wearNote = wearPct >= 10 ? ` · износ ${wearPct}% ⚠️` : wearPct > 0 ? ` · износ ${wearPct}%` : '';
    const left = Math.max(0, rw.capacity - rw.used);
    if (left <= 0) return `🛬 Квота исчерпана (${rw.used}/${rw.capacity})${wearNote}`;
    if (rw.waitTicks > 0) return `🛬 Интервал вышки: ${rw.waitTicks} мин · ${rw.used}/${rw.capacity}${wearNote}`;
    return `🛬 Свободна · ${rw.used}/${rw.capacity} за сутки${wearNote}`;
  }
  if (id === 'helipad') {
    const o = slotOccupancyOf(building);
    return o.used > 0 ? `🚁 Занята (${o.used}/${o.total})` : `🚁 Свободна (0/${o.total})`;
  }
  if (id === 'tower') {
    const iv = STATE.towerInterval;
    return iv ? `📡 Интервал между операциями: ${iv} мин` : '📡 Работает';
  }
  if (id === 'hangar') return '🔧 Готов к ремонту';
  if (id.startsWith('stand')) {
    const o = slotOccupancyOf(building);
    return o.used > 0 ? `✈️ Занята (${o.used}/${o.total})` : `✈️ Свободна (0/${o.total})`;
  }
  return 'В работе';
}

async function repairBuilding(cellIndex) {
  try {
    const res = await api('/api/building/repair', 'POST', { cellIndex });
    STATE = res;
    const info = res._repair;
    toast(info
      ? `Ремонт начат: ${info.cost.toLocaleString('ru-RU')} у.е., ${info.ticks} мин. Объект работает на 30%.`
      : 'Ремонт начат');
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#eventModalOk')?.addEventListener('click', () => {
  $('#eventModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#repairAllBtn')?.addEventListener('click', repairAll);

// Кнопка общего ремонта: показываем только с нужного уровня и только когда
// действительно есть что чинить.
function renderRepairAllBar() {
  const bar = $('#repairAllBar');
  if (!bar) return;
  const damaged = (STATE.buildings || []).filter(b =>
    !b.ruined && !b.repairing && (b.repairCost || 0) > 0 && (b.state || 'owned') === 'owned');
  const minLevel = STATE.repairAllMinLevel || 7;
  if ((STATE.level || 1) < minLevel || !damaged.length) {
    bar.classList.add('hidden');
    return;
  }
  const total = damaged.reduce((sum, b) => sum + (b.repairCost || 0), 0);
  $('#repairAllBtn').textContent = `🔧 Отремонтировать всё — ${damaged.length} об. (${total.toLocaleString('ru-RU')} у.е.)`;
  $('#repairAllBtn').disabled = STATE.money < total;
  bar.classList.remove('hidden');
}

async function repairAll() {
  try {
    const res = await api('/api/building/repair-all', 'POST', {});
    STATE = res;
    const info = res._repair;
    toast(info
      ? `Ремонт ${info.count} объектов: ${info.cost.toLocaleString('ru-RU')} у.е., до ${info.ticks} мин.`
      : 'Ремонт начат');
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function demolishRuined(cellIndex) {
  try {
    const res = await api('/api/building/demolish-ruined', 'POST', { cellIndex });
    STATE = res;
    toast(`Развалины снесены за ${(res._demolish?.cost || 0).toLocaleString('ru-RU')} у.е. Клетка свободна.`);
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

// Действия из аккордеона (переиспользуют существующие эндпоинты).
async function buildingActionAcc(cellIndex, action) {
  try {
    const data = await api(`/api/building/${action}`, 'POST', { cellIndex });
    STATE = data.airport ? data.airport : data;
    if (action === 'demolish' || action === 'buyback') {
      if (action === 'demolish') openBuildingCells.delete(cellIndex);
    }
    renderAll();
    const messages = {
      unrent: 'Аренда расторгнута, здание снова ваше',
      buyback: 'Выкуплено обратно',
      'rent-cancel-listing': 'Снято с биржи',
      upgrade: 'Здание улучшено!',
      demolish: data._demolishNote || 'Здание снесено',
    };
    toast(messages[action] || 'Готово');
  } catch (err) {
    const msg = document.querySelector('.obj-accordion-row.open .acc-msg');
    if (msg) msg.textContent = err.message;
    toast(err.message, true);
  }
}

async function openExchangeAcc(cellIndex) {
  accRentView = 'exchange';
  accRentOffers = null;
  renderObjectsTable(true);
  try {
    const data = await api('/api/building/rent-offers', 'POST', { cellIndex });
    accRentOffers = data.offers;
    renderObjectsTable(true);
  } catch (err) {
    const msg = document.querySelector('.obj-accordion-row.open .acc-msg');
    if (msg) msg.textContent = err.message;
  }
}

function renderExchangeViewAcc(container, cellIndex, building, def, econ) {
  const wrap = document.createElement('div');
  wrap.className = 'exchange-view';
  wrap.innerHTML = '<div class="exchange-subtitle">Предложения ботов</div>';
  if (!accRentOffers) {
    wrap.innerHTML += '<div class="build-menu-hint">Опрашиваем биржу…</div>';
  } else if (accRentOffers.length === 0) {
    wrap.innerHTML += '<div class="build-menu-hint">Пока нет предложений. Попробуйте позже.</div>';
  } else {
    accRentOffers.forEach(offer => {
      const row = document.createElement('div');
      row.className = 'exchange-offer-row';
      row.innerHTML = `<span>${escapeHtml(offer.botName)}</span><span class="exchange-offer-price">${offer.price} у.е./мин</span>`;
      const btn = actionBtn('Принять', async () => {
        try {
          const data = await api('/api/building/rent-accept', 'POST', { cellIndex, botName: offer.botName, price: offer.price });
          STATE = data.airport;
          accRentView = 'menu';
          renderAll();
          toast(`Сдано в аренду: ${offer.botName}, ${offer.price} у.е./мин`);
        } catch (err) {
          const msg = document.querySelector('.obj-accordion-row.open .acc-msg');
          if (msg) msg.textContent = err.message;
        }
      });
      row.appendChild(btn);
      wrap.appendChild(row);
    });
  }
  const backBtn = actionBtn('← Назад', () => { accRentView = 'menu'; renderObjectsTable(true); });
  wrap.appendChild(backBtn);
  container.appendChild(wrap);
}

async function openExchange() {
  rentView = 'exchange';
  rentOffers = null;
  renderBuildingModal();
  try {
    const data = await api('/api/building/rent-offers', 'POST', { cellIndex: buildingModalCell });
    rentOffers = data.offers;
    renderBuildingModal();
  } catch (err) {
    $('#bmMsg').textContent = err.message;
  }
}

function renderExchangeView(container, building, def, econ) {
  const wrap = document.createElement('div');
  wrap.className = 'exchange-view';

  const offersTitle = document.createElement('div');
  offersTitle.className = 'exchange-subtitle';
  offersTitle.textContent = 'Предложения ботов';
  wrap.appendChild(offersTitle);

  if (!rentOffers) {
    const loading = document.createElement('div');
    loading.className = 'build-menu-hint';
    loading.textContent = 'Опрашиваем биржу…';
    wrap.appendChild(loading);
  } else {
    rentOffers.forEach(offer => {
      const row = document.createElement('div');
      row.className = 'exchange-offer-row';
      row.innerHTML = `<span>${escapeHtml(offer.botName)}</span><span class="exchange-offer-price">${offer.price} у.е./мин</span>`;
      const btn = actionBtn('Принять', () => acceptOffer(offer));
      row.appendChild(btn);
      wrap.appendChild(row);
    });
  }

  const divider = document.createElement('div');
  divider.className = 'exchange-divider';
  divider.textContent = 'или назначьте свою цену';
  wrap.appendChild(divider);

  const effectiveIncome = def.income * (1 + ((building.upgradeLevel || 1) - 1) * (STATE.upgradeEconomy?.INCOME_BONUS_PER_LEVEL || 0.3));
  const minPrice = Math.round(effectiveIncome * econ.RENT_LISTING_MIN_MULTIPLIER);
  const maxPrice = Math.round(effectiveIncome * econ.RENT_LISTING_MAX_MULTIPLIER);

  const listRow = document.createElement('div');
  listRow.className = 'exchange-list-row';
  listRow.innerHTML = `
    <input type="number" id="askPriceInput" min="${minPrice}" max="${maxPrice}" placeholder="${minPrice}–${maxPrice}" />
  `;
  const listBtn = actionBtn('Выставить на биржу', () => {
    const input = $('#askPriceInput');
    const val = Number(input.value);
    if (!val || val < minPrice || val > maxPrice) {
      $('#bmMsg').textContent = `Цена должна быть от ${minPrice} до ${maxPrice} у.е.`;
      return;
    }
    listOnExchange(val);
  });
  listRow.appendChild(listBtn);
  wrap.appendChild(listRow);

  const backBtn = actionBtn('Назад', () => { rentView = 'menu'; renderBuildingModal(); });
  wrap.appendChild(backBtn);

  container.appendChild(wrap);
}

async function acceptOffer(offer) {
  try {
    const data = await api('/api/building/rent-accept', 'POST', {
      cellIndex: buildingModalCell, botName: offer.botName, price: offer.price,
    });
    STATE = data.airport;
    rentView = 'menu';
    renderAll();
    renderBuildingModal();
    toast(`Сдано в аренду: ${offer.botName}, ${offer.price} у.е./мин`);
  } catch (err) {
    $('#bmMsg').textContent = err.message;
  }
}

async function listOnExchange(askPrice) {
  try {
    const data = await api('/api/building/rent-list', 'POST', { cellIndex: buildingModalCell, askPrice });
    STATE = data.airport;
    rentView = 'menu';
    renderAll();
    renderBuildingModal();
    toast('Выставлено на биржу — ждём решения ботов');
  } catch (err) {
    $('#bmMsg').textContent = err.message;
  }
}

function actionBtn(label, onClick, danger = false) {
  const btn = document.createElement('button');
  btn.className = 'btn-secondary' + (danger ? ' btn-danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function buildingAction(action) {
  try {
    const data = await api(`/api/building/${action}`, 'POST', { cellIndex: buildingModalCell });
    STATE = data.airport ? data.airport : data; // rent-* / unrent возвращают {building, airport}, остальные — сразу airport
    rentView = 'menu';
    renderAll();

    if (action === 'demolish') {
      closeBuildingModal();
      toast(data._demolishNote || 'Здание снесено');
    } else {
      renderBuildingModal();
      const messages = {
        'unrent': 'Аренда расторгнута, здание снова ваше',
        'sell': 'Продано',
        'buyback': 'Выкуплено обратно',
        'rent-cancel-listing': 'Снято с биржи, здание снова ваше',
        'upgrade': 'Здание улучшено!',
      };
      toast(messages[action] || 'Готово');
    }
  } catch (err) {
    $('#bmMsg').textContent = err.message;
    toast(err.message, true);
  }
}

// ===== LEADERBOARD =====
$('#leaderboardBtn').addEventListener('click', async () => {
  const rows = await api('/api/leaderboard');
  const body = $('#leaderboardBody');
  body.innerHTML = rows.length
    ? rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(r.username)}</td>
        <td>${r.start_type}</td>
        <td>${formatDuration(r.elapsed_seconds * 1000)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">Пока никто не достиг 10 уровня — будь первым!</td></tr>';
  $('#leaderboardModal').classList.remove('hidden');
});
$('#closeLeaderboard').addEventListener('click', () => $('#leaderboardModal').classList.add('hidden'));

// ===== TERRITORY MODAL =====
// гамбургер: показать/скрыть левое меню на телефоне
$('#menuToggle').addEventListener('click', () => {
  $('#leftMenu').classList.toggle('open');
});
// закрываем меню при клике на пункт (на телефоне)
document.querySelectorAll('.left-menu-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (window.innerWidth <= 700) $('#leftMenu').classList.remove('open');
  });
});

$('#territoryBtn').addEventListener('click', () => {
  selectedCell = null;
  renderGrid();
  renderStats(); // обновит кнопку "Выкупить землю"
  renderTerritoryBuildMenu();
  $('#territoryModal').classList.remove('hidden');
});
$('#closeTerritory').addEventListener('click', () => {
  $('#territoryModal').classList.add('hidden');
  exitSwapMode();
});

// ===== РЕЖИМ ПЕРЕСТАНОВКИ =====
$('#swapModeBtn').addEventListener('click', () => {
  swapMode = !swapMode;
  swapFirst = null;
  const btn = $('#swapModeBtn');
  const hint = $('#swapHint');
  btn.classList.toggle('active', swapMode);
  hint.classList.toggle('hidden', !swapMode);
  if (swapMode) {
    hint.textContent = 'Выберите первую клетку…';
    btn.textContent = '✕ Отменить перестановку';
  } else {
    btn.textContent = '↔ Поменять местами';
  }
  renderGrid();
});

function exitSwapMode() {
  swapMode = false;
  swapFirst = null;
  const btn = $('#swapModeBtn');
  const hint = $('#swapHint');
  if (btn) btn.classList.remove('active'), btn.textContent = '↔ Поменять местами';
  if (hint) hint.classList.add('hidden');
}

async function handleSwapClick(cellIndex) {
  if (swapFirst === null) {
    swapFirst = cellIndex;
    $('#swapHint').textContent = 'Теперь выберите вторую клетку…';
    renderGrid();
    return;
  }
  if (swapFirst === cellIndex) {
    // повторный клик по той же — отмена выбора
    swapFirst = null;
    $('#swapHint').textContent = 'Выберите первую клетку…';
    renderGrid();
    return;
  }
  const a = swapFirst, b = cellIndex;
  swapFirst = null;
  try {
    STATE = await api('/api/building/swap', 'POST', { cellA: a, cellB: b });
    renderAll();
    $('#swapHint').textContent = 'Готово! Выберите следующую пару или закройте режим.';
    toast('Объекты поменялись местами');
  } catch (err) {
    toast(err.message, true);
    renderGrid();
  }
}

// ===== FLEET MODAL (авиапарк) =====
$('#fleetBtn').addEventListener('click', openFleet);
$('#closeFleet').addEventListener('click', () => $('#fleetModal').classList.add('hidden'));

// ===== НАЗВАНИЕ АЭРОПОРТА =====
$('#airportNameSave').addEventListener('click', async () => {
  const name = $('#airportNameInput').value.trim();
  if (name.length < 2) { $('#airportNameMsg').textContent = 'Название от 2 до 40 символов'; return; }
  try {
    STATE = await api('/api/airport/name', 'POST', { name });
    $('#airportNameModal').classList.add('hidden');
    updateTopboard();
    renderAll();
    // если сразу доступно предложение АК — показываем
    if (STATE.airlineOfferAvailable) $('#airlineOfferModal').classList.remove('hidden');
  } catch (err) {
    $('#airportNameMsg').textContent = err.message;
  }
});

// ===== ПРЕДЛОЖЕНИЕ СОЗДАТЬ АК (5 уровень) =====
$('#airlineOfferAccept').addEventListener('click', () => {
  $('#airlineOfferModal').classList.add('hidden');
  $('#airlineNameModal').classList.remove('hidden');
});
$('#airlineOfferDismiss').addEventListener('click', async () => {
  try {
    STATE = await api('/api/airport/dismiss-airline-offer', 'POST');
    $('#airlineOfferModal').classList.add('hidden');
    updateAirlineButton();
  } catch (err) {
    $('#airlineOfferMsg').textContent = err.message;
  }
});

// ===== СОЗДАНИЕ АК =====
$('#createAirlineBtn').addEventListener('click', () => {
  $('#airlineNameModal').classList.remove('hidden');
});
$('#airlineNameSave').addEventListener('click', async () => {
  const name = $('#airlineNameInput').value.trim();
  if (name.length < 2) { $('#airlineNameMsg').textContent = 'Название от 2 до 40 символов'; return; }
  try {
    STATE = await api('/api/airport/create-airline', 'POST', { name });
    $('#airlineNameModal').classList.add('hidden');
    updateTopboard();
    renderAll();
    toast(`Авиакомпания «${STATE.airline}» создана! Теперь постройте офис авиакомпании, чтобы работать с самолётами.`);
  } catch (err) {
    $('#airlineNameMsg').textContent = err.message;
  }
});

// ===== ТОПЛИВНАЯ БИРЖА =====
let fuelData = null;

async function openFuelExchange() {
  try {
    fuelData = await api('/api/fuel');
    renderFuel();
    closeBuildingModal();  // закрываем окно склада, чтобы биржа не открывалась под ним
    $('#fuelModal').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFuel() {
  if (!fuelData) return;
  const pct = fuelData.capacity > 0 ? Math.round(fuelData.stored / fuelData.capacity * 100) : 0;
  const market = fuelData.marketMult || 1;
  const marketNote = market > 1.02 ? ` · рынок +${Math.round((market-1)*100)}%`
    : market < 0.98 ? ` · рынок ${Math.round((market-1)*100)}%` : '';
  $('#fuelSub').textContent = fuelData.contract
    ? `КОНТРАКТ · ${fuelData.unitPrice} у.е./ед (фикс.)`
    : (fuelData.supplier ? `ПОСТАВЩИК ВЫБРАН · ${fuelData.unitPrice} у.е./ед${marketNote}` : 'ВЫБЕРИТЕ ПОСТАВЩИКА');

  const space = fuelData.capacity - fuelData.stored;
  // считаем стоимость по количеству в поле ввода (или доверху)
  const input = $('#fuelAmountInput');
  let amount = parseInt(input.value, 10);
  if (!amount || amount < 1) amount = space;
  amount = Math.min(amount, space);
  const cost = Math.round(amount * fuelData.unitPrice);
  $('#fuelRefillCost').textContent = space > 0
    ? `${amount.toLocaleString('ru-RU')} ед. → ${cost.toLocaleString('ru-RU')} у.е.`
    : 'склад полон';
  $('#fuelRefillBtn').disabled = space <= 0;
  input.max = space;

  // ----- блок контракта -----
  const cb = $('#fuelContractBlock');
  if (!fuelData.canContract) {
    cb.innerHTML = '<div class="fuel-contract-locked">Контракт с поставщиком откроется на 3 уровне.</div>';
  } else if (fuelData.contract) {
    const c = fuelData.contract;
    const supName = (fuelData.suppliers.find(s => s.id === c.supplierId) || {}).name || c.supplierId;
    cb.innerHTML = `
      <div class="fuel-contract-active">
        <div class="fuel-contract-info">
          <span class="fuel-contract-title">📄 Контракт: ${escapeHtml(supName)}</span>
          <span class="fuel-contract-detail">Цена зафиксирована: ${c.pricePerUnit} у.е./ед · осталось ${c.daysLeft} сут.</span>
        </div>
        <button class="btn-secondary btn-danger" id="fuelContractCancel">Расторгнуть</button>
      </div>
      <div class="fuel-threshold-row">
        <span>Автодозаправка склада ниже:</span>
        <input type="number" id="fuelThresholdInput" min="0" max="100" value="${fuelData.refillThreshold}" />
        <span>%</span>
        <button class="btn-secondary" id="fuelThresholdSave">OK</button>
      </div>
      ${fuelData.canAuto ? `<label class="fuel-auto-row"><input type="checkbox" id="fuelAutoToggle" ${fuelData.autoContract ? 'checked' : ''}/> Авто-продление (случайный поставщик по окончании)</label>` : ''}
    `;
  } else {
    cb.innerHTML = `
      <div class="fuel-contract-hint">Заключите контракт с поставщиком — зафиксируете цену на ${fuelData.contractDurationDays} сут. (защита от роста). Выберите поставщика ниже и нажмите «Контракт».</div>
      ${fuelData.canAuto ? `<label class="fuel-auto-row"><input type="checkbox" id="fuelAutoToggle" ${fuelData.autoContract ? 'checked' : ''}/> Авто-продление (случайный поставщик по окончании)</label>` : ''}
    `;
  }
  const cancelBtn = $('#fuelContractCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelFuelContract);
  const autoToggle = $('#fuelAutoToggle');
  if (autoToggle) autoToggle.addEventListener('change', () => toggleFuelAuto(autoToggle.checked));
  const thrSave = $('#fuelThresholdSave');
  if (thrSave) thrSave.addEventListener('click', () => {
    const val = parseInt($('#fuelThresholdInput').value, 10);
    saveFuelThreshold(val);
  });

  // ----- поставщики -----
  const list = $('#fuelSuppliers');
  list.innerHTML = '';
  fuelData.suppliers.forEach(s => {
    const card = document.createElement('div');
    const isSelected = fuelData.supplier === s.id;
    const isContracted = fuelData.contract && fuelData.contract.supplierId === s.id;
    card.className = 'fuel-supplier-card' + (isSelected ? ' selected' : '');
    // показываем рыночную цену (и базовую, если отличается)
    const priceLabel = s.marketPrice !== s.pricePerUnit
      ? `${s.marketPrice} у.е./ед <span class="fuel-base-price">(база ${s.pricePerUnit})</span>`
      : `${s.pricePerUnit} у.е./ед`;
    card.innerHTML = `
      <div class="fuel-supplier-top">
        <span class="fuel-supplier-name">${escapeHtml(s.name)}${isContracted ? ' 📄' : ''}</span>
        <span class="fuel-supplier-price">${priceLabel}</span>
      </div>
      <div class="fuel-supplier-note">${escapeHtml(s.note)}</div>
      <div class="fuel-supplier-actions">
        <button class="btn-secondary" data-sup="${s.id}">${isSelected ? 'Выбран' : 'Выбрать'}</button>
        ${fuelData.canContract && !fuelData.contract ? `<button class="btn-secondary" data-contract="${s.id}">Контракт</button>` : ''}
      </div>
    `;
    const selBtn = card.querySelector('button[data-sup]');
    selBtn.disabled = isSelected;
    selBtn.addEventListener('click', () => selectFuelSupplier(s.id));
    const conBtn = card.querySelector('button[data-contract]');
    if (conBtn) conBtn.addEventListener('click', () => signFuelContract(s.id));
    list.appendChild(card);
  });
}

async function signFuelContract(supplierId) {
  try {
    fuelData = await api('/api/fuel/contract', 'POST', { supplierId });
    renderFuel();
    toast('Контракт заключён — цена зафиксирована');
  } catch (err) {
    toast(err.message, true);
  }
}

async function cancelFuelContract() {
  try {
    fuelData = await api('/api/fuel/contract/cancel', 'POST', {});
    renderFuel();
    toast('Контракт расторгнут');
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleFuelAuto(enabled) {
  try {
    fuelData = await api('/api/fuel/contract/auto', 'POST', { enabled });
    renderFuel();
    toast(enabled ? 'Авто-продление включено' : 'Авто-продление выключено');
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveFuelThreshold(threshold) {
  try {
    fuelData = await api('/api/fuel/threshold', 'POST', { threshold });
    renderFuel();
    toast(`Порог автодозаправки: ${fuelData.refillThreshold}%`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function selectFuelSupplier(supplierId) {
  try {
    fuelData = await api('/api/fuel/supplier', 'POST', { supplierId });
    renderFuel();
    toast('Поставщик выбран');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#fuelRefillBtn').addEventListener('click', async () => {
  try {
    const input = $('#fuelAmountInput');
    let amount = parseInt(input.value, 10);
    const body = (amount && amount > 0) ? { amount } : {};
    fuelData = await api('/api/fuel/refill', 'POST', body);
    input.value = '';
    renderFuel();
    STATE = await api('/api/state');
    renderAll();
    toast('Склад пополнен');
  } catch (err) {
    toast(err.message, true);
  }
});

// кнопки быстрого выбора количества (1/3, 1/2, полный)
document.querySelectorAll('.fuel-quick').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!fuelData) return;
    const frac = parseFloat(btn.dataset.frac);
    const amount = Math.floor(fuelData.capacity * frac);
    $('#fuelAmountInput').value = amount;
    renderFuel();
  });
});

// пересчёт стоимости при ручном вводе
$('#fuelAmountInput').addEventListener('input', () => renderFuel());
$('#closeFuel').addEventListener('click', () => $('#fuelModal').classList.add('hidden'));

// ===== КОНВЕРТ (договоры) =====
$('#envelopeBtn').addEventListener('click', openEnvelope);
$('#closeEnvelope').addEventListener('click', () => $('#envelopeModal').classList.add('hidden'));

let envelopeData = { offers: [], contracts: [], canAccept: false };

async function openEnvelope() {
  try {
    envelopeData = await api('/api/envelope');
    renderEnvelope();
    $('#envelopeModal').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  }
}

function renderEnvelope() {
  const offersEl = $('#envelopeOffers');
  const contractsEl = $('#envelopeContracts');
  const sub = $('#envelopeSub');
  if (sub) sub.textContent = `ПРЕДЛОЖЕНИЙ: ${envelopeData.offers.length} · ДОГОВОРОВ: ${envelopeData.contracts.length}`;

  offersEl.innerHTML = '';
  if (envelopeData.offers.length === 0) {
    offersEl.innerHTML = '<div class="envelope-empty">Пока нет новых предложений. Развивайте аэропорт и поднимайте репутацию — предложения будут приходить чаще и щедрее.</div>';
  } else {
    envelopeData.offers.forEach(o => offersEl.appendChild(renderOfferCard(o)));
  }

  contractsEl.innerHTML = '';
  if (envelopeData.contracts.length === 0) {
    contractsEl.innerHTML = '<div class="envelope-empty">Нет действующих договоров.</div>';
  } else {
    envelopeData.contracts.forEach(c => contractsEl.appendChild(renderContractCard(c)));
  }
}

function craftLabel(o) {
  if ((o.craft || 'heli') === 'heli') return '🚁 Вертолёт';
  const sizeNames = { small: 'малый', medium: 'средний', large: 'большой' };
  const line = o.flightType === 'mvl' ? 'МВЛ' : 'ВВЛ';
  return `✈️ Самолёт (${sizeNames[o.size] || o.size}, ${line})`;
}

function renderOfferCard(o) {
  const card = document.createElement('div');
  card.className = 'envelope-card' + (o.thinking ? ' thinking' : '');
  const thinkingNote = o.thinking ? '<span class="envelope-think-note">отложено</span>' : '';

  // если бот сделал встречное предложение — показываем его вместо обычных кнопок
  if (o.botCounter != null) {
    card.innerHTML = `
      <div class="envelope-card-top">
        <span class="envelope-airline">${escapeHtml(o.airline)}</span>
      </div>
      <div class="envelope-craft">${craftLabel(o)}</div>
      <div class="envelope-haggle-info">
        <span>Вы предложили: ${o.playerOffer} у.е.</span>
        <span class="envelope-counter">Поставщик готов на <b>${o.botCounter} у.е.</b> за прилёт</span>
      </div>
      <div class="envelope-card-actions">
        <button class="btn-secondary" data-act="haggleAccept" data-id="${o.id}">Согласиться (${o.botCounter})</button>
        <button class="btn-secondary btn-danger" data-act="decline" data-id="${o.id}">Отказаться</button>
      </div>
    `;
    card.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => envelopeAction(btn.dataset.act, Number(btn.dataset.id)));
    });
    return card;
  }

  card.innerHTML = `
    <div class="envelope-card-top">
      <span class="envelope-airline">${escapeHtml(o.airline)}</span>
      ${thinkingNote}
    </div>
    <div class="envelope-craft">${craftLabel(o)}</div>
    <div class="envelope-card-meta">
      <span class="envelope-pay">${o.payPerArrival} у.е. за прилёт</span>      <span>Срок: ${o.durationDays} сут.</span>
      <span>Истекает через ${formatMinutes(o.minutesLeft)}</span>
    </div>
    <div class="envelope-card-actions">
      <button class="btn-secondary" data-act="accept" data-id="${o.id}">Принимаю</button>
      <button class="btn-secondary" data-act="think" data-id="${o.id}" ${o.thinking ? 'disabled' : ''}>Подумаю</button>
      <button class="btn-secondary btn-danger" data-act="decline" data-id="${o.id}">Отклоняю</button>
    </div>
    <div class="envelope-haggle-row">
      <input type="number" class="envelope-haggle-input" placeholder="ваша цена" min="1" data-id="${o.id}" />
      <button class="btn-secondary" data-act="haggle" data-id="${o.id}">Торговаться</button>
    </div>
  `;
  card.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'haggle') {
        const input = card.querySelector('.envelope-haggle-input');
        const price = parseInt(input.value, 10);
        if (!price || price < 1) { toast('Введите цену для торга', true); return; }
        haggleOffer(Number(btn.dataset.id), price);
      } else {
        envelopeAction(btn.dataset.act, Number(btn.dataset.id));
      }
    });
  });
  return card;
}

async function haggleOffer(offerId, price) {
  try {
    const resp = await api('/api/envelope/haggle', 'POST', { offerId, price });
    envelopeData = resp;
    renderEnvelope();
    STATE = await api('/api/state');
    updateTopboard();
    if (resp.result === 'accepted') toast('Поставщик согласился на вашу цену!');
    else if (resp.result === 'counter') toast(`Встречное предложение: ${resp.counter} у.е.`);
    else if (resp.result === 'walked') toast('Поставщик счёл цену завышенной и ушёл', true);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderContractCard(c) {
  const card = document.createElement('div');
  card.className = 'envelope-card active';
  card.innerHTML = `
    <div class="envelope-card-top">
      <span class="envelope-airline">${escapeHtml(c.airline)}</span>
      <span class="envelope-active-badge">ДЕЙСТВУЕТ</span>
    </div>
    <div class="envelope-craft">${craftLabel(c)}</div>
    <div class="envelope-card-meta">
      <span class="envelope-pay">+${c.payPerArrival} у.е. за прилёт</span>      <span>Осталось: ${c.daysLeft} сут.</span>
    </div>
    <div class="envelope-card-actions">
      <button class="btn-secondary btn-danger" data-act="terminate" data-id="${c.id}">Расторгнуть</button>
    </div>
  `;
  card.querySelector('button').addEventListener('click', () => envelopeAction('terminate', c.id));
  return card;
}

function formatMinutes(mins) {
  if (mins >= 60) return `${Math.floor(mins / 60)} ч ${mins % 60} мин`;
  return `${mins} мин`;
}

async function envelopeAction(act, id) {
  try {
    const endpoint = {
      accept: '/api/envelope/accept', decline: '/api/envelope/decline',
      think: '/api/envelope/think', terminate: '/api/envelope/terminate',
      haggleAccept: '/api/envelope/haggle/accept',
    }[act];
    const body = act === 'terminate' ? { contractId: id } : { offerId: id };
    envelopeData = await api(endpoint, 'POST', body);
    renderEnvelope();
    // обновим состояние игры (индикатор в шапке, доход)
    STATE = await api('/api/state');
    updateTopboard();
    const msgs = { accept: 'Договор заключён!', decline: 'Предложение отклонено', think: 'Отложено — предложение подождёт', terminate: 'Договор расторгнут', haggleAccept: 'Договор заключён по договорной цене!' };
    toast(msgs[act] || 'Готово');
  } catch (err) {
    toast(err.message, true);
  }
}

// ===== БАНКРОТСТВО (game over) =====
$('#bankruptRestart').addEventListener('click', async () => {
  try {
    STATE = await api('/api/airport/restart', 'POST');
    $('#bankruptModal').classList.add('hidden');
    updateTopboard();
    renderAll();
    // после сброса снова просим название аэропорта
    $('#airportNameModal').classList.remove('hidden');
    toast('Аэропорт отстроен заново. Удачи!');
  } catch (err) {
    toast(err.message, true);
  }
});
$('#bankruptDelete').addEventListener('click', async () => {
  try {
    await api('/api/account/delete', 'POST');
    localStorage.removeItem('soul_journey_token');
    TOKEN = null;
    location.reload();
  } catch (err) {
    toast(err.message, true);
  }
});

function openFleet() {
  if (!STATE.airline) {
    toast('Сначала создайте авиакомпанию', true);
    if (STATE.level >= 5) $('#airlineNameModal').classList.remove('hidden');
    return;
  }
  if (!STATE.hasOffice) {
    toast('Постройте офис авиакомпании, чтобы работать с самолётами', true);
    return;
  }
  $('#fleetMsg').textContent = '';
  renderFleet();
  $('#fleetModal').classList.remove('hidden');
}

function renderFleet() {
  const slots = STATE.aircraftSlots || { used: 0, total: 0 };
  const runways = STATE.runways || 0;
  $('#fleetSub').textContent = `МЕСТА: ${slots.used}/${slots.total} · ВПП: ${runways}`;

  // --- список моих самолётов ---
  const list = $('#fleetList');
  list.innerHTML = '';
  const fleet = STATE.aircraft || [];
  if (fleet.length === 0) {
    list.innerHTML = '<div class="fleet-empty">Самолётов пока нет. Купите или возьмите в лизинг ниже.</div>';
  } else {
    fleet.forEach(ac => list.appendChild(renderFleetCard(ac)));
  }

  // --- магазин ---
  const shop = $('#fleetShop');
  shop.innerHTML = '';
  const types = STATE.aircraftTypes || {};
  Object.values(types).forEach(t => shop.appendChild(renderShopCard(t, slots)));
}

function renderFleetCard(ac) {
  const card = document.createElement('div');
  card.className = 'fleet-card' + (ac.decommissioned ? ' decommissioned' : '');

  const statusLabels = {
    idle: ac.serviceLeft > 0
      ? `<span class="fleet-status servicing">Обслуживание · готов через ${ac.serviceLeft} мин</span>`
      : '<span class="fleet-status idle">На стоянке · готов к вылету</span>',
    flying: `<span class="fleet-status flying">В рейсе ${ac.flightType === 'mvl' ? 'МВЛ' : 'ВВЛ'} · осталось ${ac.ticksLeft} мин</span>`,
    waiting: '<span class="fleet-status waiting">Кружит — нет ВПП!</span>',
    broken: '<span class="fleet-status broken">Сломан — нужен ремонт</span>',
  };
  const statusLabel = ac.decommissioned
    ? '<span class="fleet-status decom">СПИСАН — только продажа</span>'
    : (statusLabels[ac.status] || '');
  const ownership = ac.ownership === 'lease' ? 'Лизинг' : 'В собственности';
  const lineTypeLabel = ac.lineType === 'both' ? 'ВВЛ+МВЛ' : 'ВВЛ';

  let actions = '';
  if (ac.decommissioned) {
    // списанный можно только продать
    const sellLabel = ac.ownership === 'owned'
      ? `Продать (${ac.resalePrice.toLocaleString('ru-RU')} у.е.)`
      : 'Вернуть лизинг';
    actions += `<button class="btn-secondary btn-danger" data-act="sell" data-id="${ac.id}">${sellLabel}</button>`;
  } else {
    const autoLabel = ac.auto ? '⏸ Выкл. авто' : '▶ Авто-рейсы';
    actions += `<button class="btn-secondary ${ac.auto ? 'auto-on' : ''}" data-act="auto" data-id="${ac.id}">${autoLabel}</button>`;
    if (ac.status === 'idle') {
      if (ac.serviceLeft > 0) {
        // борт обслуживают после рейса — вылет пока невозможен
        const lvl = ac.standLevel ? ` (стоянка ур.${ac.standLevel})` : '';
        actions += `<span class="fleet-locked">Обслуживание${lvl} — ещё ${ac.serviceLeft} мин</span>`;
      } else if (!STATE.hasTower) {
        // без вышки полёты невозможны
        actions += `<span class="fleet-locked">Нужна вышка для полётов</span>`;
      } else {
        actions += `<button class="btn-secondary" data-act="fly-vvl" data-id="${ac.id}">В рейс ВВЛ</button>`;
        // МВЛ — только сертифицированные самолёты и при наличии инфраструктуры
        if (ac.lineType === 'both') {
          if (STATE.canFlyMvl) {
            actions += `<button class="btn-secondary mvl-btn" data-act="fly-mvl" data-id="${ac.id}">В рейс МВЛ (×1.6 доход)</button>`;
          } else {
            actions += `<span class="fleet-hint-mvl">МВЛ: нужен межд. терминал (C/E/F) + средняя/большая ВПП</span>`;
          }
        }
      }
    }
    // Апгрейд — если не максимальный уровень и самолёт на стоянке
    if (ac.status === 'idle' && ac.nextUpgradeCost != null) {
      actions += `<button class="btn-secondary" data-act="upgrade" data-id="${ac.id}">Улучшить до ур.${ac.upgradeLevel + 1} · ${ac.nextUpgradeCost.toLocaleString('ru-RU')} у.е. (мест ${ac.nextCapacity})</button>`;
    }
    if (ac.wear > 0 && ac.status !== 'flying' && ac.status !== 'waiting') {
      actions += `<button class="btn-secondary" data-act="repair" data-id="${ac.id}">Ремонт (${ac.repairCost.toLocaleString('ru-RU')} у.е.)</button>`;
    }
    if (ac.status === 'idle' || ac.status === 'broken') {
      if (ac.ownership === 'lease') {
        actions += `<button class="btn-secondary" data-act="buyout" data-id="${ac.id}">Выкупить (${ac.buyoutPrice.toLocaleString('ru-RU')} у.е.)</button>`;
      }
      const sellLabel = ac.ownership === 'owned'
        ? `Продать (${ac.resalePrice.toLocaleString('ru-RU')} у.е.)`
        : 'Вернуть лизинг';
      actions += `<button class="btn-secondary btn-danger" data-act="sell" data-id="${ac.id}">${sellLabel}</button>`;
    }
  }

  const wearClass = ac.wear >= 40 ? 'wear-high' : (ac.wear >= 20 ? 'wear-mid' : '');
  const decomPct = Math.round((ac.decommissionProgress || 0) * 100);
  card.innerHTML = `
    <div class="fleet-card-top">
      <span class="fleet-card-name">${escapeHtml(ac.typeName)}</span>
      ${statusLabel}
    </div>
    <div class="fleet-card-meta">
      <span>${ownership}</span>
      <span>${ac.capacity} мест · ур.${ac.upgradeLevel}/${ac.maxUpgradeLevel} · ${lineTypeLabel}</span>
      <span class="${wearClass}">Износ: ${ac.wear}%</span>
      ${ac.ownership === 'lease' ? `<span>Лизинг: −${ac.leasePerTick}/мин</span>` : ''}
      ${ac.auto ? '<span class="auto-badge">АВТО</span>' : ''}
    </div>
    <div class="decom-bar" title="Ресурс до списания: окупаемость 2×">
      <div class="decom-bar-fill" style="width:${decomPct}%"></div>
      <span class="decom-bar-label">До списания: ${decomPct}%</span>
    </div>
    <div class="fleet-card-actions">${actions}</div>
  `;

  card.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => fleetAction(btn.dataset.act, Number(btn.dataset.id)));
  });
  return card;
}

function renderShopCard(t, slots) {
  const card = document.createElement('div');
  card.className = 'fleet-shop-card';
  const locked = STATE.level < t.minLevel;
  // размер самолёта → есть ли под него свободная стоянка
  const size = t.id; // 'small' | 'medium' | 'large' совпадает с size
  const hasStand = STATE.standSpace ? STATE.standSpace[size] : false;
  const noStand = !hasStand;

  let actions = '';
  if (locked) {
    actions = `<span class="fleet-locked">Откроется на уровне ${t.minLevel}</span>`;
  } else {
    const canBuy = STATE.money >= t.buyCost && !noStand;
    const canLease = STATE.money >= t.leaseDeposit && !noStand;
    actions = `
      <button class="btn-secondary" data-buy="${t.id}" ${canBuy ? '' : 'disabled'}>Купить · ${t.buyCost.toLocaleString('ru-RU')} у.е.</button>
      <button class="btn-secondary" data-lease="${t.id}" ${canLease ? '' : 'disabled'}>Лизинг · ${t.leaseDeposit.toLocaleString('ru-RU')} + ${t.leasePerTick}/мин</button>
    `;
  }

  const standNames = { small: 'малую', medium: 'среднюю', large: 'большую' };
  card.innerHTML = `
    <div class="fleet-card-top">
      <span class="fleet-card-name">✈️ ${escapeHtml(t.name)}</span>
    </div>
    <div class="fleet-card-meta">
      <span>Мест: ${(t.capacityByLevel || [t.capacity]).join('/')} пасс.</span>
      <span>${t.lineType === 'both' ? 'ВВЛ + МВЛ' : 'только ВВЛ'}</span>
      <span>Баки: ${t.fuelTankHours || '?'} ч</span>
    </div>
    <div class="fleet-card-actions">${actions}</div>
    ${noStand && !locked ? `<div class="fleet-hint-warn">Нужна свободная ${standNames[size]} стоянка ВС (или большая с ур.3)</div>` : ''}
  `;

  card.querySelectorAll('button[data-buy]').forEach(b => b.addEventListener('click', () => acquireAircraft(b.dataset.buy, 'buy')));
  card.querySelectorAll('button[data-lease]').forEach(b => b.addEventListener('click', () => acquireAircraft(b.dataset.lease, 'lease')));
  return card;
}

async function acquireAircraft(typeId, mode) {
  try {
    const data = await api('/api/aircraft/acquire', 'POST', { typeId, mode });
    STATE = data.airport;
    renderAll();
    renderFleet();
    toast(mode === 'buy' ? 'Самолёт куплен' : 'Самолёт взят в лизинг');
  } catch (err) {
    $('#fleetMsg').textContent = err.message;
    toast(err.message, true);
  }
}

async function fleetAction(act, aircraftId) {
  try {
    if (act === 'fly' || act === 'fly-vvl') {
      STATE = await api('/api/aircraft/fly', 'POST', { aircraftId, flightType: 'vvl' });
      toast('Самолёт отправлен во внутренний рейс (ВВЛ)');
    } else if (act === 'fly-mvl') {
      STATE = await api('/api/aircraft/fly', 'POST', { aircraftId, flightType: 'mvl' });
      toast('Самолёт отправлен в международный рейс (МВЛ)');
    } else if (act === 'buyout') {
      STATE = await api('/api/aircraft/buyout', 'POST', { aircraftId });
      toast('Самолёт выкуплен в собственность');
    } else if (act === 'sell') {
      const data = await api('/api/aircraft/sell', 'POST', { aircraftId });
      STATE = data.airport;
      toast(data.payout > 0 ? `Продано за ${data.payout.toLocaleString('ru-RU')} у.е.` : 'Лизинг возвращён');
    } else if (act === 'auto') {
      STATE = await api('/api/aircraft/toggle-auto', 'POST', { aircraftId });
      const ac = (STATE.aircraft || []).find(a => a.id === aircraftId);
      toast(ac && ac.auto ? 'Авто-рейсы включены' : 'Авто-рейсы выключены');
    } else if (act === 'repair') {
      STATE = await api('/api/aircraft/repair', 'POST', { aircraftId });
      toast('Самолёт отремонтирован');
    } else if (act === 'upgrade') {
      STATE = await api('/api/aircraft/upgrade', 'POST', { aircraftId });
      toast('Самолёт улучшен — вместимость выросла');
    }
    renderAll();
    renderFleet();
  } catch (err) {
    $('#fleetMsg').textContent = err.message;
    toast(err.message, true);
  }
}

// ===== УНИВЕРСАЛЬНОЕ ЗАКРЫТИЕ МОДАЛОК =====
// Клик по фону (сам оверлей .modal, не его карточка) закрывает окно;
// крестик .modal-close тоже; плюс Escape закрывает верхнюю открытую модалку.
function closeModal(modal) {
  modal.classList.add('hidden');
  // спец-очистка для отдельных окон
  if (modal.id === 'territoryModal') { pendingBuildId = null; selectedCell = null; }
}

document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeModal(modal); // клик именно по фону-оверлею
  });
});

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) closeModal(modal);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal:not(.hidden)')];
  if (open.length) closeModal(open[open.length - 1]);
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Модальное окно происшествия. Блокирующее: закрывается только кнопкой,
// чтобы игрок точно прочитал, что случилось с аэропортом.
// Тексты — черновые, заказчик пришлёт свои варианты.
const EVENT_TEXTS = {
  meteor: {
    title: 'МЕТЕОРИТ', icon: '☄️',
    lines: [
      'Матрица вселенной разгневалась, и интерпретатор послал на ваш мир метеориты. Аэропорт получил повреждения — скорее проверьте свои здания!',
      'Небо прочертили огненные росчерки. Диспетчеры считают воронки, вы — убытки. Проверьте, что уцелело.',
      'Космос прислал незапланированный груз без накладных. Часть построек приняла его на себя.',
      'Вокруг вашего компьютера скопилось магнитное поле, которое повлияло на машинный код и вызвало падение метеорита на ваше здание. Вы понесли убытки — придётся выплатить компенсацию.',
    ],
  },
  earthquake: {
    title: 'ЗЕМЛЕТРЯСЕНИЕ', icon: '🌋',
    lines: [
      'Земля под аэропортом дрогнула. По стенам пошли трещины, где-то осыпалась облицовка. Обойдите здания и оцените ущерб.',
      'Толчки подняли пыль над полосами. Техника цела не везде — проверьте состояние объектов.',
      'Планета решила напомнить, кто здесь хозяин. Аэропорт устоял, но не весь.',
    ],
  },
  fire: {
    title: 'ПОЖАР', icon: '🔥',
    lines: [
      'В аэропорту вспыхнул пожар. Дым видно с диспетчерской вышки — проверьте, что осталось от построек.',
      'Огонь нашёл, чем поживиться. Чем быстрее осмотрите здания, тем меньше потеряете.',
    ],
  },
  flood: {
    title: 'НАВОДНЕНИЕ', icon: '🌊',
    lines: [
      'Вода вышла из берегов и добралась до перрона. Полосы и стоянки под ударом — оцените повреждения.',
      'Аэропорт по щиколотку в воде. Покрытие размыто, стоянки залиты. Проверьте объекты.',
    ],
  },
  birds: {
    title: 'ПТИЦЫ', icon: '🦅',
    lines: [
      'Стая птиц вышла на глиссаду одновременно с бортом. Без последствий не обошлось.',
      'Перелётные птицы выбрали для маршрута ваш аэропорт. Экипажи докладывают о столкновении.',
    ],
  },
  fire: {
    title: 'ПОЖАР', icon: '🔥',
    lines: [
      'Вокруг вашего компьютера скопилось магнитное поле, которое повлияло на машинный код и вызвало пожар в вашем здании. Вы понесли убытки — придётся выплатить компенсацию.',
      'Огонь нашёл, чем поживиться. Пожарные считают потери, вы — расходы. Проверьте, что уцелело.',
      'В аэропорту вспыхнул пожар. Дым видно с диспетчерской вышки — осмотрите постройки.',
    ],
  },
  storm: {
    title: 'МАГНИТНАЯ БУРЯ', icon: '🧲',
    lines: [
      'Магнитная буря сбивает приборы. Вышка и полосы работают вполсилы, пока всё не уляжется.',
      'Солнце устроило помехи. Диспетчеры разводят борта вручную — пропускная способность упала.',
    ],
  },
};

// Показ очереди происшествий: игрок заходит и первым делом узнаёт, что
// случилось, пока его не было. Окно блокирующее — закрывается только кнопкой.
let eventModalShown = false;
async function checkPendingDisasters() {
  const pending = STATE.pendingDisasters || [];
  if (!pending.length || eventModalShown) return;
  eventModalShown = true;
  // если событий несколько — показываем последнее, детали собираем со всех
  const last = pending[pending.length - 1];
  const details = pending.flatMap(p => p.details || []);
  showEventModal(last.kind, details);
  try {
    STATE = await api('/api/disasters/ack', 'POST', {});
  } catch (err) { /* не критично: покажем снова при следующем заходе */ }
  eventModalShown = false;
}

function showEventModal(kind, details) {
  const cfg = EVENT_TEXTS[kind] || EVENT_TEXTS.earthquake;
  const line = cfg.lines[Math.floor(Math.random() * cfg.lines.length)];
  $('#eventModalTitle').textContent = cfg.title;
  $('#eventModalIcon').textContent = cfg.icon;
  $('#eventModalText').textContent = line;
  const list = $('#eventModalList');
  if (details && details.length) {
    list.innerHTML = details.map(d => `<li>${escapeHtml(d)}</li>`).join('');
    list.classList.remove('hidden');
  } else {
    list.classList.add('hidden');
  }
  $('#eventModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

// Что именно теряется из-за повреждения — чтобы процент не был абстракцией.
function damageEffectText(building, def) {
  const w = building.wear || 0;
  if (building.ruined) return 'Не работает совсем';
  const mult = building.repairing ? Math.min(1 - w, 0.3) : 1 - w;
  const lostPct = Math.round((1 - mult) * 100);
  if (lostPct <= 0) return '';
  const parts = [];
  if (def.income > 0) parts.push(`доход −${lostPct}%`);
  if (def.reputation > 0) parts.push(`репутация −${lostPct}%`);
  if (building.buildingId === 'helipad') {
    const base = (building.upgradeLevel || 1);
    parts.push(`мест ${Math.max(1, Math.floor(base * mult))} из ${base}`);
  }
  if (def.standSize) {
    parts.push(w >= 0.5 ? 'борт не принимает' : 'принимает борт');
  }
  if (building.buildingId === 'tower') parts.push(`интервал +${Math.round((1 / mult - 1) * 100)}%`);
  if (def.isRunway) parts.push(`пропускная −${lostPct}%`);
  return parts.join(' · ');
}

// Состояние объекта по повреждению: слово, цвет, значок.
function damageState(building) {
  if (building.ruined) return { label: 'Разрушено', cls: 'ruined', mark: '💥' };
  const w = building.wear || 0;
  if (building.repairing) return { label: `Ремонт — ${building.repairTicksLeft} мин`, cls: 'repairing', mark: '🚧' };
  if (w >= 0.50) return { label: `Требует ремонта — ${Math.round(w * 100)}%`, cls: 'bad', mark: '🔧' };
  if (w >= 0.10) return { label: `Есть износ — ${Math.round(w * 100)}%`, cls: 'worn', mark: '·' };
  // Значка на иконке ещё нет, но говорить «Исправно» нечестно: показатели уже
  // просели. В панели пишем правду, на сетке пока не шумим.
  if (w >= 0.01) return { label: `Небольшой износ — ${Math.round(w * 100)}%`, cls: 'ok', mark: '' };
  return { label: 'Исправно', cls: 'ok', mark: '' };
}

// Покрытие и оснащение объекта на текущем уровне (сейчас есть у ВПП).
// Показывается отдельной строкой под названием, чтобы не раздувать описание.
function levelDetailText(buildingId, level) {
  const arr = STATE.catalog?.[buildingId]?.surfaceByLevel;
  if (!arr || !arr.length) return '';
  return arr[Math.min(Math.max((level || 1) - 1, 0), arr.length - 1)] || '';
}

function toRoman(n) {
  const map = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return map[n] || String(n);
}

function displayBuildingName(buildingId) {
  return STATE.buildingNames?.[buildingId] || STATE.catalog[buildingId].name;
}

function displayBuildingDesc(buildingId) {
  return STATE.buildingDescriptions?.[buildingId] || STATE.catalog[buildingId].desc;
}

function normalizeFontSize(value) {
  const trimmed = String(value).trim();
  return /^\d+(\.\d+)?$/.test(trimmed) ? `${trimmed}px` : trimmed;
}

// ===== INIT =====
loadBackgrounds(); // фоны экранов (вход виден сразу, до логина)
if (TOKEN) {
  bootAfterAuth();
} else {
  showScreen('authScreen');
}
