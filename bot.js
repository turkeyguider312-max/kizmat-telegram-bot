require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const { Pool }  = require('pg');

const BOT_TOKEN  = process.env.BOT_TOKEN;
const API_SECRET = process.env.API_SECRET || 'kizmat-secret-2026';
const PORT       = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN)    { console.error('❌ BOT_TOKEN не задан');    process.exit(1); }
if (!DATABASE_URL) { console.error('❌ DATABASE_URL не задан'); process.exit(1); }

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      chat_id    BIGINT PRIMARY KEY,
      name       TEXT,
      phone      TEXT,
      categories TEXT[],
      supplier_id TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers (
      chat_id    BIGINT PRIMARY KEY,
      name       TEXT,
      phone      TEXT,
      company    TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tenders (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      category_id TEXT,
      quantity    TEXT,
      budget      TEXT,
      deadline    TEXT,
      location    TEXT,
      description TEXT,
      customer_id BIGINT,
      status      TEXT DEFAULT 'active',
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id               SERIAL PRIMARY KEY,
      tender_id        TEXT REFERENCES tenders(id),
      supplier_chat_id BIGINT,
      supplier_name    TEXT,
      supplier_phone   TEXT,
      price            TEXT,
      delivery_days    TEXT,
      submitted_at     TIMESTAMP DEFAULT NOW(),
      rating           INTEGER,
      rating_comment   TEXT
    );
    CREATE SEQUENCE IF NOT EXISTS tender_seq START 1;
  `);
  // Добавляем новые поля если их ещё нет (безопасно для существующей БД)
  await pool.query(`
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS payment_type TEXT;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS payment_days INTEGER;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS qty_available TEXT;
  `);
  console.log('✅ База данных готова');
}

// ─── Категории kizmat.kg ──────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'cement',  name: 'Цемент и бетон',   hint: 'М400, М500, ЖБИ' },
  { id: 'metal',   name: 'Металл и арматура', hint: 'Прокат, профили' },
  { id: 'brick',   name: 'Кирпич и блоки',   hint: 'Газоблок, керамика' },
  { id: 'finish',  name: 'Отделка',           hint: 'Плитка, краска, обои' },
  { id: 'roofing', name: 'Кровля',            hint: 'Профнастил, черепица' },
  { id: 'insul',   name: 'Утепление',         hint: 'Минвата, пенопласт' },
  { id: 'plumb',   name: 'Сантехника',        hint: 'Трубы, фитинги' },
  { id: 'electro', name: 'Электрика',         hint: 'Кабели, щиты' },
  { id: 'windows', name: 'Окна и двери',      hint: 'ПВХ, металл, дерево' },
  { id: 'tools',   name: 'Инструменты',       hint: 'Электро, ручные' },
];
const catById = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// ─── DB helpers ───────────────────────────────────────────────────────────────
const n = (id) => Number(id); // всегда число для BIGINT

const db = {
  async getSupplier(chatId) {
    const r = await pool.query('SELECT * FROM suppliers WHERE chat_id=$1::bigint', [n(chatId)]);
    return r.rows[0] || null;
  },
  async saveSupplier(chatId, data) {
    await pool.query(`
      INSERT INTO suppliers(chat_id,name,phone,categories,supplier_id)
      VALUES($1::bigint,$2,$3,$4,$5)
      ON CONFLICT(chat_id) DO UPDATE
        SET name=$2, phone=$3, categories=$4, supplier_id=COALESCE($5,suppliers.supplier_id)
    `, [n(chatId), data.name, data.phone, data.categories, data.supplierId || null]);
  },
  async getCustomer(chatId) {
    const r = await pool.query('SELECT * FROM customers WHERE chat_id=$1::bigint', [n(chatId)]);
    return r.rows[0] || null;
  },
  async saveCustomer(chatId, data) {
    await pool.query(`
      INSERT INTO customers(chat_id,name,phone,company)
      VALUES($1::bigint,$2,$3,$4)
      ON CONFLICT(chat_id) DO UPDATE SET name=$2,phone=$3,company=$4
    `, [n(chatId), data.name, data.phone, data.company]);
  },
  async createTender(data) {
    const seq = await pool.query("SELECT NEXTVAL('tender_seq') AS n");
    const id  = `TEND-${String(seq.rows[0].n).padStart(3,'0')}`;
    await pool.query(`
      INSERT INTO tenders(id,title,category_id,quantity,budget,deadline,location,description,customer_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, data.title, data.categoryId, data.quantity, data.budget,
        data.deadline, data.location, data.desc || '', data.customerId || null]);
    return id;
  },
  async getTender(id) {
    const r = await pool.query('SELECT * FROM tenders WHERE id=$1', [id]);
    return r.rows[0] || null;
  },
  async getSuppliersByCategory(categoryId) {
    const r = await pool.query('SELECT * FROM suppliers WHERE $1=ANY(categories)', [categoryId]);
    return r.rows;
  },
  async saveProposal(data) {
    const r = await pool.query(`
      INSERT INTO proposals(tender_id,supplier_chat_id,supplier_name,supplier_phone,price,delivery_days,payment_type,payment_days,qty_available)
      VALUES($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [data.tenderId, n(data.chatId), data.name, data.phone, data.price, data.deadline,
        data.paymentType||null, data.paymentDays||null, data.qtyAvailable||null]);
    return r.rows[0].id;
  },
  async getProposals(tenderId) {
    const r = await pool.query('SELECT * FROM proposals WHERE tender_id=$1 ORDER BY submitted_at DESC', [tenderId]);
    return r.rows;
  },
  async saveRating(proposalId, rating, comment) {
    await pool.query('UPDATE proposals SET rating=$1,rating_comment=$2 WHERE id=$3', [rating, comment, proposalId]);
  },
  async getProposalById(id) {
    const r = await pool.query('SELECT * FROM proposals WHERE id=$1', [id]);
    return r.rows[0] || null;
  },
  async getAllTenders() {
    const r = await pool.query('SELECT * FROM tenders ORDER BY created_at DESC');
    return r.rows;
  },
  async getSupplierRating(chatId) {
    const r = await pool.query(
      'SELECT AVG(rating) as avg, COUNT(*) as total FROM proposals WHERE supplier_chat_id=$1::bigint AND rating IS NOT NULL',
      [n(chatId)]
    );
    return r.rows[0];
  },
};

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

// ── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const chatId  = ctx.chat.id;
  ctx.session   = {};

  if (payload?.startsWith('sup_')) {
    await pool.query(`
      INSERT INTO suppliers(chat_id,supplier_id) VALUES($1::bigint,$2)
      ON CONFLICT(chat_id) DO UPDATE SET supplier_id=$2
    `, [n(chatId), payload]);
    await ctx.reply('🔗 Аккаунт привязан к kizmat.kg!\n\nВведите ваше имя и компанию:');
    ctx.session.step = 'awaiting_name';
    ctx.session.role = 'supplier';
    return;
  }

  ctx.reply(
    '🏗 Добро пожаловать в Kizmat.kg B2B!\n\nКем вы являетесь?',
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Я поставщик', 'role_supplier')],
      [Markup.button.callback('🏢 Я заказчик',  'role_customer')],
    ])
  );
});

bot.action('role_supplier', (ctx) => {
  ctx.answerCbQuery();
  ctx.session.role = 'supplier';
  ctx.session.step = 'awaiting_name';
  ctx.editMessageText('📦 Регистрация поставщика\n\nВведите имя и компанию:\n(Пример: Алибек — ОсОО СтройСнаб)');
});

bot.action('role_customer', (ctx) => {
  ctx.answerCbQuery();
  ctx.session.role = 'customer';
  ctx.session.step = 'awaiting_name';
  ctx.editMessageText('🏢 Регистрация заказчика\n\nВведите имя и компанию:\n(Пример: Бекзат — ОсОО БишкекСтрой)');
});

// ── /newtender ────────────────────────────────────────────────────────────────
bot.command('newtender', async (ctx) => {
  const cus = await db.getCustomer(ctx.chat.id);
  if (!cus) return ctx.reply('⚠️ Сначала зарегистрируйтесь как заказчик — /start');
  ctx.session.step        = 'tender_title';
  ctx.session.tenderDraft = {};
  ctx.reply('📋 Создание тендера\n\nШаг 1/5: Введите название:\n(Пример: Цемент М500 — 50 тонн)');
});

// ── /testtender ───────────────────────────────────────────────────────────────
bot.command('testtender', (ctx) => {
  sendTenderToChat(ctx.chat.id, {
    id: 'TEST-001', title: 'Цемент М500 — 50 тонн', category_id: 'cement',
    quantity: '50 тонн', budget: '200 000 сом', deadline: '30 июня 2026',
    location: 'Бишкек, Октябрьский район', description: 'М500 для ЖК. Доставка обязательна.',
  });
});

// ── /mystatus ─────────────────────────────────────────────────────────────────
bot.command('mystatus', async (ctx) => {
  const chatId = ctx.chat.id;
  const sup = await db.getSupplier(chatId);
  if (sup) {
    const cats   = (sup.categories || []).map(id => catById[id]?.name || id).join(', ');
    const rating = await db.getSupplierRating(chatId);
    const stars  = rating.avg ? `⭐ ${parseFloat(rating.avg).toFixed(1)} (${rating.total} отзывов)` : 'Нет отзывов';
    return ctx.reply(`📋 Профиль поставщика:\n\n👤 ${sup.name}\n📞 ${sup.phone}\n📦 ${cats}\n${stars}`);
  }
  const cus = await db.getCustomer(chatId);
  if (cus) return ctx.reply(`📋 Профиль заказчика:\n\n👤 ${cus.name}\n📞 ${cus.phone}\n🏢 ${cus.company}`);
  ctx.reply('Вы не зарегистрированы. /start');
});

// ── /mycabinet ────────────────────────────────────────────────────────────────
bot.command('mycabinet', async (ctx) => {
  const chatId = ctx.chat.id;
  const sup = await db.getSupplier(chatId);
  const cus = await db.getCustomer(chatId);
  const base = process.env.APP_URL || 'https://worker-production-d53d.up.railway.app';
  if (sup) {
    return ctx.reply(
      `📦 Ваш личный кабинет поставщика:\n\n${base}/dashboard/supplier/${chatId}\n\nТам видны все ваши предложения, статусы и отзывы.`
    );
  }
  if (cus) {
    return ctx.reply(`🏢 Кабинет заказчика:\n\n${base}/dashboard`);
  }
  ctx.reply('Вы не зарегистрированы. /start');
});

// ── /help ─────────────────────────────────────────────────────────────────────
bot.command('help', (ctx) => ctx.reply(
  '📌 Команды:\n\n/start — регистрация\n/newtender — создать тендер (заказчик)\n/mycabinet — личный кабинет\n/testtender — тест\n/mystatus — профиль\n/help — помощь'
));

// ── Текстовые сообщения ───────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text   = ctx.message.text.trim();
  const step   = ctx.session?.step;

  // Регистрация: имя
  if (step === 'awaiting_name') {
    ctx.session.name = text;
    ctx.session.step = 'awaiting_phone';
    return ctx.reply('📞 Введите номер телефона:\n(Пример: +996 700 123456)');
  }

  // Регистрация: телефон
  if (step === 'awaiting_phone') {
    ctx.session.phone = text;
    if (ctx.session.role === 'customer') {
      ctx.session.step = 'awaiting_company';
      return ctx.reply('🏢 Введите название компании:');
    }
    ctx.session.step = 'awaiting_categories';
    const list = CATEGORIES.map((c, i) => `${i+1}. ${c.name} (${c.hint})`).join('\n');
    return ctx.reply(`📦 Выберите категории (номера через запятую):\n\n${list}\n\nПример: 1, 2, 3`);
  }

  // Заказчик: компания
  if (step === 'awaiting_company') {
    await db.saveCustomer(chatId, { name: ctx.session.name, phone: ctx.session.phone, company: text });
    ctx.session.step = null;
    return ctx.reply(`✅ Регистрация завершена!\n\n👤 ${ctx.session.name}\n📞 ${ctx.session.phone}\n🏢 ${text}\n\nИспользуйте /newtender для тендера.`);
  }

  // Поставщик: категории
  if (step === 'awaiting_categories') {
    const nums = text.split(',').map(n => parseInt(n.trim())-1).filter(n => n>=0 && n<CATEGORIES.length);
    if (!nums.length) return ctx.reply('⚠️ Укажите хотя бы одну категорию. Пример: 1, 2');
    const chosen = nums.map(n => CATEGORIES[n].id);
    await db.saveSupplier(chatId, { name: ctx.session.name, phone: ctx.session.phone, categories: chosen });
    ctx.session.step = null;
    const catNames = chosen.map(id => catById[id].name).join(', ');
    return ctx.reply(`✅ Регистрация завершена!\n\n👤 ${ctx.session.name}\n📞 ${ctx.session.phone}\n📦 ${catNames}\n\nВы будете получать тендеры по вашим категориям.`);
  }

  // Тендер: шаги
  if (step === 'tender_title') {
    ctx.session.tenderDraft.title = text;
    ctx.session.step = 'tender_category';
    const list = CATEGORIES.map((c,i) => `${i+1}. ${c.name}`).join('\n');
    return ctx.reply(`Шаг 2/5: Выберите категорию (номер):\n\n${list}`);
  }
  if (step === 'tender_category') {
    const n = parseInt(text)-1;
    if (isNaN(n) || n<0 || n>=CATEGORIES.length) return ctx.reply('⚠️ Введите номер от 1 до 10');
    ctx.session.tenderDraft.categoryId = CATEGORIES[n].id;
    ctx.session.step = 'tender_quantity';
    return ctx.reply('Шаг 3/5: Объём/количество:\n(Пример: 50 тонн)');
  }
  if (step === 'tender_quantity') {
    ctx.session.tenderDraft.quantity = text;
    ctx.session.step = 'tender_budget';
    return ctx.reply('Шаг 4/5: Бюджет:\n(Пример: 200 000 сом)');
  }
  if (step === 'tender_budget') {
    ctx.session.tenderDraft.budget = text;
    ctx.session.step = 'tender_deadline';
    return ctx.reply('Шаг 5/5: Срок подачи предложений:\n(Пример: 30 июня 2026)');
  }
  if (step === 'tender_deadline') {
    const draft = ctx.session.tenderDraft;
    const cus   = await db.getCustomer(chatId);
    const id    = await db.createTender({
      ...draft, deadline: text,
      customerId: chatId,
      location: cus?.company || 'Бишкек',
    });
    ctx.session.step = null;
    await ctx.reply(`✅ Тендер #${id} создан!\n\nРассылаем уведомления поставщикам...`);
    await notifySuppliers(id);
    return;
  }

  // Предложение — шаг 1: цена
  if (step === 'proposal_price') {
    if (!text) return ctx.reply('Введите цену (например: 185 000 сом)');
    ctx.session.proposalDraft.price = text.trim();
    ctx.session.step = 'proposal_deadline';
    return ctx.reply('⏱ Шаг 2/4: Срок поставки?\n(Пример: 5 дней, 2 недели)');
  }

  // Предложение — шаг 2: срок поставки
  if (step === 'proposal_deadline') {
    ctx.session.proposalDraft.deadline = text.trim();
    ctx.session.step = 'proposal_payment';
    return ctx.reply('💳 Шаг 3/4: Тип оплаты?',
      Markup.inlineKeyboard([
        [Markup.button.callback('💵 Наличные', 'pay_type:наличные')],
        [Markup.button.callback('🏦 Безналичный расчёт', 'pay_type:безнал')],
        [Markup.button.callback('⏳ Отсрочка платежа', 'pay_type:отсрочка')],
      ])
    );
  }

  // Предложение — шаг 3б: срок отсрочки (только если выбрана отсрочка)
  if (step === 'proposal_paydays') {
    const days = text.match(/\d+/);
    ctx.session.proposalDraft.paymentDays = days ? parseInt(days[0]) : null;
    ctx.session.step = 'proposal_qty';
    return ctx.reply('📦 Шаг 4/4: Сколько товара есть в наличии?\n(Пример: весь объём / 50 тонн / частично — под заказ остаток)');
  }

  // Предложение — шаг 4: наличие товара
  if (step === 'proposal_qty') {
    const draft = ctx.session.proposalDraft;
    draft.qtyAvailable = text.trim();
    ctx.session.step = null;
    const sup = await db.getSupplier(chatId);
    const pid = await db.saveProposal({
      tenderId:     draft.tenderId,
      chatId,
      name:         sup?.name  || 'Неизвестный',
      phone:        sup?.phone || '—',
      price:        draft.price,
      deadline:     draft.deadline,
      paymentType:  draft.paymentType,
      paymentDays:  draft.paymentDays,
      qtyAvailable: draft.qtyAvailable,
    });
    ctx.session.proposalDraft = null;
    const payLabel = draft.paymentType === 'отсрочка'
      ? `Отсрочка ${draft.paymentDays ? draft.paymentDays + ' дней' : ''}`
      : draft.paymentType === 'безнал' ? 'Безнал' : 'Наличные';
    await ctx.reply(
      `✅ Предложение принято!\n\n` +
      `📦 Тендер: ${draft.tenderId}\n` +
      `💰 Цена: ${draft.price}\n` +
      `⏱ Срок поставки: ${draft.deadline}\n` +
      `💳 Оплата: ${payLabel}\n` +
      `📦 Наличие: ${draft.qtyAvailable}\n\n` +
      `Передаём заказчику.`
    );
    await notifyCustomer(draft.tenderId, {
      name: sup?.name, phone: sup?.phone,
      price: draft.price, deadline: draft.deadline,
      paymentType: draft.paymentType, paymentDays: draft.paymentDays,
      qtyAvailable: draft.qtyAvailable, id: pid,
    });
    return;
  }

  // Рейтинг: комментарий
  if (step?.startsWith('rate_comment:')) {
    const [, proposalId, rating] = step.split(':');
    await db.saveRating(Number(proposalId), Number(rating), text);
    ctx.session.step = null;
    return ctx.reply(`✅ Отзыв сохранён! Спасибо за оценку.`);
  }
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.action(/^propose:(.+)$/, (ctx) => {
  const tenderId = ctx.match[1];
  ctx.answerCbQuery();
  ctx.session.proposalDraft = { tenderId };
  ctx.session.step = 'proposal_price';
  ctx.reply(`📝 Подача предложения на тендер ${tenderId}\n\n💰 Шаг 1/4: Укажите вашу цену\n(Пример: 185 000 сом)`);
});

// Тип оплаты
bot.action(/^pay_type:(.+)$/, async (ctx) => {
  const type = ctx.match[1];
  ctx.answerCbQuery();
  if (!ctx.session.proposalDraft) return ctx.reply('⚠️ Начните заново через /start');
  ctx.session.proposalDraft.paymentType = type;
  if (type === 'отсрочка') {
    ctx.session.step = 'proposal_paydays';
    ctx.editMessageText(`⏳ На сколько дней отсрочка?\n(Пример: 30 дней, 45 дней)`);
  } else {
    ctx.session.step = 'proposal_qty';
    const label = type === 'безнал' ? '🏦 Безнал' : '💵 Наличные';
    ctx.editMessageText(`${label} выбран.\n\n📦 Шаг 4/4: Сколько товара есть в наличии?\n(Пример: весь объём / 50 тонн / частично — под заказ остаток)`);
  }
});

bot.action(/^skip:(.+)$/, (ctx) => {
  ctx.answerCbQuery('Пропущен');
  ctx.editMessageReplyMarkup(undefined);
  ctx.reply('⏭ Тендер пропущен.');
});

// Рейтинг: 1-5 звёзд
bot.action(/^rate:(\d+):(\d+)$/, async (ctx) => {
  const proposalId = ctx.match[1];
  const rating     = Number(ctx.match[2]);
  ctx.answerCbQuery();
  ctx.session.step = `rate_comment:${proposalId}:${rating}`;
  const stars = '⭐'.repeat(rating);
  ctx.editMessageText(`${stars} Вы поставили оценку ${rating}/5\n\nНапишите короткий комментарий (или отправьте "-" чтобы пропустить):`);
});

// ─── Хелперы ──────────────────────────────────────────────────────────────────
function sendTenderToChat(chatId, tender) {
  const cat  = catById[tender.category_id] || { name: tender.category_id };
  const text =
    `🏗 НОВЫЙ ТЕНДЕР #${tender.id}\n\n` +
    `📦 ${tender.title}\n` +
    `🗂 Категория: ${cat.name}\n` +
    `📊 Объём: ${tender.quantity}\n` +
    `📍 Локация: ${tender.location}\n` +
    `💰 Бюджет: ${tender.budget}\n` +
    `⏰ Срок подачи: ${tender.deadline}` +
    (tender.description ? `\n\n📝 ${tender.description}` : '');

  return bot.telegram.sendMessage(chatId, text,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подать предложение', `propose:${tender.id}`)],
      [Markup.button.callback('⏭ Пропустить',         `skip:${tender.id}`)],
    ])
  ).catch(() => {});
}

async function notifySuppliers(tenderId) {
  const tender    = await db.getTender(tenderId);
  if (!tender) return;
  const suppliers = await db.getSuppliersByCategory(tender.category_id);
  for (const sup of suppliers) sendTenderToChat(Number(sup.chat_id), tender);
  console.log(`📤 Тендер ${tenderId} → ${suppliers.length} поставщиков`);
}

async function notifyCustomer(tenderId, proposal) {
  const tender = await db.getTender(tenderId);
  if (!tender?.customer_id) return;
  const payLabel = proposal.paymentType === 'отсрочка'
    ? `Отсрочка ${proposal.paymentDays ? proposal.paymentDays + ' дней' : ''}`
    : proposal.paymentType === 'безнал' ? 'Безнал' : (proposal.paymentType || '—');
  await bot.telegram.sendMessage(
    tender.customer_id,
    `📬 Новое предложение на тендер #${tenderId}!\n\n` +
    `👤 ${proposal.name}\n` +
    `📞 ${proposal.phone}\n` +
    `💰 Цена: ${proposal.price}\n` +
    `⏱ Срок поставки: ${proposal.deadline}\n` +
    `💳 Оплата: ${payLabel}\n` +
    `📦 Наличие: ${proposal.qtyAvailable || '—'}\n\n` +
    `Оцените поставщика после выполнения:`,
    Markup.inlineKeyboard([
      [1,2,3,4,5].map(n => Markup.button.callback('⭐'.repeat(n>3?1:n)+n, `rate:${proposal.id}:${n}`))
    ])
  ).catch(() => {});
}

// ─── Express API + Dashboard ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static('public'));

function checkSecret(req, res) {
  if (req.headers['x-api-key'] !== API_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsePrice(str) {
  return parseInt((str || '0').replace(/\D/g, '')) || 0;
}
function parseDays(str) {
  const m = (str || '').match(/(\d+)/);
  return m ? parseInt(m[1]) : 99;
}
function tenderStatus(t, propCount) {
  if (t.status === 'closed') return { label: '✅ Выбран победитель', cls: 'won' };
  const d = new Date(t.created_at);
  const now = new Date();
  const diffDays = Math.ceil((now - d) / 86400000);
  if (diffDays > 30) return { label: '🔴 Истёк', cls: 'expired' };
  if (diffDays > 20) return { label: '🟡 Закрывается', cls: 'closing' };
  return { label: '🟢 Открыт', cls: 'open' };
}
function scoreProposals(proposals) {
  if (!proposals.length) return [];
  const prices  = proposals.map(p => parsePrice(p.price));
  const days    = proposals.map(p => parseDays(p.delivery_days));
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const minD = Math.min(...days),   maxD = Math.max(...days);
  return proposals.map((p, i) => {
    const pScore = maxP === minP ? 60 : ((maxP - prices[i]) / (maxP - minP)) * 60;
    const dScore = maxD === minD ? 30 : ((maxD - days[i])   / (maxD - minD)) * 30;
    const rScore = p.rating ? (p.rating / 5) * 10 : 5;
    return { ...p, score: Math.round(pScore + dScore + rScore) };
  }).sort((a, b) => b.score - a.score);
}
const CSS = `
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;background:#f1f5f9;color:#1e293b}
  .hdr{background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;padding:18px 36px;display:flex;align-items:center;gap:12px}
  .hdr h1{margin:0;font-size:22px;font-weight:700}
  .wrap{padding:28px 36px}
  .filters{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .filters select,.filters input{padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;background:#fff}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08)}
  th{background:#1e40af;color:#fff;padding:12px 14px;text-align:left;font-size:13px;font-weight:600}
  td{padding:12px 14px;border-bottom:1px solid #f1f5f9;font-size:14px;vertical-align:middle}
  tr:last-child td{border:none}
  tr:hover td{background:#f8faff}
  a{color:#2563eb;text-decoration:none;font-weight:500}
  a:hover{text-decoration:underline}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .open{background:#dcfce7;color:#15803d}
  .closing{background:#fef9c3;color:#854d0e}
  .expired{background:#fee2e2;color:#b91c1c}
  .won{background:#ede9fe;color:#6d28d9}
  .card{background:#fff;border-radius:10px;padding:22px;margin-bottom:20px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .stat-card{background:#fff;border-radius:10px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.08);text-align:center}
  .stat-card .val{font-size:24px;font-weight:700;color:#2563eb}
  .stat-card .lbl{font-size:12px;color:#64748b;margin-top:4px}
  .corridor{background:#fff;border-radius:10px;padding:20px;margin-bottom:20px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
  .corridor h3{margin:0 0 14px;font-size:16px}
  .bar-wrap{position:relative;height:8px;background:#e2e8f0;border-radius:4px;margin:16px 0}
  .bar-fill{height:100%;background:linear-gradient(90deg,#22c55e,#f59e0b,#ef4444);border-radius:4px}
  .medals{font-size:22px}
  .score-badge{display:inline-block;background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:700}
`;

// Dashboard — главная (Sinteka-style procurement dashboard)
app.get('/dashboard', async (req, res) => {
  const catFilter    = req.query.cat    || '';
  const statusFilter = req.query.status || '';
  const search       = (req.query.q    || '').toLowerCase();
  const sortBy       = req.query.sort  || 'date';

  let tenders = await db.getAllTenders();
  if (catFilter)                  tenders = tenders.filter(t => t.category_id === catFilter);
  if (statusFilter === 'active')  tenders = tenders.filter(t => t.status !== 'closed');
  if (statusFilter === 'closed')  tenders = tenders.filter(t => t.status === 'closed');
  if (search) tenders = tenders.filter(t =>
    t.title.toLowerCase().includes(search) || t.id.toLowerCase().includes(search)
  );

  const rows = await Promise.all(tenders.map(async t => {
    const props  = await db.getProposals(t.id);
    const cat    = catById[t.category_id]?.name || t.category_id;
    const st     = tenderStatus(t, props.length);
    const scored = scoreProposals(props);
    const best   = scored[0];
    const rated  = props.filter(p => p.rating).length;
    return { t, props, cat, st, best, rated, scored };
  }));

  if (sortBy === 'props')  rows.sort((a,b) => b.props.length - a.props.length);
  if (sortBy === 'budget') rows.sort((a,b) => parsePrice(b.t.budget) - parsePrice(a.t.budget));

  // Сводная статистика
  const totalTenders = rows.length;
  const openTenders  = rows.filter(r => r.st.cls === 'open' || r.st.cls === 'closing').length;
  const totalProps   = rows.reduce((s, r) => s + r.props.length, 0);
  const needsAction  = rows.filter(r => r.props.length > 0 && r.st.cls !== 'won').length;

  const catOptions = CATEGORIES.map(c =>
    `<option value="${c.id}" ${catFilter===c.id?'selected':''}>${c.name}</option>`
  ).join('');

  // Строки таблицы
  const tableRows = rows.map(({ t, props, cat, st, best, rated, scored }) => {
    // Pipeline-бары (как в Синтека): поданные / без выбора / завершённые
    const pending  = props.length - rated;
    const pipeline = `
      <div class="pipeline">
        ${props.length  ? `<span class="pip-new"  title="Всего предложений">${props.length}</span>` : '<span class="pip-zero">—</span>'}
        ${pending > 0   ? `<span class="pip-pend" title="Ожидают выбора">${pending}</span>` : ''}
        ${rated > 0     ? `<span class="pip-done" title="Оценены/Завершены">${rated}</span>` : ''}
      </div>`;

    const bestCell = best
      ? `<div style="font-weight:700;color:#15803d">${best.price}</div>
         <div style="font-size:11px;color:#64748b">${best.supplier_name}</div>`
      : `<span style="color:#cbd5e1">нет</span>`;

    const lastAct = props.length
      ? new Date(Math.max(...props.map(p => new Date(p.submitted_at)))).toLocaleDateString('ru-RU')
      : new Date(t.created_at).toLocaleDateString('ru-RU');

    return `<tr>
      <td style="font-weight:700;color:#1e40af;white-space:nowrap">
        <a href="/dashboard/tender/${t.id}" style="color:#1e40af">${t.id}</a>
      </td>
      <td>
        <div style="font-weight:600;font-size:14px">${t.title}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${cat}</div>
      </td>
      <td style="font-size:13px;color:#475569">${t.budget}</td>
      <td style="font-size:12px;color:#64748b;white-space:nowrap">${t.deadline}</td>
      <td>${pipeline}</td>
      <td>${bestCell}</td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
      <td style="font-size:12px;color:#94a3b8;white-space:nowrap">${lastAct}</td>
      <td>
        <a class="btn-action" href="/dashboard/tender/${t.id}">Предложения</a>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:40px;font-size:15px">Тендеров нет — создайте первый в боте @kizmattbot</td></tr>`;

  const DASH_CSS = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#f0f4f8;color:#1e293b}
    /* Topbar */
    .topbar{background:#1565c0;display:flex;align-items:center;padding:0 24px;height:52px;gap:0}
    .topbar .logo{color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;margin-right:32px;display:flex;align-items:center;gap:8px}
    .topbar nav{display:flex;height:100%}
    .topbar nav a{color:rgba(255,255,255,.75);font-size:14px;font-weight:500;padding:0 18px;display:flex;align-items:center;border-bottom:3px solid transparent;text-decoration:none;transition:all .15s}
    .topbar nav a.active,.topbar nav a:hover{color:#fff;border-bottom-color:#fff}
    .topbar .user{margin-left:auto;color:rgba(255,255,255,.8);font-size:13px;display:flex;align-items:center;gap:8px}
    /* Toolbar */
    .toolbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:10px 24px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .btn-create{background:#1565c0;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    .btn-create:hover{background:#1251a3}
    .search-wrap{display:flex;gap:6px;flex:1;min-width:200px}
    .search-wrap input{flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:7px 12px;font-size:13px;outline:none}
    .search-wrap input:focus{border-color:#1565c0}
    .search-wrap button{background:#1565c0;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer}
    .toolbar select{border:1px solid #cbd5e1;border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none}
    /* Stats bar */
    .statsbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:8px 24px;display:flex;gap:28px}
    .stat-item{display:flex;align-items:center;gap:6px;font-size:13px;color:#475569}
    .stat-item b{color:#1e293b}
    .stat-item .dot{width:8px;height:8px;border-radius:50%}
    /* Table */
    .tbl-wrap{padding:16px 24px}
    .tbl-info{font-size:13px;color:#64748b;margin-bottom:10px}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)}
    th{background:#1e3a8a;color:#fff;padding:10px 14px;text-align:left;font-size:12px;font-weight:600;white-space:nowrap}
    td{padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:top}
    tr:last-child td{border:none}
    tr:hover td{background:#f8faff}
    /* Pipeline badges */
    .pipeline{display:flex;gap:4px;align-items:center}
    .pip-new{background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;min-width:24px;text-align:center}
    .pip-pend{background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;min-width:24px;text-align:center}
    .pip-done{background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;min-width:24px;text-align:center}
    .pip-zero{color:#cbd5e1;font-size:13px}
    /* Status badges */
    .badge{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600}
    .open{background:#dcfce7;color:#15803d}
    .closing{background:#fef9c3;color:#854d0e}
    .expired{background:#fee2e2;color:#b91c1c}
    .won{background:#ede9fe;color:#6d28d9}
    /* Actions */
    .btn-action{display:inline-block;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#eff6ff;color:#1d4ed8;text-decoration:none;white-space:nowrap}
    .btn-action:hover{background:#dbeafe}
    /* Legend */
    .legend{display:flex;gap:16px;padding:8px 24px 16px;font-size:12px;color:#64748b}
    .legend span{display:flex;align-items:center;gap:4px}
  `;

  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kizmat.kg — Тендеры</title>
<style>${DASH_CSS}</style></head>
<body>

<!-- Topbar (как в Синтека) -->
<div class="topbar">
  <div class="logo">🏗 Kizmat.kg</div>
  <nav>
    <a href="/dashboard" class="active">Тендеры</a>
  </nav>
  <div class="user">📱 @kizmattbot</div>
</div>

<!-- Toolbar: создать + поиск + фильтры -->
<form method="get" action="/dashboard">
<div class="toolbar">
  <a class="btn-create" href="https://t.me/kizmattbot" target="_blank">+ Создать тендер</a>
  <div class="search-wrap">
    <input name="q" value="${search}" placeholder="Поиск по названию или ID...">
    <button type="submit">Найти</button>
  </div>
  <select name="cat" onchange="this.form.submit()">
    <option value="">Все категории</option>${catOptions}
  </select>
  <select name="status" onchange="this.form.submit()">
    <option value="" ${!statusFilter?'selected':''}>Все статусы</option>
    <option value="active" ${statusFilter==='active'?'selected':''}>Активные</option>
    <option value="closed" ${statusFilter==='closed'?'selected':''}>Завершённые</option>
  </select>
  <select name="sort" onchange="this.form.submit()">
    <option value="date"   ${sortBy==='date'  ?'selected':''}>По дате</option>
    <option value="props"  ${sortBy==='props' ?'selected':''}>По предложениям</option>
    <option value="budget" ${sortBy==='budget'?'selected':''}>По бюджету</option>
  </select>
</div>
</form>

<!-- Сводная статистика -->
<div class="statsbar">
  <div class="stat-item"><div class="dot" style="background:#1565c0"></div>Всего тендеров: <b>${totalTenders}</b></div>
  <div class="stat-item"><div class="dot" style="background:#15803d"></div>Активных: <b>${openTenders}</b></div>
  <div class="stat-item"><div class="dot" style="background:#d97706"></div>Предложений получено: <b>${totalProps}</b></div>
  <div class="stat-item"><div class="dot" style="background:#dc2626"></div>Ожидают выбора: <b>${needsAction}</b></div>
</div>

<!-- Таблица -->
<div class="tbl-wrap">
  <div class="tbl-info">Тендеров в списке: <b>${rows.length}</b></div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Название / Категория</th>
        <th>Бюджет</th>
        <th>Срок подачи</th>
        <th style="white-space:nowrap">
          Предложения
          <div style="font-weight:400;font-size:10px;margin-top:2px;opacity:.8">
            🔵 всего &nbsp; 🟡 ожидают &nbsp; 🟢 завершены
          </div>
        </th>
        <th>Лучшая цена</th>
        <th>Статус</th>
        <th>Активность</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</div>

</body></html>`);
});

// Детали тендера — с ранжированием и коридором цен
app.get('/dashboard/tender/:id', async (req, res) => {
  const tender = await db.getTender(req.params.id);
  if (!tender) return res.status(404).send('Тендер не найден');
  const rawProposals = await db.getProposals(req.params.id);
  const cat      = catById[tender.category_id]?.name || tender.category_id;
  const scored   = scoreProposals(rawProposals);
  const medals   = ['🥇','🥈','🥉'];

  // Коридор цен
  let corridorHtml = '';
  if (scored.length) {
    const prices  = scored.map(p => parsePrice(p.price));
    const minP    = Math.min(...prices), maxP = Math.max(...prices);
    const avgP    = Math.round(prices.reduce((a,b)=>a+b,0)/prices.length);
    const budgetP = parsePrice(tender.budget);
    const saving  = budgetP ? Math.round((budgetP-minP)/budgetP*100) : 0;
    const pct     = maxP>minP ? Math.round((avgP-minP)/(maxP-minP)*100) : 50;
    corridorHtml = `
    <div class="corridor">
      <h3>📊 Аналитика по тендеру</h3>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div><span style="color:#15803d;font-weight:700;font-size:18px">${minP.toLocaleString('ru')} сом</span><br><span style="font-size:12px;color:#64748b">💰 Минимум</span></div>
        <div><span style="color:#d97706;font-weight:700;font-size:18px">${avgP.toLocaleString('ru')} сом</span><br><span style="font-size:12px;color:#64748b">📊 Средняя</span></div>
        <div><span style="color:#dc2626;font-weight:700;font-size:18px">${maxP.toLocaleString('ru')} сом</span><br><span style="font-size:12px;color:#64748b">💸 Максимум</span></div>
        ${budgetP ? `<div><span style="color:#7c3aed;font-weight:700;font-size:18px">${budgetP.toLocaleString('ru')} сом</span><br><span style="font-size:12px;color:#64748b">🎯 Бюджет</span></div>` : ''}
      </div>
      <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#94a3b8">
        <span>${minP.toLocaleString('ru')}</span><span>${maxP.toLocaleString('ru')}</span>
      </div>
      ${saving>0 ? `<div style="margin-top:12px;padding:8px 14px;background:#dcfce7;border-radius:8px;color:#15803d;font-size:14px;font-weight:600">✅ Лучшее предложение экономит ${saving}% от бюджета</div>` : ''}
    </div>`;
  }

  // Таблица с рейтингом
  const pRows = scored.length ? scored.map((p, i) => {
    const medal = medals[i] || `${i+1}.`;
    const stars = p.rating ? '⭐'.repeat(p.rating) : '—';
    const isTop = i === 0;
    let payBadge = '—';
    if (p.payment_type === 'безнал')    payBadge = '<span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:12px;font-size:12px">🏦 Безнал</span>';
    if (p.payment_type === 'наличные')  payBadge = '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:12px;font-size:12px">💵 Нал</span>';
    if (p.payment_type === 'отсрочка')  payBadge = `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:12px;font-size:12px">⏳ Отсрочка${p.payment_days?` ${p.payment_days}д`:''}</span>`;
    return `<tr style="${isTop?'background:#f0fdf4':''}">
      <td><span class="medals">${medal}</span></td>
      <td><b>${p.supplier_name}</b><br><span style="font-size:12px;color:#64748b">${p.supplier_phone}</span></td>
      <td><b style="color:${isTop?'#15803d':'inherit'};font-size:16px">${p.price}</b></td>
      <td>${p.delivery_days}</td>
      <td>${payBadge}</td>
      <td>${p.qty_available||'—'}</td>
      <td><span class="score-badge">${p.score} баллов</span></td>
      <td>${stars}</td>
      <td>${new Date(p.submitted_at).toLocaleDateString('ru-RU')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:32px">Предложений пока нет</td></tr>`;

  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Тендер ${tender.id}</title>
<style>${CSS}</style></head>
<body>
<div class="hdr"><span style="font-size:28px">🏗</span><h1>Тендер ${tender.id} — ${tender.title}</h1></div>
<div class="wrap">
  <a href="/dashboard" style="color:#94a3b8;font-size:14px">← Все тендеры</a>
  <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin:16px 0">
    <div class="card">
      <h2 style="margin:0 0 12px">${tender.title}</h2>
      <p style="margin:6px 0">🗂 <b>Категория:</b> ${cat}</p>
      <p style="margin:6px 0">📊 <b>Объём:</b> ${tender.quantity}</p>
      <p style="margin:6px 0">💰 <b>Бюджет:</b> ${tender.budget}</p>
      <p style="margin:6px 0">⏰ <b>Срок подачи:</b> ${tender.deadline}</p>
      <p style="margin:6px 0">📍 <b>Локация:</b> ${tender.location}</p>
    </div>
    <div class="card" style="text-align:center;display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:48px;font-weight:800;color:#2563eb">${scored.length}</div>
      <div style="color:#64748b;font-size:14px">предложений</div>
      ${scored[0]?`<div style="margin-top:12px;padding:8px;background:#dcfce7;border-radius:8px;color:#15803d;font-weight:600">🥇 Лучшая: ${scored[0].price}</div>`:''}
    </div>
  </div>
  ${corridorHtml}
  <h2 style="margin:0 0 12px">Предложения (${scored.length}) — ранжированы по баллам</h2>
  <p style="color:#64748b;font-size:13px;margin:0 0 16px">Формула: 60% цена + 30% срок + 10% рейтинг поставщика</p>
  <table>
    <thead><tr><th>#</th><th>Поставщик</th><th>Цена</th><th>Срок поставки</th><th>Оплата</th><th>Наличие</th><th>Балл</th><th>Оценка</th><th>Дата</th></tr></thead>
    <tbody>${pRows}</tbody>
  </table>
</div></body></html>`);
});

// Кабинет поставщика
app.get('/dashboard/supplier/:chatId', async (req, res) => {
  const chatId = req.params.chatId;
  const sup = await pool.query('SELECT * FROM suppliers WHERE chat_id=$1::bigint', [n(chatId)]);
  if (!sup.rows[0]) return res.status(404).send('Поставщик не найден');
  const s = sup.rows[0];
  const cats = (s.categories || []).map(id => catById[id]?.name || id).join(', ');

  const ratingR = await db.getSupplierRating(chatId);
  const avgRating = ratingR.avg ? `⭐ ${parseFloat(ratingR.avg).toFixed(1)} (${ratingR.total} отзывов)` : 'Нет отзывов';

  const propsR = await pool.query(`
    SELECT p.*, t.title as tender_title, t.budget, t.category_id
    FROM proposals p JOIN tenders t ON p.tender_id=t.id
    WHERE p.supplier_chat_id=$1::bigint ORDER BY p.submitted_at DESC
  `, [n(chatId)]);

  let pRows = '';
  for (const p of propsR.rows) {
    const stars = p.rating ? '⭐'.repeat(p.rating) : '—';
    const status = p.rating ? `<span style="color:#16a34a">Завершён</span>` : `<span style="color:#2563eb">В работе</span>`;
    pRows += `<tr>
      <td><a href="/dashboard/supplier/${chatId}/tender/${p.tender_id}">${p.tender_id}</a></td>
      <td>${p.tender_title}</td>
      <td><b>${p.price}</b></td>
      <td>${p.delivery_days}</td>
      <td>${status}</td>
      <td>${stars}</td>
      <td>${p.rating_comment || '—'}</td>
      <td>${new Date(p.submitted_at).toLocaleDateString('ru-RU')}</td>
    </tr>`;
  }

  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Кабинет поставщика</title>
<style>
  body{font-family:sans-serif;margin:0;background:#f5f5f5}
  .header{background:#16a34a;color:#fff;padding:20px 40px}
  .header h1{margin:0;font-size:24px}
  .content{padding:30px 40px}
  .card{background:#fff;border-radius:8px;padding:24px;margin-bottom:24px;box-shadow:0 1px 4px rgba(0,0,0,.1);display:flex;gap:40px}
  .stat{text-align:center}
  .stat .num{font-size:32px;font-weight:bold;color:#16a34a}
  .stat .label{font-size:13px;color:#666;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  th{background:#15803d;color:#fff;padding:12px 16px;text-align:left;font-size:13px}
  td{padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:14px}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f0fdf4}
  a{color:#16a34a;text-decoration:none}
</style></head>
<body>
  <div class="header"><h1>📦 Кабинет поставщика</h1></div>
  <div class="content">
    <div class="card" style="margin-top:16px;align-items:center">
      <div style="flex:1">
        <h2 style="margin:0">${s.name}</h2>
        <p style="margin:8px 0;color:#555">📞 ${s.phone}</p>
        <p style="margin:0;color:#555">📦 ${cats}</p>
      </div>
      <div class="stat"><div class="num">${propsR.rows.length}</div><div class="label">Предложений</div></div>
      <div class="stat"><div class="num">${ratingR.avg ? parseFloat(ratingR.avg).toFixed(1) : '—'}</div><div class="label">${avgRating}</div></div>
    </div>
    <h2>Мои предложения (${propsR.rows.length})</h2>
    <table>
      <thead><tr><th>Тендер</th><th>Название</th><th>Цена</th><th>Срок</th><th>Статус</th><th>Оценка</th><th>Отзыв</th><th>Дата</th></tr></thead>
      <tbody>${pRows || '<tr><td colspan="8" style="text-align:center;color:#999">Предложений пока нет</td></tr>'}</tbody>
    </table>
  </div>
</body></html>`);
});

// Страница поставщика — его предложение по конкретному тендеру
app.get('/dashboard/supplier/:chatId/tender/:tenderId', async (req, res) => {
  const { chatId, tenderId } = req.params;

  const [supR, tenderR, allPropsR] = await Promise.all([
    pool.query('SELECT * FROM suppliers WHERE chat_id=$1::bigint', [n(chatId)]),
    db.getTender(tenderId),
    db.getProposals(tenderId),
  ]);

  const sup    = supR.rows[0];
  const tender = tenderR;
  if (!sup || !tender) return res.status(404).send('Не найдено');

  // Предложение этого поставщика
  const myProp = allPropsR.find(p => String(p.supplier_chat_id) === String(chatId));
  const cat    = catById[tender.category_id]?.name || tender.category_id;

  // Позиция поставщика — только цифра позиции и цвет, без чужих цен
  const scored   = scoreProposals(allPropsR);
  const myScored = scored.find(p => String(p.supplier_chat_id) === String(chatId));
  const myRank   = myScored ? scored.indexOf(myScored) + 1 : null;
  const total    = scored.length;

  // Цвет позиции: зелёный (топ-треть) → коричневый (середина) → красный (аутсайдер)
  let posColor = '#64748b', posLabel = '—', posText = '', barPct = 0;
  if (myRank && total > 0) {
    // Сравниваем нашу цену с лучшей
    const myPrice  = parsePrice(myProp?.price || '0');
    const minPrice = Math.min(...allPropsR.map(p => parsePrice(p.price)));
    const maxPrice = Math.max(...allPropsR.map(p => parsePrice(p.price)));
    const range    = maxPrice - minPrice;

    // Позиция в диапазоне 0..1 (0=лучшая=зелёная, 1=худшая=красная)
    barPct = range > 0 ? Math.round(((myPrice - minPrice) / range) * 100) : 0;

    if (barPct <= 15) {
      posColor = '#15803d'; posLabel = 'Конкурентная';
      posText = 'Ваша цена в топе — высокие шансы выиграть тендер';
    } else if (barPct <= 45) {
      posColor = '#92400e'; posLabel = 'Выше среднего';
      posText = 'Ваша цена близка к лучшей — есть шанс выиграть';
    } else if (barPct <= 75) {
      posColor = '#b45309'; posLabel = 'Средняя позиция';
      posText = 'Ваша цена в середине — рассмотрите возможность снижения';
    } else {
      posColor = '#dc2626'; posLabel = 'Слабая позиция';
      posText = 'Ваша цена значительно выше лучшего предложения';
    }
  }

  // Детали своего предложения
  let propCard = '';
  if (myProp) {
    const stars    = myProp.rating ? '⭐'.repeat(myProp.rating) + ` (${myProp.rating}/5)` : 'Ещё нет оценки';
    const payLabel = myProp.payment_type === 'отсрочка'
      ? `Отсрочка${myProp.payment_days ? ' ' + myProp.payment_days + ' дней' : ''}`
      : myProp.payment_type === 'безнал' ? 'Безнал' : (myProp.payment_type || '—');
    propCard = `
    <div class="prop-card">
      <div class="prop-row"><span class="prop-label">💰 Ваша цена</span><span class="prop-val">${myProp.price}</span></div>
      <div class="prop-row"><span class="prop-label">⏱ Срок поставки</span><span class="prop-val">${myProp.delivery_days}</span></div>
      <div class="prop-row"><span class="prop-label">💳 Оплата</span><span class="prop-val">${payLabel}</span></div>
      <div class="prop-row"><span class="prop-label">📦 Наличие</span><span class="prop-val">${myProp.qty_available || '—'}</span></div>
      <div class="prop-row"><span class="prop-label">⭐ Оценка</span><span class="prop-val">${stars}</span></div>
      ${myProp.rating_comment ? `<div class="prop-row"><span class="prop-label">💬 Отзыв</span><span class="prop-val">${myProp.rating_comment}</span></div>` : ''}
    </div>`;
  } else {
    propCard = `<div style="padding:24px;background:#fff3cd;border-radius:8px;color:#92400e">⚠️ Вы не подавали предложение на этот тендер.</div>`;
  }

  // Индикатор позиции
  const posBar = myRank ? `
  <div class="pos-block">
    <h3 style="margin:0 0 16px">📊 Ваша конкурентная позиция</h3>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
      <span style="font-size:32px;font-weight:800;color:${posColor}">${myRank}</span>
      <div>
        <div style="font-size:20px;font-weight:700;color:${posColor}">${posLabel}</div>
        <div style="font-size:13px;color:#64748b">${posText}</div>
      </div>
    </div>
    <div style="margin-bottom:8px;font-size:13px;color:#64748b">Позиция среди ${total} предложений:</div>
    <div style="position:relative;height:16px;background:#e2e8f0;border-radius:8px;overflow:visible">
      <div style="position:absolute;left:0;top:0;height:100%;border-radius:8px;
        background:linear-gradient(to right,#15803d,#ca8a04,#dc2626);width:100%;opacity:0.3"></div>
      <div style="position:absolute;top:50%;left:calc(${barPct}% - 10px);transform:translateY(-50%);
        width:20px;height:20px;background:${posColor};border-radius:50%;border:3px solid #fff;
        box-shadow:0 2px 6px rgba(0,0,0,.25)"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-top:6px">
      <span>🟢 Лучшая цена</span><span>🔴 Высокая цена</span>
    </div>
    ${total > 1 ? `<div style="margin-top:12px;padding:8px 14px;background:#f1f5f9;border-radius:8px;font-size:13px;color:#475569">
      Всего предложений: <b>${total}</b>
    </div>` : ''}
  </div>` : `<div style="padding:16px;background:#f1f5f9;border-radius:8px;color:#64748b">Вы единственный участник тендера</div>`;

  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Тендер ${tenderId} — кабинет поставщика</title>
<style>${CSS}
.prop-card{background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.prop-row{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid #f1f5f9}
.prop-row:last-child{border-bottom:none}
.prop-label{color:#64748b;font-size:14px}
.prop-val{font-size:15px;font-weight:600;color:#1e293b}
.pos-block{background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
</style></head>
<body>
<div class="hdr" style="background:#16a34a">
  <span style="font-size:28px">📦</span>
  <h1>Тендер ${tenderId} — ${tender.title}</h1>
</div>
<div class="wrap">
  <a href="/dashboard/supplier/${chatId}" style="color:#94a3b8;font-size:14px">← Мой кабинет</a>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0">
    <div class="card">
      <h2 style="margin:0 0 12px">${tender.title}</h2>
      <p style="margin:6px 0">🗂 <b>Категория:</b> ${cat}</p>
      <p style="margin:6px 0">📊 <b>Объём:</b> ${tender.quantity}</p>
      <p style="margin:6px 0">⏰ <b>Срок подачи:</b> ${tender.deadline}</p>
      <p style="margin:6px 0">📍 <b>Локация:</b> ${tender.location}</p>
    </div>
    ${posBar}
  </div>
  <h2 style="margin:16px 0 12px">Моё предложение</h2>
  ${propCard}
</div></body></html>`);
});

// API: создать тендер с сайта
app.post('/api/tender', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { title, categoryId, quantity, budget, deadline, location, desc, customerChatId } = req.body;
  if (!title || !categoryId) return res.status(400).json({ error: 'title and categoryId required' });
  const id = await db.createTender({ title, categoryId, quantity, budget, deadline, location, desc, customerId: customerChatId });
  await notifySuppliers(id);
  res.json({ ok: true, tenderId: id });
});

// API: deep link для поставщика с сайта
app.post('/api/link', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { supplierId } = req.body;
  if (!supplierId) return res.status(400).json({ error: 'supplierId required' });
  const botUsername = process.env.BOT_USERNAME || 'kizmattbot';
  res.json({ ok: true, deepLink: `https://t.me/${botUsername}?start=sup_${supplierId}` });
});

// API: предложения по тендеру
app.get('/api/proposals/:tenderId', async (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, proposals: await db.getProposals(req.params.tenderId) });
});

app.get('/', (req, res) => res.json({ ok: true, service: 'Kizmat.kg B2B Bot', version: '4.0' }));

// ─── Запуск ───────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🌐 API + Dashboard: порт ${PORT}`));
  bot.launch().then(() => console.log('🏗 Kizmat.kg B2B Bot v4.0 запущен'));
}).catch(err => { console.error('❌', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
