const API = '';
let TOKEN = localStorage.getItem('soul_journey_admin_token') || null;
let players = [];
let selectedUsername = null;
let selectedPlayer = null; // полный ответ /api/admin/players/:username
let cellModalIndex = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const BUILDING_ICONS = {
  admin: '🏢', helipad: '🚁', tower: '📡', runway_small: '🛬', terminal_a: '🏬',
  fuel_depot: '⛽', airline_office: '✈️', stand_small: '🅿️', stand_medium: '🅿️', stand_large: '🅿️', hangar: '🔧', runway_full: '🛫',
  cargo_terminal: '📦', fire_station: '🚒', terminal_b: '🏬', cafe: '☕', hotel: '🏨',
  runway_big: '🛬', vip_lounge: '💺', terminal_d: '🏬', conference_center: '🏢',
  cargo_hub: '📦', terminal_c: '🌍', terminal_e: '🌍', terminal_f: '🌐',
};

function showScreen(id) {
  ['authScreen', 'deniedScreen'].forEach(s => $(`#${s}`).classList.add('hidden'));
  $('#adminScreen').classList.add('hidden');
  if (id === 'adminScreen') {
    $('#adminScreen').classList.remove('hidden');
  } else {
    $(`#${id}`).classList.remove('hidden');
  }
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка запроса');
  return data;
}

// ===== AUTH =====
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/login', 'POST', {
      username: $('#loginUsername').value.trim(),
      password: $('#loginPassword').value,
    });
    TOKEN = data.token;
    localStorage.setItem('soul_journey_admin_token', TOKEN);
    if (!data.isAdmin) {
      showScreen('deniedScreen');
    } else {
      await enterAdmin();
    }
  } catch (err) {
    $('#loginMsg').textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem('soul_journey_admin_token');
  TOKEN = null;
  showScreen('authScreen');
}
$('#logoutBtn').addEventListener('click', logout);
$('#deniedLogoutBtn').addEventListener('click', logout);

async function boot() {
  if (!TOKEN) { showScreen('authScreen'); return; }
  try {
    const me = await api('/api/me');
    if (!me.isAdmin) { showScreen('deniedScreen'); return; }
    await enterAdmin();
  } catch (err) {
    logout();
  }
}

async function enterAdmin() {
  showScreen('adminScreen');
  const me = await api('/api/me');
  $('#adminWho').textContent = `Вы вошли как: ${me.username}`;
  await loadPlayers();
}

// ===== NAV =====
$('#navPlayersBtn').addEventListener('click', () => switchView('players'));
$('#navObjectsBtn').addEventListener('click', () => switchView('objects'));
$('#navGalleryBtn').addEventListener('click', () => switchView('gallery'));
$('#navSettingsBtn').addEventListener('click', () => switchView('settings'));

function switchView(view) {
  $('#navPlayersBtn').classList.toggle('active', view === 'players');
  $('#navObjectsBtn').classList.toggle('active', view === 'objects');
  $('#navGalleryBtn').classList.toggle('active', view === 'gallery');
  $('#navSettingsBtn').classList.toggle('active', view === 'settings');
  $('#playersView').classList.toggle('hidden', view !== 'players');
  $('#objectsView').classList.toggle('hidden', view !== 'objects');
  $('#galleryView').classList.toggle('hidden', view !== 'gallery');
  $('#settingsView').classList.toggle('hidden', view !== 'settings');
  if (view === 'gallery' && !galleryData) loadGallery();
  if (view === 'objects') loadObjectsSection();
  if (view === 'settings') { loadLogoSettings(); loadGameplaySettings(); loadBackgroundSettings(); }
}

// ===== НАСТРОЙКИ: ЛОГОТИП =====
async function loadLogoSettings() {
  try {
    const res = await api('/api/admin/media/logo');
    renderLogoSlots(res.current);
  } catch (err) { /* ignore */ }
}

async function loadGameplaySettings() {
  try {
    const s = await api('/api/admin/gameplay-settings');
    if ($('#oilPriceInput')) $('#oilPriceInput').value = s.oilPrice;
    if ($('#goldPriceInput')) $('#goldPriceInput').value = s.goldPrice;
    updateMarketMultInfo(s.fuelMarketMult);
  } catch (err) { /* ignore */ }
}

function updateMarketMultInfo(mult) {
  const el = $('#marketMultInfo');
  if (!el) return;
  const pct = Math.round((mult - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  el.textContent = `Текущий рыночный множитель топлива: ${mult} (${sign}${pct}% к базе)`;
}

$('#gameplaySaveBtn') && $('#gameplaySaveBtn').addEventListener('click', async () => {
  try {
    const oilPrice = Number($('#oilPriceInput').value);
    const goldPrice = Number($('#goldPriceInput').value);
    const s = await api('/api/admin/gameplay-settings', 'POST', { oilPrice, goldPrice });
    updateMarketMultInfo(s.fuelMarketMult);
    $('#gameplayMsg').textContent = 'Сохранено. Рыночный множитель обновлён.';
    setTimeout(() => { if ($('#gameplayMsg')) $('#gameplayMsg').textContent = ''; }, 3000);
  } catch (err) {
    $('#gameplayMsg').textContent = 'Ошибка: ' + err.message;
  }
});

// Логотип лежит в public/uploads/logo/: default.* — основной, small.* —
// необязательный компактный для узких экранов.
function renderLogoSlots(current) {
  const wrap = $('#logoPreviewWrap');
  if (!wrap) return;
  const slot = (variant, title, hint, url) => `
    <div style="display:inline-block;vertical-align:top;margin:0 20px 12px 0;">
      <div class="build-menu-hint" style="margin-bottom:6px;">${title}</div>
      <div style="min-height:70px;">
        ${url
          ? `<img src="${url}" alt="" style="height:64px;width:auto;max-width:200px;object-fit:contain;border-radius:6px;background:#0b0f14;padding:6px;" />`
          : '<span class="build-menu-hint">не установлен</span>'}
      </div>
      <div class="build-menu-hint" style="max-width:220px;margin:4px 0 6px;">${hint}</div>
      <input type="file" accept="image/*" class="logo-file" data-variant="${variant}" style="display:none;" />
      <button class="btn-secondary logo-upload" data-variant="${variant}">Загрузить</button>
      ${url ? `<button class="btn-secondary btn-danger logo-remove" data-variant="${variant}">Удалить</button>` : ''}
    </div>`;

  wrap.innerHTML =
    slot('default', 'ОСНОВНОЙ', 'Показывается в шапке игры.', current.default) +
    slot('small', 'КОМПАКТНЫЙ (необязательно)', 'Подставляется на экранах уже 640 px. Если не задан, везде основной.', current.small);

  wrap.querySelectorAll('.logo-upload').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelector(`.logo-file[data-variant="${btn.dataset.variant}"]`).click();
    });
  });
  wrap.querySelectorAll('.logo-file').forEach(input => {
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api('/api/admin/media/logo', 'POST', {
            variant: input.dataset.variant, dataUrl: reader.result,
          });
          renderLogoSlots(res.current);
          $('#logoMsg').textContent = 'Логотип сохранён. Игроки увидят его в шапке.';
        } catch (err) {
          $('#logoMsg').textContent = err.message;
        }
      };
      reader.onerror = () => { $('#logoMsg').textContent = 'Не удалось прочитать файл.'; };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
  });
  wrap.querySelectorAll('.logo-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('/api/admin/media/logo/remove', 'POST', { variant: btn.dataset.variant });
        renderLogoSlots(res.current);
        $('#logoMsg').textContent = 'Файл удалён.';
      } catch (err) {
        $('#logoMsg').textContent = err.message;
      }
    });
  });
}

// ===== ФОНЫ ЭКРАНОВ =====
// Фоны экранов лежат в папках public/uploads/screens/auth|game/.
// Файлов может быть несколько — игра при загрузке страницы берёт случайный.
let screenFiles = { auth: [], game: [] };

function renderScreenList(screen, wrapId) {
  const wrap = $('#' + wrapId);
  if (!wrap) return;
  const files = screenFiles[screen] || [];
  if (!files.length) {
    wrap.innerHTML = '<span class="build-menu-hint">Папка пуста — используется старый фон из настроек (если он был).</span>';
    return;
  }
  wrap.innerHTML = files.map(f => {
    const name = decodeURIComponent(f.url.split('?')[0].split('/').pop());
    const preview = f.kind === 'video'
      ? `<video src="${f.url}" autoplay loop muted playsinline style="height:90px;width:auto;max-width:160px;object-fit:cover;border-radius:6px;background:#0b0f14;"></video>`
      : `<img src="${f.url}" alt="" style="height:90px;width:auto;max-width:160px;object-fit:cover;border-radius:6px;background:#0b0f14;" />`;
    return `<div style="display:inline-flex;flex-direction:column;gap:4px;margin:0 10px 10px 0;vertical-align:top;">
        ${preview}
        <span class="build-menu-hint" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
        <button class="btn-secondary btn-danger screen-file-remove" data-screen="${screen}" data-file="${escapeAttr(name)}">Удалить</button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.screen-file-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('/api/admin/media/screen/remove', 'POST', {
          screen: btn.dataset.screen, filename: btn.dataset.file,
        });
        screenFiles[btn.dataset.screen] = res.files;
        renderScreenList(btn.dataset.screen, wrapId);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function loadBackgroundSettings() {
  try {
    const res = await api('/api/admin/media/screens');
    screenFiles = res;
    renderScreenList('auth', 'authBgPreviewWrap');
    renderScreenList('game', 'gameBgPreviewWrap');
  } catch (err) { /* ignore */ }
}

function wireBgUpload(screen, uploadBtnId, fileInputId, previewWrapId, msgId) {
  const upBtn = $('#' + uploadBtnId), fileInput = $('#' + fileInputId);
  if (!upBtn || !fileInput) return;
  upBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 8 * 1024 * 1024;
    if (file.size > maxBytes) {
      $('#' + msgId).textContent = isVideo
        ? `Видео слишком большое (${(file.size/1024/1024).toFixed(1)} МБ). Максимум 10 МБ — сожмите видео.`
        : `Картинка слишком большая (${(file.size/1024/1024).toFixed(1)} МБ). Максимум 8 МБ.`;
      fileInput.value = '';
      return;
    }
    $('#' + msgId).textContent = 'Загрузка…';
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api('/api/admin/media/screen', 'POST', {
          screen, dataUrl: reader.result, filename: file.name.replace(/\.[^.]+$/, ''),
        });
        screenFiles[screen] = res.files;
        renderScreenList(screen, previewWrapId);
        $('#' + msgId).textContent = isVideo ? 'Видео добавлено.' : 'Картинка добавлена.';
      } catch (err) {
        $('#' + msgId).textContent = err.message;
      }
      fileInput.value = '';
    };
    reader.onerror = () => { $('#' + msgId).textContent = 'Не удалось прочитать файл.'; fileInput.value = ''; };
    reader.readAsDataURL(file);
  });
}
wireBgUpload('auth', 'authBgUploadBtn', 'authBgFileInput', 'authBgPreviewWrap', 'authBgMsg');
wireBgUpload('game', 'gameBgUploadBtn', 'gameBgFileInput', 'gameBgPreviewWrap', 'gameBgMsg');

// ===== PLAYERS LIST =====
async function loadPlayers() {
  players = await api('/api/admin/players');
  renderPlayersList();
}

$('#playerSearch').addEventListener('input', renderPlayersList);

function renderPlayersList() {
  const query = $('#playerSearch').value.trim().toLowerCase();
  const list = $('#playersList');
  list.innerHTML = '';

  players
    .filter(p => p.username.toLowerCase().includes(query))
    .forEach(p => {
      const row = document.createElement('div');
      row.className = 'player-row' + (p.username === selectedUsername ? ' selected' : '');
      row.innerHTML = `
        <div class="player-row-top">
          <span class="player-row-name">${escapeHtml(p.username)}</span>
          ${p.isAdmin ? '<span class="player-badge admin">ADMIN</span>' : ''}
          ${p.banned ? '<span class="player-badge banned">БАН</span>' : ''}
        </div>
        <div class="player-row-meta">
          ${p.hasAirport
            ? `ур. ${p.level} · ${Math.floor(p.money).toLocaleString('ru-RU')} у.е. · сетка ${p.gridSize}×${p.gridSize}`
            : '<span class="player-badge no-airport">нет аэропорта</span>'}
        </div>
      `;
      row.addEventListener('click', () => selectPlayer(p.username));
      list.appendChild(row);
    });
}

async function selectPlayer(username) {
  selectedUsername = username;
  renderPlayersList();
  try {
    selectedPlayer = await api(`/api/admin/players/${encodeURIComponent(username)}`);
    renderPlayerDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

// ===== PLAYER DETAIL =====
function renderPlayerDetail() {
  const panel = $('#playerDetailPanel');
  const p = selectedPlayer;
  const a = p.airport;

  let banStatusText = 'Не забанен';
  if (p.banned) {
    banStatusText = p.bannedUntil === 'forever'
      ? 'Забанен навсегда'
      : `Забанен до ${new Date(p.bannedUntil).toLocaleString('ru-RU')}`;
  }

  panel.innerHTML = `
    <div class="detail-header">
      <h2>${escapeHtml(p.username)}</h2>
      ${p.isAdmin ? '<span class="player-badge admin">ADMIN</span>' : ''}
    </div>

    ${!a ? '<div class="empty-hint">У игрока ещё нет аэропорта — редактировать пока нечего.</div>' : `

    <div class="detail-section">
      <div class="detail-section-title">Основные показатели</div>
      <div class="field-row">
        <label>Деньги</label>
        <input type="number" id="fieldMoney" value="${Math.floor(a.money)}">
      </div>
      <div class="field-row">
        <label>XP</label>
        <input type="number" id="fieldXp" value="${Math.floor(a.xp)}">
      </div>
      <div class="field-row">
        <label>Уровень</label>
        <input type="number" id="fieldLevel" value="${a.level}" min="0" max="10">
      </div>
      <div class="field-row">
        <label>Размер сетки</label>
        <input type="number" id="fieldGrid" value="${a.gridSize}" min="1" max="20">
      </div>
      <div class="detail-actions">
        <button class="btn-primary" id="saveAllBtn">Сохранить</button>
        <button class="btn-secondary" id="revertBtn">Сбросить к последнему</button>
        <button class="btn-secondary btn-danger" id="resetBtn">Сбросить в исходное</button>
        ${p.isAdmin ? '' : '<button class="btn-danger" id="deleteBtn">Удалить игрока</button>'}
      </div>
      <div class="build-menu-hint" style="margin-top:8px;">«Сбросить к последнему» — вернуть поля к сохранённым значениям. «Сбросить в исходное» — обнулить игрока полностью (уровень 0, без зданий, сбрасывается и название аэропорта). «Удалить игрока» — полностью удаляет аккаунт со всеми данными.</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Территория — клик по клетке для назначения/снятия/переименования</div>
      <div class="admin-grid" id="adminGrid" style="grid-template-columns: repeat(${a.gridSize}, 1fr)"></div>
    </div>
    `}

    <div class="detail-section">
      <div class="detail-section-title">Бан</div>
      <div style="margin-bottom: 10px; font-size: 13px; color: var(--text-dim);">${banStatusText}</div>
      ${p.isAdmin ? '<div class="build-menu-hint">Администратора нельзя забанить</div>' : `
      <div class="ban-buttons">
        <button class="btn-secondary" id="ban5hBtn">Бан на 5 ч.</button>
        <button class="btn-secondary" id="ban1dBtn">Бан на 1 день</button>
        <button class="btn-danger btn-secondary" id="banForeverBtn">Бан навсегда</button>
        <button class="btn-secondary" id="unbanBtn">Разбанить</button>
      </div>
      `}
    </div>
  `;

  if (a) {
    renderAdminGrid();
    $('#saveAllBtn').addEventListener('click', saveAllFields);
    $('#revertBtn').addEventListener('click', revertFields);
    $('#resetBtn').addEventListener('click', resetPlayer);
  }
  if (!p.isAdmin && $('#deleteBtn')) {
    $('#deleteBtn').addEventListener('click', deletePlayer);
  }

  if (!p.isAdmin) {
    $('#ban5hBtn').addEventListener('click', () => banPlayer('5h'));
    $('#ban1dBtn').addEventListener('click', () => banPlayer('1d'));
    $('#banForeverBtn').addEventListener('click', () => banPlayer('forever'));
    $('#unbanBtn').addEventListener('click', unbanPlayer);
  }
}

async function saveAllFields() {
  try {
    const body = {
      money: Number($('#fieldMoney').value),
      xp: Number($('#fieldXp').value),
      level: Number($('#fieldLevel').value),
      gridSize: Number($('#fieldGrid').value),
    };
    const data = await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/save-all`, 'POST', body);
    toast(data.removedBuildings > 0
      ? `Сохранено. Снесено зданий за пределами сетки: ${data.removedBuildings}`
      : 'Сохранено');
    await refreshSelected();
    await loadPlayers();
  } catch (err) {
    toast(err.message, true);
  }
}

// "Сбросить к последнему" — просто перерисовать форму из сохранённого selectedPlayer,
// вернув поля к значениям, которые сейчас в БД (отменяет несохранённый ввод).
function revertFields() {
  renderPlayerDetail();
  toast('Поля возвращены к сохранённым значениям');
}

async function resetPlayer() {
  if (!confirm(`Полностью обнулить игрока «${selectedUsername}»? Все здания будут снесены, уровень и прогресс сброшены в исходное состояние, название аэропорта сброшено. Это необратимо.`)) return;
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/reset`, 'POST');
    toast('Игрок сброшен в исходное состояние');
    await refreshSelected();
    await loadPlayers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deletePlayer() {
  if (!confirm(`УДАЛИТЬ игрока «${selectedUsername}» полностью? Аккаунт и все его данные будут стёрты без возможности восстановления.`)) return;
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/delete`, 'POST');
    toast(`Игрок «${selectedUsername}» удалён`);
    selectedUsername = null;
    selectedPlayer = null;
    $('#playerDetailPanel').innerHTML = '<div class="build-menu-hint">Выберите игрока из списка слева.</div>';
    await loadPlayers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshSelected() {
  selectedPlayer = await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}`);
  renderPlayerDetail();
}

async function banPlayer(duration) {
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/ban`, 'POST', { duration });
    toast('Игрок забанен');
    await refreshSelected();
    await loadPlayers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function unbanPlayer() {
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/unban`, 'POST');
    toast('Игрок разбанен');
    await refreshSelected();
    await loadPlayers();
  } catch (err) {
    toast(err.message, true);
  }
}

// ===== ADMIN GRID =====
function renderAdminGrid() {
  const a = selectedPlayer.airport;
  const grid = $('#adminGrid');
  grid.innerHTML = '';

  const buildingByCell = {};
  a.buildings.forEach(b => buildingByCell[b.cellIndex] = b);

  for (let i = 0; i < a.gridSize * a.gridSize; i++) {
    const cell = document.createElement('div');
    cell.className = 'admin-cell';
    const b = buildingByCell[i];

    if (b) {
      const icon = b.customIcon || BUILDING_ICONS[b.buildingId] || '🏗️';
      if (/^https?:\/\/|^data:image/.test(icon)) {
        cell.innerHTML = `<img src="${icon}" alt="">`;
      } else {
        cell.textContent = icon;
      }
      cell.title = b.customName || a.catalog[b.buildingId]?.name || b.buildingId;
    } else {
      cell.classList.add('locked');
    }
    cell.addEventListener('click', () => openCellModal(i));
    grid.appendChild(cell);
  }
}

function openCellModal(cellIndex) {
  cellModalIndex = cellIndex;
  const a = selectedPlayer.airport;
  const building = a.buildings.find(b => b.cellIndex === cellIndex);

  $('#cellModalTitle').textContent = `КЛЕТКА №${cellIndex}`;
  $('#cellModalSub').textContent = building ? (a.catalog[building.buildingId]?.name || building.buildingId) : 'пусто';

  const body = $('#cellModalBody');
  const catalogOptions = Object.values(a.catalog)
    .filter(def => def.id !== 'admin' && def.id !== 'helipad')
    .map(def => `<option value="${def.id}">${def.name}</option>`).join('');

  body.innerHTML = `
    <div>
      <label style="font-size:12px;color:var(--text-dim);">Назначить здание</label>
      <select id="assignBuildingSelect">
        <option value="">— выбрать —</option>
        ${catalogOptions}
      </select>
    </div>
    <div class="cell-modal-actions">
      <button class="btn-primary" id="assignBtn">Назначить</button>
      ${building ? '<button class="btn-secondary btn-danger" id="removeBtn">Снять здание</button>' : ''}
    </div>
    ${building ? `
    <div style="border-top:1px dashed var(--line); padding-top:14px; margin-top:4px;">
      <label style="font-size:12px;color:var(--text-dim);">Своя иконка (эмодзи или URL картинки)</label>
      <input type="text" id="customIconInput" value="${escapeAttr(building.customIcon || '')}" placeholder="например 👑 или https://...">
      <label style="font-size:12px;color:var(--text-dim); margin-top:8px; display:block;">Своё название клетки</label>
      <input type="text" id="customNameInput" value="${escapeAttr(building.customName || '')}" placeholder="например «Тронный зал»">
      <div class="cell-modal-actions" style="margin-top:10px;">
        <button class="btn-secondary" id="saveCustomizeBtn">Сохранить оформление</button>
      </div>
    </div>` : ''}
  `;

  $('#assignBtn').addEventListener('click', async () => {
    const buildingId = $('#assignBuildingSelect').value;
    if (!buildingId) { toast('Выберите здание', true); return; }
    try {
      await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/assign-building`, 'POST', { cellIndex, buildingId });
      toast('Здание назначено');
      await refreshSelected();
      closeCellModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  if (building) {
    $('#removeBtn').addEventListener('click', async () => {
      try {
        await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/remove-building`, 'POST', { cellIndex });
        toast('Здание снято');
        await refreshSelected();
        closeCellModal();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $('#saveCustomizeBtn').addEventListener('click', async () => {
      try {
        await api(`/api/admin/players/${encodeURIComponent(selectedUsername)}/customize-cell`, 'POST', {
          cellIndex,
          customIcon: $('#customIconInput').value.trim(),
          customName: $('#customNameInput').value.trim(),
        });
        toast('Оформление сохранено');
        await refreshSelected();
        closeCellModal();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  $('#cellModal').classList.remove('hidden');
}

function closeCellModal() {
  $('#cellModal').classList.add('hidden');
  cellModalIndex = null;
}
$('#closeCellModal').addEventListener('click', closeCellModal);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ===== GALLERY =====
let galleryData = null; // { catalog, mediaLibrary, buildingMedia, buildingLabelStyles }
let selectedGalleryBuilding = null;
let mediaPickerTargetLevel = null; // при выборе картинки из медиатеки — для какого уровня она предназначена

const GALLERY_GROUPS = [
  { title: 'Администрация', ids: ['admin'] },
  { title: 'Вертолётная площадка', ids: ['helipad'] },
  { title: 'Вышка', ids: ['tower'] },
  { title: 'ВПП', ids: ['runway_small', 'runway_full', 'runway_big'] },
  { title: 'Терминалы', ids: ['terminal_a', 'terminal_b', 'terminal_c', 'terminal_d', 'terminal_e', 'terminal_f'] },
  { title: 'Инфраструктура', ids: ['fuel_depot', 'airline_office', 'stand_small', 'stand_medium', 'stand_large', 'hangar', 'cargo_terminal', 'fire_station', 'cafe', 'hotel', 'vip_lounge', 'conference_center', 'cargo_hub'] },
];

async function loadGallery() {
  galleryData = await api('/api/admin/gallery');
  renderGalleryCategories();
}

function renderGalleryCategories() {
  const container = $('#galleryCategories');
  container.innerHTML = '';

  GALLERY_GROUPS.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'gallery-category-group';
    const title = document.createElement('div');
    title.className = 'gallery-category-title';
    title.textContent = group.title;
    groupEl.appendChild(title);

    group.ids.forEach(id => {
      const def = galleryData.catalog[id];
      if (!def) return;
      const name = galleryData.buildingNames[id] || def.name;
      const btn = document.createElement('button');
      btn.className = 'gallery-building-btn' + (id === selectedGalleryBuilding ? ' selected' : '');
      btn.textContent = `${BUILDING_ICONS[id] || ''} ${name}`;
      btn.addEventListener('click', () => selectGalleryBuilding(id));
      groupEl.appendChild(btn);
    });

    container.appendChild(groupEl);
  });
}

function selectGalleryBuilding(buildingId) {
  selectedGalleryBuilding = buildingId;
  renderGalleryCategories();
  renderGalleryDetail();
}

function renderGalleryDetail() {
  const def = galleryData.catalog[selectedGalleryBuilding];
  const media = (galleryData.buildingMedia || {})[selectedGalleryBuilding] || { levels: {}, default: null };
  const currentName = galleryData.buildingNames[selectedGalleryBuilding] || def.name;
  const detail = $('#galleryDetail');

  // Что реально покажется в игре на этом уровне (та же логика, что на сервере).
  const resolve = (lvl) => {
    if (media.levels && media.levels[lvl]) return media.levels[lvl];
    const nums = Object.keys(media.levels || {}).map(Number).sort((a, b) => a - b);
    if (nums.length) {
      let best = null;
      for (const n of nums) if (n <= lvl) best = n;
      return media.levels[best != null ? best : nums[0]];
    }
    return media.default || null;
  };

  const card = (level, title, ownUrl, hint) => `
      <div class="gallery-level-card">
        <div class="gallery-level-preview" id="galleryPreview_${level}">
          ${ownUrl ? `<img src="${ownUrl}" alt="">` : (BUILDING_ICONS[selectedGalleryBuilding] || '🏗️')}
        </div>
        <div class="gallery-level-info">
          <div class="gallery-level-title">${title}</div>
          ${hint ? `<div class="build-menu-hint">${hint}</div>` : ''}
          <div class="gallery-level-actions">
            <label class="btn-secondary" style="cursor:pointer;">
              Загрузить
              <input type="file" accept="image/*" data-level="${level}" class="gallery-upload-input">
            </label>
            <button class="btn-secondary gallery-pick-btn" data-level="${level}">Выбрать из медиатеки</button>
            ${ownUrl ? `<button class="btn-secondary btn-danger gallery-clear-btn" data-level="${level}">Удалить файл</button>` : ''}
          </div>
        </div>
      </div>
    `;

  let levelsHtml = '';
  for (let level = 1; level <= def.maxUpgradeLevel; level++) {
    const own = media.levels ? media.levels[level] : null;
    let hint = '';
    if (!own) {
      const inherited = resolve(level);
      hint = inherited
        ? `Своего файла нет — покажется <code>${inherited.split('?')[0].split('/').pop()}</code>`
        : 'Файла нет — покажется стандартная иконка';
    }
    levelsHtml += card(level, `${currentName} — уровень ${toRoman(level)}`, own, hint);
  }
  levelsHtml += card('default', 'Запасная картинка (default)', media.default,
    'Используется для уровней, у которых нет ни своего файла, ни файла на уровень ниже');

  detail.innerHTML = `
    <h2>${currentName}</h2>
    <div class="build-menu-hint" style="margin-bottom:8px;">
      Файлы лежат в <code>public/uploads/buildings/${selectedGalleryBuilding}/</code> — можно класть их туда напрямую,
      имя файла = номер уровня (<code>1.png</code>, <code>2.jpg</code>) или <code>default</code>.
      Если уровень не нарисован, игра возьмёт картинку ближайшего меньшего уровня.
    </div>
    <div style="margin-bottom:16px;">
      <button class="btn-secondary" id="galleryRescanBtn">Пересканировать папки</button>
      <span class="build-menu-hint" id="galleryRescanMsg" style="margin-left:8px;"></span>
    </div>
    ${levelsHtml}
  `;

  $('#galleryRescanBtn').addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/media/rescan', 'POST');
      galleryData.buildingMedia = data.buildings;
      $('#galleryRescanMsg').textContent = 'Папки перечитаны.';
      renderGalleryDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  detail.querySelectorAll('.gallery-upload-input').forEach(input => {
    input.addEventListener('change', (e) => handleGalleryUpload(e, input.dataset.level));
  });
  detail.querySelectorAll('.gallery-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => openMediaPicker(btn.dataset.level));
  });
  detail.querySelectorAll('.gallery-clear-btn').forEach(btn => {
    btn.addEventListener('click', () => removeBuildingLevel(btn.dataset.level));
  });
}

// Загрузка файла сразу в папку здания (в медиатеку он больше не попадает —
// источник правды теперь файловая система).
function handleGalleryUpload(event, level) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await api('/api/admin/media/building', 'POST', {
        buildingId: selectedGalleryBuilding, level, dataUrl: reader.result,
      });
      galleryData.buildingMedia = data.buildings;
      toast('Картинка сохранена');
      renderGalleryDetail();
    } catch (err) {
      toast(err.message, true);
    }
  };
  reader.onerror = () => toast('Не удалось прочитать файл', true);
  reader.readAsDataURL(file);
  event.target.value = '';
}

// Копия картинки из медиатеки в папку здания.
async function assignSkin(level, url) {
  try {
    const data = await api('/api/admin/media/building', 'POST', {
      buildingId: selectedGalleryBuilding, level, sourceUrl: url,
    });
    galleryData.buildingMedia = data.buildings;
    toast('Картинка сохранена');
    renderGalleryDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeBuildingLevel(level) {
  try {
    const data = await api('/api/admin/media/building/remove', 'POST', {
      buildingId: selectedGalleryBuilding, level,
    });
    galleryData.buildingMedia = data.buildings;
    toast('Файл удалён');
    renderGalleryDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

// ===== РАЗДЕЛ "ОБЪЕКТЫ" =====
let objectsData = null;         // тот же ответ /api/admin/gallery
let selectedObjectBuilding = null;

// Порядок и группировка — как в игре/галерее
const OBJECTS_ORDER = [
  'admin', 'helipad', 'tower',
  'runway_small', 'runway_full', 'runway_big',
  'terminal_a', 'terminal_b', 'terminal_c', 'terminal_d', 'terminal_e', 'terminal_f',
  'fuel_depot', 'airline_office', 'stand_small', 'stand_medium', 'stand_large', 'hangar',
  'cargo_terminal', 'fire_station', 'cafe', 'hotel',
  'vip_lounge', 'conference_center', 'cargo_hub',
];

async function loadObjectsSection() {
  objectsData = await api('/api/admin/gallery'); // тот же эндпоинт, содержит всё нужное
  if (!selectedObjectBuilding) selectedObjectBuilding = OBJECTS_ORDER[0];
  renderObjectsSelect();
  renderObjectsEditorForm();
  renderObjectsAdminTable();
}

function renderObjectsSelect() {
  const sel = $('#objectsBuildingSelect');
  sel.innerHTML = OBJECTS_ORDER
    .filter(id => objectsData.catalog[id])
    .map(id => {
      const name = objectsData.buildingNames[id] || objectsData.catalog[id].name;
      return `<option value="${id}" ${id === selectedObjectBuilding ? 'selected' : ''}>${escapeHtml(name)}</option>`;
    }).join('');
  sel.onchange = () => {
    selectedObjectBuilding = sel.value;
    renderObjectsEditorForm();
  };
}

function renderObjectsEditorForm() {
  const id = selectedObjectBuilding;
  const def = objectsData.catalog[id];
  const currentName = objectsData.buildingNames[id] || def.name;
  const currentDesc = objectsData.buildingDescriptions[id] || def.desc;
  const labelStyle = objectsData.buildingLabelStyles[id] || {};

  $('#objectsEditorForm').innerHTML = `
    <div class="field-row">
      <label>Название объекта</label>
      <input type="text" id="objNameInput" value="${escapeAttr(currentName)}" placeholder="${escapeAttr(def.name)}">
    </div>
    <div class="field-row">
      <label>Описание</label>
      <textarea id="objDescInput" class="obj-desc-textarea" placeholder="${escapeAttr(def.desc)}">${escapeHtml(currentDesc)}</textarea>
    </div>
    <div class="field-row">
      <label>Размер шрифта</label>
      <input type="text" id="objFontSize" value="${escapeAttr(labelStyle.fontSize || '')}" placeholder="например 11px">
    </div>
    <div class="field-row">
      <label>Цвет текста</label>
      <input type="text" id="objColor" value="${escapeAttr(labelStyle.color || '')}" placeholder="например #ffb400">
    </div>
    <button class="btn-primary" id="objSaveBtn" style="width:100%;">Сохранить</button>
  `;
  $('#objSaveBtn').addEventListener('click', saveObjectSettings);
}

async function saveObjectSettings() {
  const id = selectedObjectBuilding;
  try {
    const name = $('#objNameInput').value.trim();
    const description = $('#objDescInput').value.trim();
    const fontSize = $('#objFontSize').value.trim();
    const color = $('#objColor').value.trim();

    const [renameData, descData, styleData] = await Promise.all([
      api('/api/admin/gallery/rename', 'POST', { buildingId: id, name }),
      api('/api/admin/gallery/describe', 'POST', { buildingId: id, description }),
      api('/api/admin/gallery/label-style', 'POST', { buildingId: id, fontSize, color }),
    ]);
    objectsData.buildingNames = renameData.buildingNames;
    objectsData.buildingDescriptions = descData.buildingDescriptions;
    objectsData.buildingLabelStyles = styleData.buildingLabelStyles;
    // синхронизируем и galleryData, если галерея уже была загружена
    if (galleryData) {
      galleryData.buildingNames = renameData.buildingNames;
      galleryData.buildingDescriptions = descData.buildingDescriptions;
      galleryData.buildingLabelStyles = styleData.buildingLabelStyles;
    }

    toast('Сохранено');
    renderObjectsSelect();
    renderObjectsAdminTable();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderObjectsAdminTable() {
  const tbody = $('#objectsAdminTableBody');
  tbody.innerHTML = '';

  OBJECTS_ORDER.filter(id => objectsData.catalog[id]).forEach(id => {
    const def = objectsData.catalog[id];
    const name = objectsData.buildingNames[id] || def.name;
    const desc = objectsData.buildingDescriptions[id] || def.desc;
    const income = def.income;
    const rep = def.reputation || 0;
    const actionParts = [`+${income} у.е./мин`];
    if (rep > 0) actionParts.push(`+${rep} реп./мин`);

    const tr = document.createElement('tr');
    tr.className = 'objects-row';
    tr.innerHTML = `
      <td class="obj-name">${escapeHtml(name)}</td>
      <td class="obj-desc">
        <input type="text" class="obj-desc-edit" data-id="${id}" value="${escapeAttr(desc)}" placeholder="${escapeAttr(def.desc)}">
      </td>
      <td class="obj-action">${actionParts.join('<br>')}</td>
    `;
    tbody.appendChild(tr);
  });

  // сохранение описания по Enter или потере фокуса
  tbody.querySelectorAll('.obj-desc-edit').forEach(input => {
    const save = async () => {
      const id = input.dataset.id;
      const description = input.value.trim();
      try {
        const data = await api('/api/admin/gallery/describe', 'POST', { buildingId: id, description });
        objectsData.buildingDescriptions = data.buildingDescriptions;
        if (galleryData) galleryData.buildingDescriptions = data.buildingDescriptions;
        if (id === selectedObjectBuilding) renderObjectsEditorForm();
        input.classList.add('saved-flash');
        setTimeout(() => input.classList.remove('saved-flash'), 600);
      } catch (err) {
        toast(err.message, true);
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  });
}

// ===== MEDIA PICKER =====
function openMediaPicker(level) {
  mediaPickerTargetLevel = level;
  const grid = $('#mediaGrid');
  grid.innerHTML = '';

  if (galleryData.mediaLibrary.length === 0) {
    grid.innerHTML = '<div class="empty-hint">Пока ничего не загружено — используйте «Загрузить»</div>';
  } else {
    [...galleryData.mediaLibrary].reverse().forEach(asset => {
      const item = document.createElement('div');
      item.className = 'media-grid-item';
      item.innerHTML = `<img src="${asset.url}" alt="${escapeAttr(asset.filename)}" title="${escapeAttr(asset.filename)}">`;
      item.addEventListener('click', async () => {
        await assignSkin(mediaPickerTargetLevel, asset.url);
        closeMediaPicker();
      });
      grid.appendChild(item);
    });
  }
  $('#mediaPickerModal').classList.remove('hidden');
}

function closeMediaPicker() {
  $('#mediaPickerModal').classList.add('hidden');
}
$('#closeMediaPicker').addEventListener('click', closeMediaPicker);

function toRoman(n) {
  const map = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return map[n] || String(n);
}

// ===== INIT =====
boot();
