require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN .env файлда орнатылмаган');
  process.exit(1);
}

const bot = new Telegraf(token);
bot.use(session());

// In-memory storage
const suppliers = {};   // chatId -> { name, phone, categories }
const proposals = {};   // tenderId -> [{ supplierId, price, deadline, name }]

const CATEGORIES = ['Цемент', 'Металл', 'Кирпич', 'Песок', 'Щебень', 'Дерево'];

// ─── /start ─────────────────────────────────────────────────────────────────
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  suppliers[chatId] = null; // reset
  ctx.session = {};

  ctx.reply(
    '🏗 Добро пожаловать в Кызмат.kg B2B!\n\nЭта платформа соединяет поставщиков строительных материалов с тендерами.\n\nДля начала давайте зарегистрируемся.',
    Markup.removeKeyboard()
  ).then(() => {
    ctx.reply('Введите ваше имя и название компании:\n(Пример: Алибек — ОсОО СтройСнаб)');
    ctx.session.step = 'awaiting_name';
  });
});

// ─── /testtender ────────────────────────────────────────────────────────────
bot.command('testtender', (ctx) => {
  sendTender(ctx.chat.id, {
    id: 'TEND-001',
    title: 'Цемент М500 — 50 тонн',
    category: 'Цемент',
    quantity: '50 тонн',
    deadline: '28 июня 2026',
    location: 'Бишкек, Октябрьский район',
    budget: '200 000 сом',
    description: 'Нужен цемент марки М500 для строительства жилого комплекса. Доставка обязательна.',
  });
});

// ─── /mystatus ───────────────────────────────────────────────────────────────
bot.command('mystatus', (ctx) => {
  const sup = suppliers[ctx.chat.id];
  if (!sup) {
    return ctx.reply('Вы не зарегистрированы. Отправьте /start для регистрации.');
  }
  ctx.reply(
    `📋 Ваш профиль:\n\n👤 ${sup.name}\n📞 ${sup.phone}\n📦 Категории: ${sup.categories.join(', ')}`
  );
});

// ─── /help ───────────────────────────────────────────────────────────────────
bot.command('help', (ctx) => {
  ctx.reply(
    '📌 Команды:\n\n/start — регистрация поставщика\n/testtender — тестовый тендер\n/mystatus — ваш профиль\n/help — помощь'
  );
});

// ─── Message handler ─────────────────────────────────────────────────────────
bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const step = ctx.session?.step;

  if (step === 'awaiting_name') {
    ctx.session.name = text;
    ctx.session.step = 'awaiting_phone';
    return ctx.reply('Введите ваш номер телефона:\n(Пример: +996 700 123456)');
  }

  if (step === 'awaiting_phone') {
    ctx.session.phone = text;
    ctx.session.step = 'awaiting_categories';
    return ctx.reply(
      'Выберите ваши категории товаров (можно несколько):\nОтправьте номера через запятую.\n\n' +
      CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n') +
      '\n\nПример: 1, 2, 3'
    );
  }

  if (step === 'awaiting_categories') {
    const nums = text.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < CATEGORIES.length);
    if (nums.length === 0) {
      return ctx.reply('Пожалуйста, выберите хотя бы одну категорию (например: 1, 2)');
    }
    const chosen = nums.map(n => CATEGORIES[n]);
    suppliers[chatId] = {
      name: ctx.session.name,
      phone: ctx.session.phone,
      categories: chosen,
    };
    ctx.session.step = null;

    return ctx.reply(
      `✅ Регистрация завершена!\n\n👤 ${ctx.session.name}\n📞 ${ctx.session.phone}\n📦 Категории: ${chosen.join(', ')}\n\nТеперь вы будете получать тендеры по вашим категориям.\n\nПопробуйте /testtender чтобы увидеть тестовый тендер.`
    );
  }

  // Proposal text: "Цена: 185000 сом\nСрок: 3 дня"
  if (step && step.startsWith('proposal:')) {
    const tenderId = step.split(':')[1];
    const priceMatch = text.match(/Цена[:\s]+([^\n]+)/i);
    const deadlineMatch = text.match(/Срок[:\s]+([^\n]+)/i);

    if (!priceMatch || !deadlineMatch) {
      return ctx.reply(
        '⚠️ Неверный формат. Пожалуйста, отправьте:\n\nЦена: 185000 сом\nСрок: 3 дня'
      );
    }

    const price = priceMatch[1].trim();
    const deadline = deadlineMatch[1].trim();
    const sup = suppliers[chatId];

    if (!proposals[tenderId]) proposals[tenderId] = [];
    proposals[tenderId].push({
      supplierId: chatId,
      name: sup ? sup.name : 'Неизвестный',
      price,
      deadline,
    });

    ctx.session.step = null;
    return ctx.reply(
      `✅ Ваше предложение принято!\n\n📦 Тендер: ${tenderId}\n💰 Цена: ${price}\n⏱ Срок: ${deadline}\n\nМы передадим ваше предложение заказчику. Ожидайте ответа.`
    );
  }
});

// ─── Callback: подать предложение ────────────────────────────────────────────
bot.action(/^propose:(.+)$/, (ctx) => {
  const tenderId = ctx.match[1];
  ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.step = `proposal:${tenderId}`;

  ctx.reply(
    `📝 Подача предложения на тендер ${tenderId}\n\nОтправьте ваше предложение в формате:\n\nЦена: 185000 сом\nСрок: 3 дня`
  );
});

// ─── Callback: пропустить тендер ─────────────────────────────────────────────
bot.action(/^skip:(.+)$/, (ctx) => {
  ctx.answerCbQuery('Тендер пропущен');
  ctx.editMessageReplyMarkup(undefined);
  ctx.reply('⏭ Тендер пропущен. Ждите следующего.');
});

// ─── Helper: отправить тендер ────────────────────────────────────────────────
function sendTender(chatId, tender) {
  const text =
    `🏗 НОВЫЙ ТЕНДЕР #${tender.id}\n\n` +
    `📦 ${tender.title}\n` +
    `🗂 Категория: ${tender.category}\n` +
    `📊 Объём: ${tender.quantity}\n` +
    `📍 Локация: ${tender.location}\n` +
    `💰 Бюджет: ${tender.budget}\n` +
    `⏰ Срок подачи: ${tender.deadline}\n\n` +
    `📝 ${tender.description}`;

  bot.telegram.sendMessage(
    chatId,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подать предложение', `propose:${tender.id}`)],
      [Markup.button.callback('⏭ Пропустить', `skip:${tender.id}`)],
    ])
  );
}

// ─── Launch ──────────────────────────────────────────────────────────────────
bot.launch()
  .then(() => console.log('🏗 Кызмат.kg B2B Bot запущен'))
  .catch(err => {
    console.error('❌ Запуск не удался:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
