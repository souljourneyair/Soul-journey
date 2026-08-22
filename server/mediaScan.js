// Сканер медиа-папок. Единственный источник правды по картинкам зданий
// и фонам экранов. Папка = ключ, имя файла = уровень.
//
//   public/uploads/buildings/<buildingId>/<level>.<ext>   (или default.<ext>)
//   public/uploads/screens/auth/<любое имя>.<ext>
//   public/uploads/screens/game/<любое имя>.<ext>
//
// Диск читается НЕ на каждый запрос: результат лежит в кэше, который
// обновляется по таймеру и по кнопке «Пересканировать» в админке.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BUILDINGS_DIR = path.join(PUBLIC_DIR, 'uploads', 'buildings');
const SCREENS_DIR = path.join(PUBLIC_DIR, 'uploads', 'screens');
const LOGO_DIR = path.join(PUBLIC_DIR, 'uploads', 'logo');
const SCREENS = ['auth', 'game'];
// Логотип: основной и необязательный компактный для узких экранов.
const LOGO_VARIANTS = ['default', 'small'];

const IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1 };
const VIDEO_EXT = { mp4: 1, webm: 1, ogv: 1, ogg: 1 };

const RESCAN_INTERVAL_MS = 30000; // авто-пересканирование раз в 30 сек

let cache = { buildings: {}, screens: { auth: [], game: [] }, logo: { default: null, small: null }, scannedAt: 0 };
let knownBuildingIds = [];

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

// Создаём папки под все здания и оба экрана, чтобы админу было куда класть
// файлы сразу после деплоя (пустые папки git не хранит — создаём в рантайме).
function ensureDirs(buildingIds) {
  knownBuildingIds = buildingIds.slice();
  fs.mkdirSync(BUILDINGS_DIR, { recursive: true });
  for (const id of knownBuildingIds) {
    fs.mkdirSync(path.join(BUILDINGS_DIR, id), { recursive: true });
  }
  for (const screen of SCREENS) {
    fs.mkdirSync(path.join(SCREENS_DIR, screen), { recursive: true });
  }
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

// ?v=<mtime> — чтобы браузер не показывал старую картинку после замены файла.
function urlFor(relDir, file, fullPath) {
  let stamp = 0;
  try { stamp = Math.floor(fs.statSync(fullPath).mtimeMs); } catch (e) { /* удалён между readdir и stat */ }
  return `/uploads/${relDir}/${encodeURIComponent(file)}?v=${stamp}`;
}

function scanBuildings() {
  const out = {};
  for (const id of knownBuildingIds) {
    const dir = path.join(BUILDINGS_DIR, id);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }

    const levels = {};
    const seen = {};       // уровень -> имя файла, чтобы поймать дубли
    let fallback = null;
    for (const file of files) {
      if (!IMAGE_EXT[extOf(file)]) continue;
      const base = path.basename(file, path.extname(file)).toLowerCase();
      const url = urlFor(`buildings/${id}`, file, path.join(dir, file));
      if (base === 'default') { fallback = url; continue; }
      if (/^\d+$/.test(base)) {
        // Два файла на один уровень (1.png и 1.webp) — какой победит, зависит от
        // порядка чтения папки. Предупреждаем: лишний нужно удалить.
        if (seen[base]) {
          console.warn(`[внимание] ${id}: на уровень ${base} приходится больше одного файла ` +
            `(${seen[base]}, ${file}). Показан будет ${file} — удалите лишний.`);
        }
        seen[base] = file;
        levels[Number(base)] = url;
      }
      // всё прочее игнорируем молча — можно держать в папке исходники
    }
    if (fallback || Object.keys(levels).length) out[id] = { levels, default: fallback };
  }
  return out;
}

function scanScreens() {
  const out = { auth: [], game: [] };
  for (const screen of SCREENS) {
    const dir = path.join(SCREENS_DIR, screen);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const file of files.sort()) {
      const ext = extOf(file);
      const kind = IMAGE_EXT[ext] ? 'image' : (VIDEO_EXT[ext] ? 'video' : null);
      if (!kind) continue;
      out[screen].push({ url: urlFor(`screens/${screen}`, file, path.join(dir, file)), kind });
    }
  }
  return out;
}

// Логотип. Основной файл — default.<ext>, компактный (необязательный) —
// small.<ext>. Если default нет, берём первую картинку в папке: так логотип
// заработает, даже если файл назвали как попало.
function scanLogo() {
  const out = { default: null, small: null };
  let files;
  try { files = fs.readdirSync(LOGO_DIR).sort(); } catch (e) { return out; }
  let firstAny = null;
  for (const file of files) {
    if (!IMAGE_EXT[extOf(file)]) continue;
    const base = path.basename(file, path.extname(file)).toLowerCase();
    const url = urlFor('logo', file, path.join(LOGO_DIR, file));
    if (base === 'default') out.default = url;
    else if (base === 'small') out.small = url;
    else if (!firstAny) firstAny = url;
  }
  if (!out.default) out.default = firstAny;
  return out;
}

function rescan() {
  cache = { buildings: scanBuildings(), screens: scanScreens(), logo: scanLogo(), scannedAt: Date.now() };
  return cache;
}

function init(buildingIds) {
  ensureDirs(buildingIds);
  rescan();
  const timer = setInterval(rescan, RESCAN_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return cache;
}

// Манифест для клиента: { buildingId: { levels: {1: url}, default: url } }.
function buildingsManifest() {
  return cache.buildings;
}

// Разрешение картинки для здания уровня N.
// Точный уровень → ближайший меньший → самый младший имеющийся → default → null.
// Логика продублирована на клиенте (app.js, resolveBuildingImage) — если правишь
// здесь, правь и там.
function resolveBuilding(buildingId, level) {
  const entry = cache.buildings[buildingId];
  if (!entry) return null;
  const lvl = Number(level) || 1;
  if (entry.levels[lvl]) return entry.levels[lvl];
  const nums = Object.keys(entry.levels).map(Number).sort((a, b) => a - b);
  if (nums.length) {
    let best = null;
    for (const n of nums) if (n <= lvl) best = n;
    return entry.levels[best != null ? best : nums[0]];
  }
  return entry.default || null;
}

// Один случайный фон из папки экрана. null — папка пуста (вызывающий код
// откатится на старый фон из настроек).
function pickScreenBackground(screen) {
  const pool = cache.screens[screen] || [];
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function listScreen(screen) {
  return (cache.screens[screen] || []).slice();
}

// { default, small } — null, если файла нет.
function getLogo() {
  return { default: cache.logo.default || null, small: cache.logo.small || null };
}

function listLogoFiles() {
  let files = [];
  try { files = fs.readdirSync(LOGO_DIR).sort(); } catch (e) { return []; }
  return files.filter(f => IMAGE_EXT[extOf(f)]).map(f => ({
    name: f,
    variant: ['default', 'small'].includes(path.basename(f, path.extname(f)).toLowerCase())
      ? path.basename(f, path.extname(f)).toLowerCase() : 'прочее',
    url: urlFor('logo', f, path.join(LOGO_DIR, f)),
  }));
}

function logoFilePath(variant, ext) {
  return path.join(LOGO_DIR, `${variant}.${ext}`);
}

// Удалить все расширения одного варианта (default.png, default.svg, ...).
function removeLogoVariant(variant) {
  const target = String(variant).toLowerCase();
  let files = [];
  try { files = fs.readdirSync(LOGO_DIR); } catch (e) { return 0; }
  let removed = 0;
  for (const file of files) {
    if (!IMAGE_EXT[extOf(file)]) continue;
    if (path.basename(file, path.extname(file)).toLowerCase() !== target) continue;
    try { fs.unlinkSync(path.join(LOGO_DIR, file)); removed++; } catch (e) { /* уже нет */ }
  }
  return removed;
}

// Куда писать файл при загрузке через админку.
function buildingFilePath(buildingId, level, ext) {
  return path.join(BUILDINGS_DIR, buildingId, `${level}.${ext}`);
}
function screenFilePath(screen, filename) {
  return path.join(SCREENS_DIR, screen, filename);
}

// Удалить все варианты уровня (1.png, 1.jpg, ...) — чтобы после замены
// расширения не осталось двух файлов на один уровень.
function removeBuildingLevel(buildingId, level) {
  const dir = path.join(BUILDINGS_DIR, buildingId);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return 0; }
  const target = String(level).toLowerCase();
  let removed = 0;
  for (const file of files) {
    if (!IMAGE_EXT[extOf(file)]) continue;
    if (path.basename(file, path.extname(file)).toLowerCase() !== target) continue;
    try { fs.unlinkSync(path.join(dir, file)); removed++; } catch (e) { /* уже нет */ }
  }
  return removed;
}

function removeScreenFile(screen, filename) {
  const safe = path.basename(filename); // защита от ../
  const full = path.join(SCREENS_DIR, screen, safe);
  if (!full.startsWith(path.join(SCREENS_DIR, screen))) return false;
  try { fs.unlinkSync(full); return true; } catch (e) { return false; }
}

module.exports = {
  SCREENS, LOGO_VARIANTS, IMAGE_EXT, VIDEO_EXT,
  init, rescan, buildingsManifest, resolveBuilding,
  pickScreenBackground, listScreen,
  getLogo, listLogoFiles, logoFilePath, removeLogoVariant,
  buildingFilePath, screenFilePath, removeBuildingLevel, removeScreenFile,
  scannedAt: () => cache.scannedAt,
};
