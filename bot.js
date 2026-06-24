require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_SECRET = process.env.API_SECRET || 'kizmat-secret-2026';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

// ─── Категории kizmat.kg ─────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'cement',    name: 'Цемент и бетон',    hint: 'М400, М500, ЖБИ' },
  { id: 'metal',     name: 'Металл и арматура',  hint: 'Прокат, профили' },
  { id: 'brick',     name: 'Кирпич и блоки',     hint: 'Газоблок, керамика' },
  { id: 'finish',    name: 'Отделка',             hint: 'Плитка, краска, обои' },
  { id: 'roofing',   name: 'Кровля',              hint: 'Профнастил, черепица' },
  { id: 'insul',     name: 'Утепление',           hint: 'Минвата, пенопласт' },
  { id: 'plumb',     name: 'Сантехника',          hint: 'Трубы, фитинги' },
  { id: 'electro',   name: 'Электрика',           hint: 'Кабели, щиты' },
  { id: 'windows',   name: 'Окна и двери',        hint: 'ПВХ, металл, дерево' },
  { id: 'tools',     name: 'Инструменты',         hint: 'Электро, ручные' },
];

// ─── База данных (in-memory) ──────────────────────────────────────────────────
// suppliers: chatId → { name, phone, categories[], supplierId, linkedAt }
// customers: chatId → { name, phone, company }
// tenders:   id     → { title, categoryId, quantity, budget, deadline, location, desc, customerId, status }
// proposals: tenderId → [{ chatId, name, phone, price, deadline, at }]
const db = {
  suppliers: {},
  customers: {},
  tenders:   {},
  proposals: {},
};

let tenderCounter = 1;

// ─── Bot ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

// ── /start ──────────────────────────────────────────────────────────────────
bot.start((ctx) => {
  const payload = ctx.startPayload; // deep link: /start SUPPLIER_ID
  const chatId  = ctx.chat.id;

  // Deep link — сайт прислал supplier_id для привязки
  if (payload && payload.startsWith('sup_')) {
    db.suppliers[chatId] = db.suppliers[chatId] || {};
    db.suppliers[chatId].supplierId = payload;
    db.suppliers[chatId].linkedAt   = new Date().toISOString();
    ctx.session = {};
    return ctx.reply(
      `🔗 Аккаунт успешно привязан к kizmat.kg!\n\nТеперь введите ваше имя и компанию:\n(Пример: Алибек — ОсОО СтройСнаб)`
    ).then(() => { ctx.session.step = 'awaiting_name'; });
  }

  ctx.session = {};
  ctx.reply(
    '🏗 Добро пожаловать в Кызмат.kg B2B!\n\nПлатформа для поставщиков стройматериалов.\n\nКем вы являетесь?',
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Я поставщик', 'role_supplier')],
      [Markup.button.callback('🏢 Я заказчик',  'role_customer')],
    ])
  );
});

// ── Выбор роли ───────────────────────────────────────────────────────────────
bot.action('role_supplier', (ctx) => {
  ctx.answerCbQuery();
  ctx.session.role = 'supplier';
  ctx.session.step = 'awaiting_name';
  ctx.editMessageText('📦 Регистрация поставщика\n\nВведите ваше имя и название компании:\n(Пример: Алибек — ОсОО СтройСнаб)');
});

bot.action('role_customer', (ctx) => {
  ctx.answerCbQuery();
  ctx.session.role = 'customer';
  ctx.session.step = 'awaiting_name';
  ctx.editMessageText('🏢 Регистрация заказчика\n\nВведите ваше имя и название компании:\n(Пример: Бекзат — ОсОО БишкекСтрой)');
});

// ── /newtender — заказчик создаёт тендер ────────────────────────────────────
bot.command('newtender', (ctx) => {
  const chatId = ctx.chat.id;
  if (!db.customers[chatId]) {
    return ctx.reply('⚠️ Сначала зарегистрируйтесь как заказчик. Отправьте /start');
  }
  ctx.session.step        = 'tender_title';
  ctx.session.tenderDraft = {};
  ctx.reply('📋 Создание тендера\n\nШаг 1/5: Введите название тендера:\n(Пример: Цемент М500 — 50 тонн)');
});

// ── /testtender ──────────────────────────────────────────────────────────────
bot.command('testtender', (ctx) => {
  sendTenderToChat(ctx.chat.id, {
    id:         'TEST-001',
    title:      'Цемент М500 — 50 тонн',
    categoryId: 'cement',
    quantity:   '50 тонн',
    budget:     '200 000 сом',
    deadline:   '30 июня 2026',
    location:   'Бишкек, Октябрьский район',
    desc:       'Нужен цемент М500 для жилого комплекса. Доставка обязательна.',
    customerId: null,
  });
});

// ── /mystatus ────────────────────────────────────────────────────────────────
bot.command('mystatus', (ctx) => {
  const chatId = ctx.chat.id;
  const sup = db.suppliers[chatId];
  const cus = db.customers[chatId];
  if (sup) {
    const cats = sup.categories?.map(id => CATEGORIES.find(c => c.id === id)?.name).join(', ') || '—';
    return ctx.reply(`📋 Профиль поставщика:\n\n👤 ${sup.name}\n📞 ${sup.phone}\n📦 Категории: ${cats}`);
  }
  if (cus) {
    return ctx.reply(`📋 Профиль заказчика:\n\n👤 ${cus.name}\n📞 ${cus.phone}\n🏢 ${cus.company}`);
  }
  ctx.reply('Вы не зарегистрированы. Отправьте /start');
});

// ── /help ────────────────────────────────────────────────────────────────────
bot.command('help', (ctx) => {
  ctx.reply(
    '📌 Команды:\n\n' +
    '/start — регистрация\n' +
    '/newtender — создать тендер (для заказчиков)\n' +
    '/testtender — тестовый тендер\n' +
    '/mystatus — ваш профиль\n' +
    '/help — помощь'
  );
});

// ── Обработка текста (пошаговая регистрация и тендер) ────────────────────────
bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const text   = ctx.message.text.trim();
  const step   = ctx.session?.step;

  // ── Регистрация: имя ──────────────────────────────────────────────────────
  if (step === 'awaiting_name') {
    ctx.session.name = text;
    ctx.session.step = 'awaiting_phone';
    return ctx.reply('📞 Введите ваш номер телефона:\n(Пример: +996 700 123456)');
  }

  // ── Регистрация: телефон ──────────────────────────────────────────────────
  if (step === 'awaiting_phone') {
    ctx.session.phone = text;

    if (ctx.session.role === 'customer') {
      ctx.session.step = 'awaiting_company';
      return ctx.reply('🏢 Введите название вашей компании:');
    }

    // Поставщик → выбор категорий
    ctx.session.step = 'awaiting_categories';
    const list = CATEGORIES.map((c, i) => `${i + 1}. ${c.name} (${c.hint})`).join('\n');
    return ctx.reply(`📦 Выберите ваши категории товаров.\nОтправьте номера через запятую:\n\n${list}\n\nПример: 1, 2, 3`);
  }

  // ── Заказчик: компания ────────────────────────────────────────────────────
  if (step === 'awaiting_company') {
    db.customers[chatId] = {
      name:    ctx.session.name,
      phone:   ctx.session.phone,
      company: text,
    };
    ctx.session.step = null;
    return ctx.reply(
      `✅ Регистрация завершена!\n\n👤 ${ctx.session.name}\n📞 ${ctx.session.phone}\n🏢 ${text}\n\n` +
      `Используйте /newtender чтобы разместить тендер.`
    );
  }

  // ── Поставщик: категории ──────────────────────────────────────────────────
  if (step === 'awaiting_categories') {
    const nums = text.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < CATEGORIES.length);
    if (nums.length === 0) return ctx.reply('⚠️ Укажите хотя бы одну категорию. Пример: 1, 2');

    const chosen = nums.map(n => CATEGORIES[n].id);
    db.suppliers[chatId] = {
      name:       ctx.session.name,
      phone:      ctx.session.phone,
      categories: chosen,
      supplierId: db.suppliers[chatId]?.supplierId || null,
      linkedAt:   db.suppliers[chatId]?.linkedAt   || null,
    };
    ctx.session.step = null;

    const catNames = chosen.map(id => CATEGORIES.find(c => c.id === id).name).join(', ');
    return ctx.reply(
      `✅ Регистрация завершена!\n\n👤 ${ctx.session.name}\n📞 ${ctx.session.phone}\n📦 ${catNames}\n\n` +
      `Теперь вы будете получать тендеры по вашим категориям.\n\nПопробуйте /testtender`
    );
  }

  // ── Создание тендера: шаги ────────────────────────────────────────────────
  if (step === 'tender_title') {
    ctx.session.tenderDraft.title = text;
    ctx.session.step = 'tender_category';
    const list = CATEGORIES.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    return ctx.reply(`Шаг 2/5: Выберите категорию (номер):\n\n${list}`);
  }

  if (step === 'tender_category') {
    const n = parseInt(text) - 1;
    if (isNaN(n) || n < 0 || n >= CATEGORIES.length) return ctx.reply('⚠️ Введите номер от 1 до 10');
    ctx.session.tenderDraft.categoryId = CATEGORIES[n].id;
    ctx.session.step = 'tender_quantity';
    return ctx.reply('Шаг 3/5: Укажите объём/количество:\n(Пример: 50 тонн)');
  }

  if (step === 'tender_quantity') {
    ctx.session.tenderDraft.quantity = text;
    ctx.session.step = 'tender_budget';
    return ctx.reply('Шаг 4/5: Укажите бюджет:\n(Пример: 200 000 сом)');
  }

  if (step === 'tender_budget') {
    ctx.session.tenderDraft.budget = text;
    ctx.session.step = 'tender_deadline';
    return ctx.reply('Шаг 5/5: Укажите срок подачи предложений:\n(Пример: 30 июня 2026)');
  }

  if (step === 'tender_deadline') {
    const draft      = ctx.session.tenderDraft;
    draft.deadline   = text;
    draft.customerId = chatId;
    draft.location   = db.customers[chatId]?.company || 'Бишкек';
    draft.desc       = '';
    draft.status     = 'active';

    const tenderId   = `TEND-${String(tenderCounter++).padStart(3, '0')}`;
    db.tenders[tenderId] = { id: tenderId, ...draft };
    ctx.session.step = null;

    ctx.reply(`✅ Тендер #${tenderId} создан!\n\nРассылаем уведомления поставщикам...`);
    notifySuppliers(tenderId);
    return;
  }

  // ── Предложение поставщика ────────────────────────────────────────────────
  if (step?.startsWith('proposal:')) {
    const tenderId    = step.split(':')[1];
    const priceMatch  = text.match(/Цена[:\s]+([^\n]+)/i);
    const dlMatch     = text.match(/Срок[:\s]+([^\n]+)/i);

    if (!priceMatch || !dlMatch) {
      return ctx.reply('⚠️ Неверный формат. Отправьте:\n\nЦена: 185000 сом\nСрок: 3 дня');
    }

    const sup = db.suppliers[chatId];
    if (!db.proposals[tenderId]) db.proposals[tenderId] = [];
    db.proposals[tenderId].push({
      chatId,
      name:     sup?.name  || 'Неизвестный',
      phone:    sup?.phone || '—',
      price:    priceMatch[1].trim(),
      deadline: dlMatch[1].trim(),
      at:       new Date().toLocaleString('ru-RU'),
    });

    ctx.session.step = null;
    ctx.reply(
      `✅ Ваше предложение принято!\n\n📦 Тендер: ${tenderId}\n💰 Цена: ${priceMatch[1].trim()}\n⏱ Срок: ${dlMatch[1].trim()}\n\nПередаём заказчику. Ожидайте ответа.`
    );

    // Уведомить заказчика
    notifyCustomer(tenderId, db.proposals[tenderId].at(-1));
    return;
  }
});

// ── Callback: подать предложение ──────────────────────────────────────────────
bot.action(/^propose:(.+)$/, (ctx) => {
  const tenderId = ctx.match[1];
  ctx.answerCbQuery();
  ctx.session.step = `proposal:${tenderId}`;
  ctx.reply(`📝 Подача предложения на тендер ${tenderId}\n\nОтправьте в формате:\n\nЦена: 185000 сом\nСрок: 3 дня`);
});

// ── Callback: пропустить ──────────────────────────────────────────────────────
bot.action(/^skip:(.+)$/, (ctx) => {
  ctx.answerCbQuery('Пропущен');
  ctx.editMessageReplyMarkup(undefined);
  ctx.reply('⏭ Тендер пропущен.');
});

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function sendTenderToChat(chatId, tender) {
  const catName = CATEGORIES.find(c => c.id === tender.categoryId)?.name || tender.categoryId;
  const text =
    `🏗 НОВЫЙ ТЕНДЕР #${tender.id}\n\n` +
    `📦 ${tender.title}\n` +
    `🗂 Категория: ${catName}\n` +
    `📊 Объём: ${tender.quantity}\n` +
    `📍 Локация: ${tender.location}\n` +
    `💰 Бюджет: ${tender.budget}\n` +
    `⏰ Срок подачи: ${tender.deadline}` +
    (tender.desc ? `\n\n📝 ${tender.desc}` : '');

  return bot.telegram.sendMessage(
    chatId,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подать предложение', `propose:${tender.id}`)],
      [Markup.button.callback('⏭ Пропустить',         `skip:${tender.id}`)],
    ])
  ).catch(() => {});
}

function notifySuppliers(tenderId) {
  const tender = db.tenders[tenderId];
  if (!tender) return;

  let count = 0;
  for (const [chatId, sup] of Object.entries(db.suppliers)) {
    if (sup.categories?.includes(tender.categoryId)) {
      sendTenderToChat(Number(chatId), tender);
      count++;
    }
  }
  console.log(`📤 Тендер ${tenderId} отправлен ${count} поставщикам`);
}

function notifyCustomer(tenderId, proposal) {
  const tender = db.tenders[tenderId];
  if (!tender || !tender.customerId) return;

  bot.telegram.sendMessage(
    tender.customerId,
    `📬 Новое предложение на тендер #${tenderId}!\n\n` +
    `👤 Поставщик: ${proposal.name}\n` +
    `📞 Телефон: ${proposal.phone}\n` +
    `💰 Цена: ${proposal.price}\n` +
    `⏱ Срок: ${proposal.deadline}\n` +
    `🕐 Время: ${proposal.at}`
  ).catch(() => {});
}

// ─── Express API (для интеграции с сайтом) ────────────────────────────────────
const app = express();
app.use(express.json());

function checkSecret(req, res) {
  if (req.headers['x-api-key'] !== API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Сайт создаёт тендер → бот рассылает поставщикам
// POST /api/tender
// Headers: x-api-key: kizmat-secret-2026
// Body: { title, categoryId, quantity, budget, deadline, location, desc, customerChatId }
app.post('/api/tender', (req, res) => {
  if (!checkSecret(req, res)) return;

  const { title, categoryId, quantity, budget, deadline, location, desc, customerChatId } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'title and categoryId required' });

  const tenderId = `TEND-${String(tenderCounter++).padStart(3, '0')}`;
  db.tenders[tenderId] = {
    id: tenderId, title, categoryId, quantity, budget, deadline,
    location: location || 'Бишкек',
    desc:     desc     || '',
    customerId: customerChatId || null,
    status: 'active',
  };

  notifySuppliers(tenderId);
  res.json({ ok: true, tenderId, message: 'Тендер создан и разослан поставщикам' });
});

// Сайт привязывает поставщика → генерирует deep link
// POST /api/link
// Body: { supplierId }
app.post('/api/link', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { supplierId } = req.body;
  if (!supplierId) return res.status(400).json({ error: 'supplierId required' });

  const botUsername = process.env.BOT_USERNAME || 'kizmattbot';
  const deepLink    = `https://t.me/${botUsername}?start=sup_${supplierId}`;
  res.json({ ok: true, deepLink });
});

// Получить предложения по тендеру
// GET /api/proposals/:tenderId
app.get('/api/proposals/:tenderId', (req, res) => {
  if (!checkSecret(req, res)) return;
  const proposals = db.proposals[req.params.tenderId] || [];
  res.json({ ok: true, proposals });
});

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'Kyzmat.kg B2B Bot', version: '3.0' }));

// ─── Запуск ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🌐 API сервер запущен на порту ${PORT}`));

bot.launch()
  .then(() => console.log('🏗 Кызмат.kg B2B Bot v3.0 запущен'))
  .catch(err => { console.error('❌ Ошибка запуска:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
