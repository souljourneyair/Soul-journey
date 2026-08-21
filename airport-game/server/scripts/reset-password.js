// Сброс пароля игрока напрямую в data.json — без веб-интерфейса,
// т.к. в MVP ещё нет email-восстановления.
//
// Запуск (на сервере, из папки проекта):
//   node server/scripts/reset-password.js <логин> <новый_пароль>
//
// Пример:
//   node server/scripts/reset-password.js soultest MyNewPass123

const bcrypt = require('bcryptjs');
const store = require('../store');

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.error('Использование: node server/scripts/reset-password.js <логин> <новый_пароль>');
  process.exit(1);
}

if (newPassword.length < 4) {
  console.error('Пароль должен быть от 4 символов.');
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
const user = store.setUserPassword(username, hash);

if (!user) {
  console.error(`Пользователь "${username}" не найден.`);
  process.exit(1);
}

console.log(`Готово. Пароль для "${username}" обновлён.`);
