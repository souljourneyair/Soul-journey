// Создаёт (один раз, идемпотентно) первоначальную учётную запись администратора
// SoulJourney с демонстрационным аэропортом. Пароль первого входа временный:
// сервер принудительно потребует сменить его до доступа к игровым функциям.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('./store');
const { CONFIG, BUILDINGS, XP_FOR_LEVEL } = require('./gameData');

const SUPERUSER_USERNAME = 'SoulJourney';
// При необходимости установщик может задать свой временный пароль через env.
const SUPERUSER_PASSWORD = process.env.SUPERUSER_PASSWORD || null;
const SUPERUSER_MONEY = 999999999;
const SUPERUSER_REPUTATION = 999999;

function ensureSuperuser() {
  let user = store.findUserByUsername(SUPERUSER_USERNAME);

  if (!user) {
    const initialPassword = SUPERUSER_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const hash = bcrypt.hashSync(initialPassword, 10);
    user = store.createUser(SUPERUSER_USERNAME, hash, { mustChangePassword: true });
    console.log(`[seed] Создан первоначальный администратор "${SUPERUSER_USERNAME}" — требуется сменить пароль при первом входе`);
    if (!SUPERUSER_PASSWORD) {
      console.warn(`[seed] Одноразовый пароль первого входа: ${initialPassword}`);
      console.warn('[seed] Сохраните его из консоли сервера: после входа система потребует задать новый пароль.');
    } else {
      console.log('[seed] Для первоначального входа использован пароль из SUPERUSER_PASSWORD.');
    }
  }

  if (!user.isAdmin) {
    store.setUserAdmin(SUPERUSER_USERNAME, true);
    console.log(`[seed] "${SUPERUSER_USERNAME}" назначен администратором`);
    user = store.findUserByUsername(SUPERUSER_USERNAME);
  }

  // Для ранее созданной базы без этого поля также требуем смену начального
  // пароля. Явное false сохраняется: администратор уже сменил его.
  if (user.mustChangePassword === undefined || user.mustChangePassword === null) {
    store.setUserMustChangePassword(SUPERUSER_USERNAME, true);
    user = store.findUserByUsername(SUPERUSER_USERNAME);
    console.log('[seed] Для администратора включена обязательная смена первоначального пароля');
  }

  let airport = store.getAirportByUserId(user.id);

  if (!airport) {
    // Первое создание — отстраиваем и прокачиваем на максимум.
    airport = store.createAirport(user.id, 'A', SUPERUSER_MONEY);

    // Заполняем каталогом построек — показательный полностью отстроенный аэропорт
    const buildingIds = Object.keys(BUILDINGS);
    buildingIds.forEach((id, cellIndex) => {
      if (id === 'admin' || id === 'helipad') return; // выдаются отдельно ниже
      store.addBuilding(airport.id, cellIndex + 2, id);
    });
    store.addBuilding(airport.id, 0, 'admin');
    store.addBuilding(airport.id, 1, 'helipad');

    // Статы форсируем ТОЛЬКО здесь — при первом создании. reachedLevel10At не
    // трогаем, иначе таймер "время полёта" замрёт на нуле.
    store.updateAirport(airport.id, {
      money: SUPERUSER_MONEY,
      reputation: SUPERUSER_REPUTATION,
      xp: XP_FOR_LEVEL[XP_FOR_LEVEL.length - 1],
      level: CONFIG.TARGET_LEVEL,
    });

    console.log(`[seed] Аэропорт "${SUPERUSER_USERNAME}" отстроен и прокачан на максимум`);
  }
  // Если аэропорт уже существует — НЕ трогаем его: любые изменения (в т.ч.
  // сделанные через админку) сохраняются между перезапусками сервера.
}

module.exports = { ensureSuperuser, SUPERUSER_USERNAME };
