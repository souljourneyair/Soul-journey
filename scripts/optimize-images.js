#!/usr/bin/env node
// Сжатие картинок в медиа-папках: уменьшает разрешение до разумного и
// переводит в webp. Иконки зданий показываются размером 64–200 пикселей,
// поэтому исходники на 1024+ — чистый перерасход трафика.
//
//   node scripts/optimize-images.js           показать, что будет сделано
//   node scripts/optimize-images.js --apply   выполнить
//
// Ключи:
//   --apply     реально перезаписать файлы (без него — только отчёт)
//   --force     обработать даже те файлы, что уже уложились в лимиты
//   --quality N качество webp, по умолчанию 82
//
// Файлы под git, так что откатить можно всегда: git checkout -- public/uploads
//
// Нужен один из инструментов: пакет sharp (npm i sharp) или ImageMagick
// (apt install imagemagick). Скрипт сам выберет, что есть.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILDINGS_DIR = path.join(ROOT, 'public', 'uploads', 'buildings');
const SCREENS_DIR = path.join(ROOT, 'public', 'uploads', 'screens');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const qIdx = args.indexOf('--quality');
const QUALITY = qIdx !== -1 && args[qIdx + 1] ? Number(args[qIdx + 1]) : 82;

// Иконка здания рисуется максимум в ширину колонки сетки (~200px), превью в
// таблице — 64px. 512 с запасом покрывает экраны с удвоенной плотностью.
const BUILDING_MAX = 512;
// Фон растягивается на весь экран, здесь запас нужен больше.
const SCREEN_MAX = 1920;

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
// svg не трогаем — это вектор, он и так лёгкий; gif может быть анимированным.
const SKIP_EXT = ['.svg', '.gif'];

// ---------- выбор инструмента ----------
let backend = null;
try {
  require.resolve('sharp');
  backend = 'sharp';
} catch (e) {
  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' });
    backend = 'imagemagick';
  } catch (e2) {
    backend = null;
  }
}

if (!backend) {
  console.error('Не найден инструмент для сжатия. Установите один из двух:');
  console.error('  npm i sharp                  (в папке проекта)');
  console.error('  sudo apt install imagemagick');
  process.exit(1);
}

// ---------- размеры картинки без внешних зависимостей ----------
function imageSize(file) {
  const buf = fs.readFileSync(file);
  // PNG
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WEBP
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const type = buf.slice(12, 16).toString();
    if (type === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (type === 'VP8 ') {
      const i = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a])) + 3;
      return { width: buf.readUInt16LE(i) & 0x3fff, height: buf.readUInt16LE(i + 2) & 0x3fff };
    }
    if (type === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG — идём по маркерам до SOF
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { width: null, height: null };
}

// ---------- сжатие ----------
function convert(src, dest, maxSide) {
  if (backend === 'sharp') {
    const sharp = require('sharp');
    return sharp(src)
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(dest);
  }
  execFileSync('convert', [
    src, '-resize', `${maxSide}x${maxSide}>`, '-quality', String(QUALITY), dest,
  ], { stdio: 'ignore' });
  return Promise.resolve();
}

function collect(dir, maxSide, label) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...collect(full, maxSide, label)); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXT.includes(ext)) continue;
    if (!IMAGE_EXT.includes(ext)) continue;
    out.push({ file: full, maxSide, label });
  }
  return out;
}

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' КБ';

async function main() {
  const targets = [
    ...collect(BUILDINGS_DIR, BUILDING_MAX, 'здание'),
    ...collect(SCREENS_DIR, SCREEN_MAX, 'фон'),
  ];

  if (!targets.length) {
    console.log('Картинок не найдено — папки пусты.');
    return;
  }

  console.log(`Инструмент: ${backend}, качество webp: ${QUALITY}`);
  console.log(`Лимит: здания ${BUILDING_MAX}px, фоны ${SCREEN_MAX}px`);
  console.log(APPLY ? 'Режим: ЗАПИСЬ\n' : 'Режим: только отчёт (добавьте --apply, чтобы применить)\n');

  let before = 0, after = 0, changed = 0, skipped = 0;

  for (const { file, maxSide } of targets) {
    const rel = file.split('uploads' + path.sep)[1];
    const sizeBefore = fs.statSync(file).size;
    const dim = imageSize(file);
    const isWebp = path.extname(file).toLowerCase() === '.webp';
    const fits = dim.width && dim.width <= maxSide && dim.height <= maxSide;

    before += sizeBefore;

    // Уже webp нужного размера — трогаем только при --force.
    if (fits && isWebp && !FORCE) {
      after += sizeBefore; skipped++;
      console.log(`  = ${rel.padEnd(46)} ${kb(sizeBefore)}  уже в норме`);
      continue;
    }

    const dest = file.replace(/\.[^.]+$/, '') + '.webp';
    const tmp = dest + '.tmp';

    try {
      await convert(file, tmp, maxSide);
      const sizeAfter = fs.statSync(tmp).size;

      // Если стало не меньше — оставляем исходник, кроме случая с ужиманием размера.
      if (sizeAfter >= sizeBefore && fits) {
        fs.unlinkSync(tmp);
        after += sizeBefore; skipped++;
        console.log(`  = ${rel.padEnd(46)} ${kb(sizeBefore)}  сжатие не помогает`);
        continue;
      }

      const dimStr = dim.width ? `${dim.width}x${dim.height} -> ${Math.min(dim.width, maxSide)}px` : '';
      const pct = Math.round((1 - sizeAfter / sizeBefore) * 100);
      console.log(`  ${APPLY ? '*' : '~'} ${rel.padEnd(46)} ${kb(sizeBefore)} -> ${kb(sizeAfter)}  (-${pct}%)  ${dimStr}`);

      if (APPLY) {
        fs.renameSync(tmp, dest);
        // Исходник другого формата убираем: иначе на один уровень окажется два
        // файла (1.png и 1.webp) и сканер выберет непредсказуемо.
        if (path.resolve(file) !== path.resolve(dest)) fs.unlinkSync(file);
      } else {
        fs.unlinkSync(tmp);
      }
      after += sizeAfter; changed++;
    } catch (err) {
      after += sizeBefore; skipped++;
      console.log(`  ! ${rel.padEnd(46)} ошибка: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Файлов: ${targets.length}, будет изменено: ${changed}, без изменений: ${skipped}`);
  console.log(`Объём: ${(before / 1024 / 1024).toFixed(2)} МБ -> ${(after / 1024 / 1024).toFixed(2)} МБ ` +
    `(экономия ${(((before - after) / before) * 100).toFixed(0)}%)`);
  if (!APPLY && changed > 0) {
    console.log('\nНичего не тронуто. Чтобы применить: node scripts/optimize-images.js --apply');
  }
  if (APPLY && changed > 0) {
    console.log('\nГотово. Откатить: git checkout -- public/uploads');
    console.log('Не забудьте «Пересканировать папки» в админке или перезапуск сервера.');
  }

  // Видео не трогаем — для него нужен ffmpeg и отдельные настройки.
  const videos = [];
  for (const screen of ['auth', 'game']) {
    const dir = path.join(SCREENS_DIR, screen);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (['.mp4', '.webm', '.ogv'].includes(path.extname(f).toLowerCase())) {
          videos.push(path.join(screen, f) + ` (${kb(fs.statSync(path.join(dir, f)).size).trim()})`);
        }
      }
    } catch (e) { /* папки может не быть */ }
  }
  if (videos.length) {
    console.log('\nВидео не сжимается этим скриптом: ' + videos.join(', '));
    console.log('Для видео: ffmpeg -i вход.mp4 -vf scale=1920:-2 -crf 30 -an выход.mp4');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
