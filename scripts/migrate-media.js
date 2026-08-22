#!/usr/bin/env node
// Одноразовая миграция: старые скины зданий и фоны экранов из data.json
// раскладываются по папкам uploads/buildings/<id>/ и uploads/screens/<screen>/.
//
// Запуск из корня проекта:   node scripts/migrate-media.js
// Ничего не удаляет: файлы копируются, data.json правится только по флагу --clean.
//
// После проверки (картинки на месте, игра их видит) можно прогнать с --clean,
// чтобы вычистить buildingSkins/authBgUrl/gameBgUrl из data.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');
const BUILDINGS_DIR = path.join(PUBLIC_DIR, 'uploads', 'buildings');
const SCREENS_DIR = path.join(PUBLIC_DIR, 'uploads', 'screens');
const LOGO_DIR = path.join(PUBLIC_DIR, 'uploads', 'logo');

const clean = process.argv.includes('--clean');

if (!fs.existsSync(DATA_FILE)) {
  console.error(`Не найден ${DATA_FILE}. Запускайте из корня проекта: node scripts/migrate-media.js`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// URL вида /uploads/gallery/abc.png (возможно с ?v=...) → путь на диске
function sourcePathFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const clean = decodeURIComponent(url.split('?')[0]);
  const full = path.join(PUBLIC_DIR, clean);
  return fs.existsSync(full) ? full : null;
}

let copiedSkins = 0, missingSkins = 0;
const skins = data.buildingSkins || {};

for (const [buildingId, byLevel] of Object.entries(skins)) {
  if (!byLevel || typeof byLevel !== 'object') continue;
  for (const [level, url] of Object.entries(byLevel)) {
    const src = sourcePathFromUrl(url);
    if (!src) {
      console.warn(`  ! ${buildingId} ур.${level}: файл не найден (${url})`);
      missingSkins++;
      continue;
    }
    const ext = path.extname(src).slice(1).toLowerCase();
    const destDir = path.join(BUILDINGS_DIR, buildingId);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${level}.${ext}`);
    fs.copyFileSync(src, dest);
    console.log(`  + ${buildingId}/${level}.${ext}`);
    copiedSkins++;
  }
}

let copiedBg = 0;
for (const screen of ['auth', 'game']) {
  const url = data.settings ? data.settings[screen === 'auth' ? 'authBgUrl' : 'gameBgUrl'] : null;
  const src = sourcePathFromUrl(url);
  if (!src) continue;
  const destDir = path.join(SCREENS_DIR, screen);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  console.log(`  + screens/${screen}/${path.basename(src)}`);
  copiedBg++;
}

// Логотип: settings.logoUrl -> uploads/logo/default.<ext>
let copiedLogo = 0;
{
  const src = sourcePathFromUrl(data.settings ? data.settings.logoUrl : null);
  if (src) {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const ext = path.extname(src).slice(1).toLowerCase();
    fs.copyFileSync(src, path.join(LOGO_DIR, `default.${ext}`));
    console.log(`  + logo/default.${ext}`);
    copiedLogo++;
  }
}

console.log(`\nСкинов скопировано: ${copiedSkins}, не найдено: ${missingSkins}. Фонов: ${copiedBg}. Логотипов: ${copiedLogo}.`);

if (clean) {
  const backup = DATA_FILE + '.bak-' + Date.now();
  fs.copyFileSync(DATA_FILE, backup);
  delete data.buildingSkins;
  if (data.settings) {
    delete data.settings.authBgUrl; delete data.settings.authBgKind;
    delete data.settings.gameBgUrl; delete data.settings.gameBgKind;
    delete data.settings.logoUrl;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`data.json очищен. Бэкап: ${path.basename(backup)}`);
} else {
  console.log('data.json не тронут. Когда убедитесь, что всё видно — прогоните с --clean.');
}
