'use strict';

// Выполняет одну операцию и передаёт исключение обработчику, не выпуская его
// в event loop. Возвращаемый статус позволяет вызывающему коду вести метрики.
function runSafely(task, onError) {
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  try {
    return { ok: true, value: task() };
  } catch (error) {
    try {
      if (typeof onError === 'function') onError(error);
      else console.error('[tick-safety] Unhandled task error', error);
    } catch (reportError) {
      console.error('[tick-safety] Error reporter failed', reportError);
    }
    return { ok: false, error };
  }
}

// Каждый аэропорт обрабатывается независимо. Исключение в одном обработчике
// не мешает выполнить обработчик для следующих аэропортов в том же тике.
function runEachSafely(items, task, onError) {
  if (!items || typeof items[Symbol.iterator] !== 'function') {
    throw new TypeError('items must be iterable');
  }
  if (typeof task !== 'function') throw new TypeError('task must be a function');

  let processed = 0;
  let failed = 0;
  let index = 0;
  for (const item of items) {
    try {
      task(item, index);
      processed += 1;
    } catch (error) {
      failed += 1;
      try {
        if (typeof onError === 'function') onError(error, item, index);
        else console.error('[tick-safety] Item processing error', error);
      } catch (reportError) {
        console.error('[tick-safety] Item error reporter failed', reportError);
      }
    }
    index += 1;
  }
  return { processed, failed };
}

module.exports = { runSafely, runEachSafely };
