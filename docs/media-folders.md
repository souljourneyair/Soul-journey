# Картинки зданий и фоны экранов из папок

Заменяет `buildingSkins` в `data.json` и настройки `authBgUrl`/`gameBgUrl`.
Источник правды — файловая система.

## Куда что класть

```
public/uploads/
  buildings/<buildingId>/1.png        уровень 1
                        /2.jpg        уровень 2 (расширения могут быть разные)
                        /default.png  запасной вариант для всех уровней
  screens/auth/*.{png,jpg,webp,mp4,webm}   фон экрана входа
  screens/game/*.{png,jpg,webp,mp4,webm}   фон игрового экрана
```

`<buildingId>` — ровно ключ из `BUILDINGS` в `gameData.js`: `admin`, `helipad`,
`terminal_a`, `runway_small`, `stand_medium`, `fuel_depot` и т.д. Папки для всех
зданий создаются автоматически при старте сервера.

Поиск картинки для здания уровня N: точный `N` → ближайший меньший уровень →
самый младший имеющийся → `default` → эмодзи (как сейчас). То есть рисовать все
пять уровней необязательно.

В папках экранов имена файлов произвольные. Один файл — он и будет фоном.
Несколько — при каждой загрузке страницы берётся случайный. Папка пуста —
подхватывается старый фон из настроек (обратная совместимость).

Лишние файлы в папках зданий (исходники, заметки) игнорируются молча —
учитываются только `<число>.<расширение>` и `default.<расширение>`.

## Установка

1. `server/mediaScan.js` — новый файл, положить как есть.
2. `scripts/migrate-media.js` — новый файл.
3. Правки ниже.

---

## server/index.js

**Подключение** (рядом с прочими require, после импорта `BUILDINGS`):

```js
const mediaScan = require('./mediaScan');
mediaScan.init(Object.keys(BUILDINGS));   // создаёт папки + первый скан
```

**serializeAirport** — рядом со строкой `buildingSkins: store.getBuildingSkins(),`
добавить:

```js
    buildingMedia: mediaScan.buildingsManifest(),
```

Строку `buildingSkins` пока оставить (старый клиент в открытых вкладках не
сломается), убрать после того, как всё заработает.

**Публичные настройки** — в обработчике `/api/public-settings` фон берём сначала
из папки, потом из старой настройки:

```js
  const authFolder = mediaScan.pickScreenBackground('auth');
  const gameFolder = mediaScan.pickScreenBackground('game');
  res.json({
    logoUrl: s.logoUrl || null,
    authBg: authFolder || (s.authBgUrl ? { url: s.authBgUrl, kind: s.authBgKind || 'image' } : null),
    gameBg: gameFolder || (s.gameBgUrl ? { url: s.gameBgUrl, kind: s.gameBgKind || 'image' } : null),
  });
```

Форма ответа не меняется — `applyBackground` в `app.js` трогать не нужно.

**Новые админ-эндпоинты** (положить рядом с `/api/admin/gallery/upload`):

```js
// Пересканировать папки вручную (после заливки файлов по SFTP).
app.post('/api/admin/media/rescan', auth, adminAuth, (req, res) => {
  mediaScan.rescan();
  res.json({ buildings: mediaScan.buildingsManifest(), scannedAt: mediaScan.scannedAt() });
});

// Загрузить картинку конкретного уровня здания прямо в папку.
app.post('/api/admin/media/building', auth, adminAuth, (req, res) => {
  const { buildingId, level, dataUrl } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const lvl = String(level).toLowerCase();
  if (lvl !== 'default' && !/^[1-9]\d?$/.test(lvl)) {
    return res.status(400).json({ error: 'bad_level', message: 'Уровень — число или default' });
  }
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_image', message: 'Ожидается data URL картинки' });
  const ext = ALLOWED_IMAGE_TYPES[match[1]];
  if (!ext) return res.status(400).json({ error: 'unsupported_type', message: 'PNG, JPEG, GIF, WEBP или SVG' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'file_too_large', message: 'Максимум 5MB' });

  mediaScan.removeBuildingLevel(buildingId, lvl);   // убираем прежний файл этого уровня
  fs.writeFileSync(mediaScan.buildingFilePath(buildingId, lvl, ext), buffer);
  mediaScan.rescan();
  res.json({ buildings: mediaScan.buildingsManifest() });
});

app.post('/api/admin/media/building/remove', auth, adminAuth, (req, res) => {
  const { buildingId, level } = req.body || {};
  if (!BUILDINGS[buildingId]) return res.status(400).json({ error: 'unknown_building' });
  const removed = mediaScan.removeBuildingLevel(buildingId, String(level).toLowerCase());
  mediaScan.rescan();
  res.json({ removed, buildings: mediaScan.buildingsManifest() });
});

// Фоны экранов: список / добавление / удаление файла.
app.get('/api/admin/media/screens', auth, adminAuth, (req, res) => {
  res.json({ auth: mediaScan.listScreen('auth'), game: mediaScan.listScreen('game') });
});

app.post('/api/admin/media/screen', auth, adminAuth, (req, res) => {
  const { screen, dataUrl, filename } = req.body || {};
  if (!mediaScan.SCREENS.includes(screen)) return res.status(400).json({ error: 'bad_screen' });
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-zA-Z0-9\/+.-]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid_data' });
  const buffer = Buffer.from(match[2], 'base64');

  let ext;
  if (ALLOWED_IMAGE_TYPES[match[1]]) {
    ext = ALLOWED_IMAGE_TYPES[match[1]];
    if (buffer.length > MAX_BG_IMAGE_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Картинка — максимум ${Math.round(MAX_BG_IMAGE_BYTES/1024/1024)} МБ` });
  } else if (ALLOWED_VIDEO_TYPES[match[1]]) {
    ext = ALLOWED_VIDEO_TYPES[match[1]];
    if (buffer.length > MAX_BG_VIDEO_BYTES) return res.status(400).json({ error: 'file_too_large', message: `Видео — максимум ${Math.round(MAX_BG_VIDEO_BYTES/1024/1024)} МБ` });
  } else {
    return res.status(400).json({ error: 'unsupported_type' });
  }

  const base = String(filename || 'bg').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'bg';
  const safeName = `${base}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(mediaScan.screenFilePath(screen, safeName), buffer);
  mediaScan.rescan();
  res.json({ files: mediaScan.listScreen(screen) });
});

app.post('/api/admin/media/screen/remove', auth, adminAuth, (req, res) => {
  const { screen, filename } = req.body || {};
  if (!mediaScan.SCREENS.includes(screen)) return res.status(400).json({ error: 'bad_screen' });
  mediaScan.removeScreenFile(screen, filename);
  mediaScan.rescan();
  res.json({ files: mediaScan.listScreen(screen) });
});
```

Старые `/api/admin/background` и `/api/admin/gallery/skin` можно оставить
работающими до переключения админки, потом удалить.

---

## public/app.js

Найти использование `buildingSkins` (их два — в сетке и в таблице объектов).
Добавить рядом с `BUILDING_ICONS` резолвер:

```js
// Картинка здания из папок uploads/buildings/<id>/. Логика повторяет
// resolveBuilding в server/mediaScan.js — правится парой.
function resolveBuildingImage(buildingId, level) {
  const entry = STATE.buildingMedia?.[buildingId];
  if (!entry) return null;
  const lvl = Number(level) || 1;
  if (entry.levels?.[lvl]) return entry.levels[lvl];
  const nums = Object.keys(entry.levels || {}).map(Number).sort((a, b) => a - b);
  if (nums.length) {
    let best = null;
    for (const n of nums) if (n <= lvl) best = n;
    return entry.levels[best != null ? best : nums[0]];
  }
  return entry.default || null;
}
```

Заменить:

```js
const globalSkin = STATE.buildingSkins?.[building.buildingId]?.[building.upgradeLevel];
```

на:

```js
const globalSkin = resolveBuildingImage(building.buildingId, building.upgradeLevel);
```

Приоритет остаётся прежним: `customIcon` игрока → картинка из папки → эмодзи.
Проверка `/^https?:\/\/|^data:image|^\/uploads\//` уже ловит новые URL — она
смотрит на начало строки, а `?v=` идёт в конце.

---

## Админка

В разделе «Галерея» у каждого уровня здания кнопка загрузки теперь бьёт в
`/api/admin/media/building` с `{ buildingId, level, dataUrl }` вместо записи
скина в JSON, а удаление — в `/api/admin/media/building/remove`.

В «Настройках» два блока фонов превращаются в списки файлов с кнопкой
«Добавить» (`/api/admin/media/screen`) и крестиком на каждом
(`/api/admin/media/screen/remove`).

Плюс одна кнопка «Пересканировать папки» → `/api/admin/media/rescan` — нужна,
когда файлы заливались мимо админки, по SFTP.

---

## Порядок развёртывания

```bash
# 1. файлы на месте, сервер ещё старый
node scripts/migrate-media.js          # копирует существующие скины и фоны в папки
# 2. глазами проверить public/uploads/buildings/ — файлы разложены по уровням
pm2 restart soul-journey
# 3. Ctrl+Shift+R, убедиться что картинки на месте
node scripts/migrate-media.js --clean  # чистит data.json, делает бэкап
```

После `--clean` можно убирать из кода `buildingSkins`, `getBuildingSkins`,
`setBuildingSkin` и старый `/api/admin/background`.

## Проверить после деплоя

- Здание с картинками уровней 1 и 2, прокачанное до 3 — показывает картинку 2.
- Замена файла на диске + «Пересканировать» — картинка меняется без перезапуска
  (за счёт `?v=<mtime>`; без него браузер держал бы старую).
- Пустая папка экрана — фон берётся из старой настройки, экран не белый.
- Два файла в `screens/auth/` — при перезагрузке страницы фон чередуется.

---

## Сжатие картинок

Иконки зданий рисуются размером 64–200 пикселей, поэтому исходники на 1024+
почти целиком уходят в трафик впустую. Скрипт уменьшает разрешение и переводит
всё в webp:

```bash
node scripts/optimize-images.js           # отчёт: что и насколько ужмётся
node scripts/optimize-images.js --apply   # выполнить
```

Лимиты: здания до 512 пикселей по большей стороне, фоны экранов до 1920.
Качество webp по умолчанию 82, меняется ключом `--quality`.

Нужен один из инструментов — `npm i sharp` в папке проекта либо
`sudo apt install imagemagick`. Скрипт сам выберет, что найдёт, и подскажет,
если нет ни того ни другого.

Повторный запуск ничего не портит: файлы, уже уложившиеся в лимиты, пропускаются.
Откат — `git checkout -- public/uploads`. После сжатия нажмите
«Пересканировать папки» в админке или перезапустите сервер.

Видео скрипт не трогает. Для него:
`ffmpeg -i вход.mp4 -vf scale=1920:-2 -crf 30 -an выход.mp4`

**Важно:** на один уровень должен приходиться ровно один файл. Если в папке
окажутся и `1.png`, и `1.webp`, какой из них покажется — зависит от порядка
чтения папки; сервер напишет об этом в лог при сканировании. Скрипт сжатия
удаляет исходник сам, когда меняет формат.
