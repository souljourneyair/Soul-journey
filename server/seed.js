// Создаёт (один раз, идемпотентно) аккаунт-демонстрацию "SoulJourney" с
// максимальными статами — удобно для показа/тестирования полностью
// отстроенного аэропорта без необходимости играть с нуля.
//
// ВНИМАНИЕ: логин/пароль этого аккаунта захардкожены и видны в исходниках.
// Если проект когда-нибудь станет публичным репозиторием или ты откроешь
// доступ другим людям — либо смени пароль через reset-password.js, либо
// вырежи вызов ensureSuperuser() из server/index.js.

const bcrypt = require('bcryptjs');
const store = require('./store');
const { CONFIG, LAND_EXPANSION, BUILDINGS, XP_FOR_LEVEL } = require('./gameData');

const SUPERUSER_USERNAME = 'SoulJourney';
const SUPERUSER_PASSWORD = 'ggg777ggg';
const SUPERUSER_MONEY = 999999999;
const SUPERUSER_REPUTATION = 999999;

function ensureSuperuser() {
  let user = store.findUserByUsername(SUPERUSER_USERNAME);

  if (!user) {
    const hash = bcrypt.hashSync(SUPERUSER_PASSWORD, 10);
    user = store.createUser(SUPERUSER_USERNAME, hash);
    console.log(`[seed] Создан супер-пользователь "${SUPERUSER_USERNAME}"`);
  }

  if (!user.isAdmin) {
    store.setUserAdmin(SUPERUSER_USERNAME, true);
    console.log(`[seed] "${SUPERUSER_USERNAME}" назначен администратором`);
  }

  let airport = store.getAirportByUserId(user.id);

  if (!airport) {
    // Первое создание — отстраиваем и прокачиваем на максимум.
    airport = store.createAirport(user.id, 'A', SUPERUSER_MONEY, CONFIG.MAX_GRID_SIZE);

    // Заполняем территорию всем каталогом построек — показательный полностью отстроенный аэропорт
    const buildingIds = Object.keys(BUILDINGS);
    buildingIds.forEach((id, cellIndex) => {
      if (id === 'admin' || id === 'helipad') return; // выдаются отдельно ниже с фиксированными клетками
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
      gridSize: CONFIG.MAX_GRID_SIZE,
      landExpansionsBought: LAND_EXPANSION.length,
    });

    console.log(`[seed] Аэропорт "${SUPERUSER_USERNAME}" отстроен и прокачан на максимум`);
  }
  // Если аэропорт уже существует — НЕ трогаем его: любые изменения (в т.ч.
  // сделанные через админку) сохраняются между перезапусками сервера.
}

module.exports = { ensureSuperuser, SUPERUSER_USERNAME };
