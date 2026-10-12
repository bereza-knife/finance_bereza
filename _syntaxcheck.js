// ============================================================
//  БЕРЁЗА НАЙФ — Telegram-бот с уведомлениями из CRM
//
//  Установка: заполни FB_KEY ниже, сохрани, запусти setupBot().
// ============================================================

// ---------- ЗАПОЛНИТЬ ----------
const TG_TOKEN     = '8932737015:AAH9hFaww3gW2d5w3jN4EG9aUIz6eQ85O4E';
// Михаил ещё не подключён: пока его уведомления идут Григорию.
// Когда напишет боту — запусти getChatIds() и подставь его id в CHAT_MIKHAIL.
const CHAT_ALEXEY  = '1679154965';   // Алексей @Gromovknife
const CHAT_MIKHAIL = '1085731801';   // временно: григро @realgrigro

const FB_URL = 'https://bereza-crm-default-rtdb.europe-west1.firebasedatabase.app';

// ВАЖНО: это НЕ токен телеграма, а секрет базы Firebase — они разные.
// Где взять: Firebase Console → шестерёнка → Project settings →
// Service accounts → Database secrets → Show/Add secret.
// Пока тут стоял токен бота, база отвечала 401 и отчёты приходили пустыми.
const FB_KEY = 'СЮДА_СЕКРЕТ_БАЗЫ_FIREBASE';
// --------------------------------

const DEBT_DAYS = 7;   // через сколько дней напоминать о недоплате

// ============ TELEGRAM ============
function tgSend_(chatId, text) {
  if (!chatId) return;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'post',
    payload: { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: 'true' },
    muteHttpExceptions: true
  });
}
function toAlexey_(t)  { tgSend_(CHAT_ALEXEY, t); }
function toMikhail_(t) { tgSend_(CHAT_MIKHAIL, t); }
function toBoth_(t) {
  toAlexey_(t);
  if (String(CHAT_MIKHAIL) !== String(CHAT_ALEXEY)) toMikhail_(t);
}

// Экранируем, чтобы имена с < & не ломали разметку
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function rub_(v) { return Math.round(v || 0).toLocaleString('ru-RU') + ' ₽'; }
// Остаток бруска бывает дробным (полбруска), поэтому не округляем до целого
function num_(v) { return String(Math.round((Number(v) || 0) * 100) / 100); }

// ============ FIREBASE ============
function fbGet_(path) {
  const r = UrlFetchApp.fetch(FB_URL + '/' + path + '.json?auth=' + FB_KEY, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) {
    Logger.log('Firebase ' + path + ' → ' + r.getResponseCode() + ' ' + r.getContentText());
    return null;
  }
  return JSON.parse(r.getContentText());
}
function fbPut_(path, value) {
  UrlFetchApp.fetch(FB_URL + '/' + path + '.json?auth=' + FB_KEY, {
    method: 'put', contentType: 'application/json',
    payload: JSON.stringify(value), muteHttpExceptions: true
  });
}
function values_(obj) {
  return Object.keys(obj || {}).map(function (k) { return obj[k]; });
}

// ============ РАСЧЁТЫ ============
const STEAK_IDS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17];
function isSteak_(o) {
  return typeof o.isSteak === 'boolean' ? o.isSteak : STEAK_IDS.indexOf(o.modelId) !== -1;
}
function due_(o) {
  return ((o.price || 0) + (o.extraPrice || 0)) - ((o.prepay || 0) + (o.finalPay || 0));
}
function orderById_(orders, id) {
  const list = values_(orders).filter(function (o) { return o && o.id === id; });
  return list.length ? list[0] : null;
}

// Позиции ниже минимума. Минимум 0 означает «не следим» — такие пропускаем.
function lowStock_(items) {
  return Object.keys(items || {}).map(function (k) { return items[k]; })
    .filter(function (it) { return it && it.min > 0 && (it.qty || 0) <= it.min; })
    .sort(function (a, b) { return (a.qty || 0) - (b.qty || 0); });
}
function lowStockLines_(low) {
  return low.map(function (it) {
    return '• ' + esc_(it.name) + ' — ' + num_(it.qty) + ' ' + esc_(it.unit || '') +
           ' (мин. ' + num_(it.min) + ')';
  }).join('\n');
}

// ============ СОБЫТИЯ (каждую минуту) ============
function notifyEvents() {
  const state = fbGet_('notify') || {};
  const log = fbGet_('orderLog') || {};
  const orders = fbGet_('orders') || {};

  // Первый запуск — не заваливаем историей, берём только последние 10 минут
  const lastTs = state.lastLogTs || (Date.now() - 10 * 60 * 1000);
  const fresh = values_(log)
    .filter(function (l) { return l && l.ts && l.ts > lastTs; })
    .sort(function (a, b) { return a.ts - b.ts; });

  let maxTs = lastTs;
  fresh.forEach(function (l) {
    if (l.ts > maxTs) maxTs = l.ts;
    const o = orderById_(orders, l.orderId);
    const who = esc_(l.actor || '—');
    const client = esc_(l.client || '—');

    if (l.action === 'create') {
      let t = '🆕 <b>Новый заказ №' + l.orderId + '</b>\n' + client;
      if (o) {
        t += '\n' + esc_(o.modelName || '') + (o.steelName ? ' · ' + esc_(o.steelName) : '');
        if (o.price) t += '\n' + rub_(o.price);
      }
      t += '\nОформил: ' + who;
      toBoth_(t);

    } else if (l.action === 'status') {
      const d = String(l.details || '');
      if (d.indexOf('→ Оплачен') !== -1) {
        toBoth_('💰 <b>Заказ №' + l.orderId + ' оплачен</b>\n' + client +
                (o && o.price ? ' · ' + rub_(o.price) : ''));
      } else if (d.indexOf('→ Готов') !== -1) {
        let t = '✅ <b>Заказ №' + l.orderId + ' готов</b>\n' + client;
        if (o) {
          t += ' · ' + esc_(o.modelName || '');
          const left = due_(o);
          if (left > 0) t += '\nОсталось получить: ' + rub_(left);
        }
        toMikhail_(t);
      }

    } else if (l.action === 'delete') {
      toAlexey_('🗑 <b>Заказ №' + l.orderId + ' удалён</b>\n' + client +
                '\nУдалил: ' + who + '\nВосстановить можно во вкладке «Журнал»');

    } else if (l.action === 'restore') {
      toAlexey_('↩️ <b>Заказ №' + l.orderId + ' восстановлен</b>\n' + client + '\nВернул: ' + who);

    } else if (l.action === 'edit') {
      // Только изменения цен — остальные правки не шлём
      const parts = String(l.details || '').split('; ').filter(function (p) {
        return p.indexOf('Цена продажи:') === 0 || p.indexOf('Цена для Михаила:') === 0;
      });
      if (parts.length) {
        toAlexey_('✏️ <b>Изменена цена · заказ №' + l.orderId + '</b>\n' + client +
                  '\n' + esc_(parts.join('\n')) + '\nИзменил: ' + who);
      }
    }
  });

  const items = fbGet_('warehouse/items') || {};
  const whTs = notifyWarehouse_(state, items);
  notifyLowStock_(state, items);

  fbPut_('notify/lastLogTs', maxTs);
  fbPut_('notify/lastWhTs', whTs);
}

// ============ ДВИЖЕНИЯ ПО СКЛАДУ ============
// Одно сводное сообщение на все операции с прошлой проверки.
// Отдельное сообщение на каждую строку означало бы 20 уведомлений подряд
// после внесения одного списка — такое отключают через неделю.
function notifyWarehouse_(state, items) {
  const hist = fbGet_('warehouse/history') || {};
  const lastTs = state.lastWhTs || (Date.now() - 10 * 60 * 1000);

  const fresh = values_(hist)
    .filter(function (h) { return h && h.ts && h.ts > lastTs; })
    .sort(function (a, b) { return a.ts - b.ts; });
  if (!fresh.length) return lastTs;

  let maxTs = lastTs;
  fresh.forEach(function (h) { if (h.ts > maxTs) maxTs = h.ts; });

  // Цена берётся из позиции: в истории её нет
  const priceByName = {};
  Object.keys(items || {}).forEach(function (k) {
    const it = items[k];
    if (it && it.price != null) priceByName[it.name] = it.price;
  });
  function lineValue_(h) {
    const p = priceByName[h.item];
    return p == null ? 0 : Math.abs(h.delta) * p;
  }

  const out = fresh.filter(function (h) { return h.delta < 0; });
  const inc = fresh.filter(function (h) { return h.delta > 0; });

  let t = '📦 <b>Движение по складу</b> · операций: ' + fresh.length;

  if (out.length) {
    const byEmp = {};
    out.forEach(function (h) {
      const e = h.employee || '—';
      if (!byEmp[e]) byEmp[e] = [];
      byEmp[e].push(h);
    });
    const sum = out.reduce(function (s, h) { return s + lineValue_(h); }, 0);
    t += '\n\n<b>Расход</b>' + (sum ? ' · ' + rub_(sum) : '');
    Object.keys(byEmp).forEach(function (e) {
      t += '\n' + esc_(e) + ':';
      byEmp[e].slice(0, 15).forEach(function (h) {
        t += '\n• ' + esc_(h.item) + ' ' + num_(h.delta) + ' ' + esc_(h.unit || '') +
             (h.comment ? ' — ' + esc_(h.comment) : '');
      });
      if (byEmp[e].length > 15) t += '\n… и ещё ' + (byEmp[e].length - 15);
    });
  }

  if (inc.length) {
    const sum = inc.reduce(function (s, h) { return s + lineValue_(h); }, 0);
    t += '\n\n<b>Приход</b>' + (sum ? ' · ' + rub_(sum) : '');
    inc.slice(0, 15).forEach(function (h) {
      t += '\n• ' + esc_(h.item) + ' +' + num_(h.delta) + ' ' + esc_(h.unit || '') +
           (h.employee ? ' — ' + esc_(h.employee) : '');
    });
    if (inc.length > 15) t += '\n… и ещё ' + (inc.length - 15);
  }

  toBoth_(t);
  return maxTs;
}

// Низкий остаток — сообщаем один раз, пока не пополнят
function notifyLowStock_(state, items) {
  const known = state.lowStock || {};
  const nowLow = {};
  const fresh = [];

  Object.keys(items || {}).forEach(function (id) {
    const it = items[id];
    if (it && it.min > 0 && (it.qty || 0) <= it.min) {
      nowLow[id] = true;
      if (!known[id]) fresh.push(it);
    }
  });

  if (fresh.length) {
    toBoth_('⚠️ <b>Заканчивается на складе</b>\n' + lowStockLines_(fresh));
  }
  fbPut_('notify/lowStock', nowLow);
}

// ============ УТРЕННЯЯ СВОДКА (9:00) ============
function morningSummary() {
  const orders = values_(fbGet_('orders') || {}).filter(function (o) { return o && o.id != null; });
  const log = values_(fbGet_('orderLog') || {});
  const items = fbGet_('warehouse/items') || {};

  const inWork = orders.filter(function (o) { return o.status === 'work'; });
  const ready  = orders.filter(function (o) { return o.status === 'done'; });
  const readySum = ready.reduce(function (s, o) { return s + due_(o); }, 0);

  // Когда заказ стал «Готов» — берём из журнала
  const doneAt = {};
  log.forEach(function (l) {
    if (l.action === 'status' && String(l.details || '').indexOf('→ Готов') !== -1) {
      if (!doneAt[l.orderId] || l.ts > doneAt[l.orderId]) doneAt[l.orderId] = l.ts;
    }
  });
  const limit = Date.now() - DEBT_DAYS * 24 * 3600 * 1000;
  const debts = orders.filter(function (o) {
    return due_(o) > 0 && doneAt[o.id] && doneAt[o.id] < limit;
  });

  const low = lowStock_(items);

  let t = '📋 <b>Доброе утро</b>\n';
  t += '\nВ работе: <b>' + inWork.length + '</b>';
  t += '\nГотовы, ждут оплаты: <b>' + ready.length + '</b>' + (readySum > 0 ? ' — ' + rub_(readySum) : '');

  if (debts.length) {
    t += '\n\n🔴 <b>Не доплачено больше ' + DEBT_DAYS + ' дней:</b>';
    debts.forEach(function (o) {
      t += '\n• №' + o.id + ' ' + esc_(o.client) + ' — ' + rub_(due_(o));
    });
  }
  if (low.length) {
    t += '\n\n⚠️ <b>Заканчивается (' + low.length + '):</b>\n' + lowStockLines_(low.slice(0, 20));
    if (low.length > 20) t += '\n… и ещё ' + (low.length - 20);
  }
  if (!inWork.length && !ready.length && !debts.length && !low.length) {
    t += '\n\nВсё спокойно — ни долгов, ни заканчивающихся позиций.';
  }
  toBoth_(t);
}

// ============ ВЕЧЕРНЯЯ СВОДКА (21:00) ============
function eveningSummary() {
  const today = Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy');
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const ts0 = dayStart.getTime();

  const orders = values_(fbGet_('orders') || {}).filter(function (o) { return o && o.id != null; });
  const log = values_(fbGet_('orderLog') || {}).filter(function (l) { return l && l.ts >= ts0; });
  const items = fbGet_('warehouse/items') || {};
  const wh = values_(fbGet_('warehouse/history') || {}).filter(function (h) { return h && h.ts >= ts0; });

  const created = log.filter(function (l) { return l.action === 'create'; });
  const paid = log.filter(function (l) {
    return l.action === 'status' && String(l.details || '').indexOf('→ Оплачен') !== -1;
  });
  const createdSum = created.reduce(function (s, l) {
    const o = orders.filter(function (x) { return x.id === l.orderId; })[0];
    return s + (o && o.price ? o.price : 0);
  }, 0);
  const paidSum = paid.reduce(function (s, l) {
    const o = orders.filter(function (x) { return x.id === l.orderId; })[0];
    return s + (o && o.price ? o.price : 0);
  }, 0);

  let t = '🌙 <b>Итоги дня</b> · ' + today + '\n';
  t += '\nСоздано заказов: <b>' + created.length + '</b>' + (createdSum ? ' — ' + rub_(createdSum) : '');
  t += '\nОплачено: <b>' + paid.length + '</b>' + (paidSum ? ' — ' + rub_(paidSum) : '');

  const spent = wh.filter(function (h) { return h.delta < 0; });
  if (spent.length) {
    // Группируем: сотрудник → что и сколько
    const byEmp = {};
    spent.forEach(function (h) {
      const e = h.employee || '—';
      if (!byEmp[e]) byEmp[e] = [];
      byEmp[e].push(esc_(h.item) + ' ' + num_(h.delta) + ' ' + esc_(h.unit || ''));
    });
    t += '\n\n📦 <b>Списано со склада:</b>';
    Object.keys(byEmp).forEach(function (e) {
      t += '\n• ' + esc_(e) + ': ' + byEmp[e].join(', ');
    });
  }

  const income = wh.filter(function (h) { return h.delta > 0; });
  if (income.length) {
    t += '\n\n📥 <b>Приход:</b> ' + income.map(function (h) {
      return esc_(h.item) + ' +' + num_(h.delta) + ' ' + esc_(h.unit || '');
    }).join(', ');
  }

  // Что заканчивается — вечером полезнее, чем утром: закупку планируют с вечера
  const low = lowStock_(items);
  if (low.length) {
    t += '\n\n⚠️ <b>Заканчивается (' + low.length + '):</b>\n' + lowStockLines_(low.slice(0, 20));
    if (low.length > 20) t += '\n… и ещё ' + (low.length - 20);
  }

  // Сколько денег лежит на складе — считаем по позициям с ценой
  const withPrice = values_(items).filter(function (it) { return it && it.price != null; });
  const stockValue = withPrice.reduce(function (s, it) { return s + (it.qty || 0) * it.price; }, 0);
  const noPrice = values_(items).filter(function (it) { return it && it.price == null && (it.qty || 0) > 0; }).length;
  if (stockValue) {
    t += '\n\n💼 <b>Склад:</b> ' + rub_(stockValue) +
         (noPrice ? ' <i>(без цены ещё ' + noPrice + ' позиций)</i>' : '');
  }

  if (!created.length && !paid.length && !spent.length && !income.length && !low.length) {
    t += '\n\nСегодня движений не было.';
  }
  toBoth_(t);
}

// ============ УСТАНОВКА ============

// Шаг 1. Оба пишут боту /start, потом запусти это — в журнале появятся их chat_id
function getChatIds() {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates', { muteHttpExceptions: true });
  const d = JSON.parse(r.getContentText());
  if (!d.ok) { Logger.log('Ошибка: ' + r.getContentText()); return; }
  if (!d.result.length) { Logger.log('Пусто. Попросите обоих написать боту /start и запустите ещё раз.'); return; }
  const seen = {};
  d.result.forEach(function (u) {
    const m = u.message || u.edited_message;
    if (!m || !m.chat) return;
    const c = m.chat;
    if (seen[c.id]) return;
    seen[c.id] = true;
    Logger.log('chat_id: ' + c.id + '  —  ' + (c.first_name || '') + ' ' + (c.last_name || '') + ' @' + (c.username || ''));
  });
  Logger.log('Скопируйте нужные id в CHAT_ALEXEY и CHAT_MIKHAIL вверху файла.');
}

// Проверка доступа к базе — запусти ПЕРЕД setupBot()
function testFirebase() {
  if (FB_KEY.indexOf('СЮДА') === 0) {
    Logger.log('❌ FB_KEY не заполнен. Firebase Console → Project settings → Service accounts → Database secrets.');
    return;
  }
  const items = fbGet_('warehouse/items');
  if (items === null) {
    Logger.log('❌ База не отвечает 200. Проверьте FB_KEY — это секрет базы, а не токен телеграма.');
    return;
  }
  const n = Object.keys(items).length;
  const low = lowStock_(items);
  Logger.log('✅ База читается. Позиций на складе: ' + n + ', ниже минимума: ' + low.length);
  if (!low.length) Logger.log('ℹ️ Ни одной позиции ниже минимума — скорее всего минимумы ещё не проставлены (все нули).');
}

// Шаг 2. После заполнения chat_id и FB_KEY — запусти это один раз
function setupBot() {
  if (!CHAT_ALEXEY || !CHAT_MIKHAIL) {
    Logger.log('Сначала заполните CHAT_ALEXEY и CHAT_MIKHAIL — запустите getChatIds()');
    return;
  }
  if (fbGet_('warehouse/items') === null) {
    Logger.log('База не читается — запустите testFirebase() и поправьте FB_KEY. Триггеры не ставлю.');
    return;
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'notifyEvents' || f === 'morningSummary' || f === 'eveningSummary') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notifyEvents').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('morningSummary').timeBased().atHour(9).everyDays(1).inTimezone('Europe/Moscow').create();
  ScriptApp.newTrigger('eveningSummary').timeBased().atHour(21).everyDays(1).inTimezone('Europe/Moscow').create();

  // Чтобы не прилетела вся история — начинаем с текущего момента
  fbPut_('notify/lastLogTs', Date.now());
  fbPut_('notify/lastWhTs', Date.now());
  toBoth_('🔔 <b>Бот подключён</b>\nУведомления по заказам и складу.\nСводки — в 9:00 и 21:00.');
  Logger.log('✅ Бот запущен. Проверьте, пришло ли сообщение в Telegram.');
}

// Проверка связи — можно запускать в любой момент
function testBot() {
  toBoth_('🧪 Проверка связи — бот работает.');
  Logger.log('Отправлено. Если сообщение не пришло — проверьте токен и chat_id.');
}
