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
const db = {
  async getSupplier(chatId) {
    const r = await pool.query('SELECT * FROM suppliers WHERE chat_id=$1', [chatId]);
    return r.rows[0] || null;
  },
  async saveSupplier(chatId, data) {
    await pool.query(`
      INSERT INTO suppliers(chat_id,name,phone,categories,supplier_id)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(chat_id) DO UPDATE
        SET name=$2, phone=$3, categories=$4, supplier_id=COALESCE($5,suppliers.supplier_id)
    `, [chatId, data.name, data.phone, data.categories, data.supplierId || null]);
  },
  async getCustomer(chatId) {
    const r = await pool.query('SELECT * FROM customers WHERE chat_id=$1', [chatId]);
    return r.rows[0] || null;
  },
  async saveCustomer(chatId, data) {
    await pool.query(`
      INSERT INTO customers(chat_id,name,phone,company)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(chat_id) DO UPDATE SET name=$2,phone=$3,company=$4
    `, [chatId, data.name, data.phone, data.company]);
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
      INSERT INTO proposals(tender_id,supplier_chat_id,supplier_name,supplier_phone,price,delivery_days)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id
    `, [data.tenderId, data.chatId, data.name, data.phone, data.price, data.deadline]);
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
      'SELECT AVG(rating) as avg, COUNT(*) as total FROM proposals WHERE supplier_chat_id=$1 AND rating IS NOT NULL',
      [chatId]
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
      INSERT INTO suppliers(chat_id,supplier_id) VALUES($1,$2)
      ON CONFLICT(chat_id) DO UPDATE SET supplier_id=$2
    `, [chatId, payload]);
    await ctx.reply('🔗 Аккаунт привязан к kizmat.kg!\n\nВведите ваше имя и компанию:');
    ctx.session.step = 'awaiting_name';
    ctx.session.role = 'supplier';
    return;
  }

  ctx.reply(
    '🏗 Добро пожаловать в Кызмат.kg B2B!\n\nКем вы являетесь?',
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

  // Предложение поставщика
  if (step?.startsWith('proposal:')) {
    const tenderId   = step.split(':')[1];
    const priceMatch = text.match(/Цена[:\s]+([^\n]+)/i);
    const dlMatch    = text.match(/Срок[:\s]+([^\n]+)/i);
    if (!priceMatch || !dlMatch) return ctx.reply('⚠️ Формат:\n\nЦена: 185000 сом\nСрок: 3 дня');

    const sup = await db.getSupplier(chatId);
    const pid = await db.saveProposal({
      tenderId, chatId,
      name:     sup?.name  || 'Неизвестный',
      phone:    sup?.phone || '—',
      price:    priceMatch[1].trim(),
      deadline: dlMatch[1].trim(),
    });
    ctx.session.step = null;
    await ctx.reply(`✅ Предложение принято!\n\n📦 Тендер: ${tenderId}\n💰 Цена: ${priceMatch[1].trim()}\n⏱ Срок: ${dlMatch[1].trim()}\n\nПередаём заказчику.`);
    await notifyCustomer(tenderId, { name: sup?.name, phone: sup?.phone, price: priceMatch[1].trim(), deadline: dlMatch[1].trim(), id: pid });
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
  ctx.session.step = `proposal:${tenderId}`;
  ctx.reply(`📝 Подача предложения на тендер ${tenderId}\n\nОтправьте:\n\nЦена: 185000 сом\nСрок: 3 дня`);
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
  await bot.telegram.sendMessage(
    tender.customer_id,
    `📬 Новое предложение на тендер #${tenderId}!\n\n` +
    `👤 ${proposal.name}\n📞 ${proposal.phone}\n💰 ${proposal.price}\n⏱ ${proposal.deadline}\n\n` +
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

// Dashboard HTML
app.get('/dashboard', async (req, res) => {
  const tenders = await db.getAllTenders();
  let rows = '';
  for (const t of tenders) {
    const props = await db.getProposals(t.id);
    const cat   = catById[t.category_id]?.name || t.category_id;
    rows += `<tr>
      <td><b>${t.id}</b></td>
      <td>${t.title}</td>
      <td>${cat}</td>
      <td>${t.budget}</td>
      <td>${t.deadline}</td>
      <td>${props.length}</td>
      <td><a href="/dashboard/tender/${t.id}">Подробнее →</a></td>
    </tr>`;
  }
  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Кызмат.kg — Дашборд</title>
<style>
  body{font-family:sans-serif;margin:0;background:#f5f5f5}
  .header{background:#2563eb;color:#fff;padding:20px 40px}
  .header h1{margin:0;font-size:24px}
  .content{padding:30px 40px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  th{background:#1e40af;color:#fff;padding:12px 16px;text-align:left;font-size:13px}
  td{padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:14px}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f8faff}
  a{color:#2563eb;text-decoration:none}
  .badge{background:#dcfce7;color:#166534;padding:2px 8px;border-radius:12px;font-size:12px}
</style></head>
<body>
  <div class="header"><h1>🏗 Кызмат.kg B2B — Кабинет заказчика</h1></div>
  <div class="content">
    <h2>Все тендеры (${tenders.length})</h2>
    <table>
      <thead><tr><th>ID</th><th>Название</th><th>Категория</th><th>Бюджет</th><th>Срок</th><th>Предложений</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#999">Тендеров пока нет</td></tr>'}</tbody>
    </table>
  </div>
</body></html>`);
});

// Детали тендера
app.get('/dashboard/tender/:id', async (req, res) => {
  const tender = await db.getTender(req.params.id);
  if (!tender) return res.status(404).send('Тендер не найден');
  const proposals = await db.getProposals(req.params.id);
  const cat = catById[tender.category_id]?.name || tender.category_id;
  let pRows = '';
  for (const p of proposals) {
    const stars = p.rating ? '⭐'.repeat(p.rating) : '—';
    pRows += `<tr>
      <td>${p.supplier_name}</td>
      <td>${p.supplier_phone}</td>
      <td><b>${p.price}</b></td>
      <td>${p.delivery_days}</td>
      <td>${stars}</td>
      <td>${p.rating_comment || '—'}</td>
      <td>${new Date(p.submitted_at).toLocaleDateString('ru-RU')}</td>
    </tr>`;
  }
  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>${tender.id}</title>
<style>
  body{font-family:sans-serif;margin:0;background:#f5f5f5}
  .header{background:#2563eb;color:#fff;padding:20px 40px}
  .content{padding:30px 40px}
  .card{background:#fff;border-radius:8px;padding:24px;margin-bottom:24px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  th{background:#1e40af;color:#fff;padding:12px 16px;text-align:left;font-size:13px}
  td{padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:14px}
  a{color:#2563eb}
</style></head>
<body>
  <div class="header"><h1>🏗 Тендер ${tender.id}</h1></div>
  <div class="content">
    <a href="/dashboard">← Все тендеры</a>
    <div class="card" style="margin-top:16px">
      <h2>${tender.title}</h2>
      <p>🗂 <b>Категория:</b> ${cat}</p>
      <p>📊 <b>Объём:</b> ${tender.quantity}</p>
      <p>💰 <b>Бюджет:</b> ${tender.budget}</p>
      <p>⏰ <b>Срок:</b> ${tender.deadline}</p>
      <p>📍 <b>Локация:</b> ${tender.location}</p>
    </div>
    <h2>Предложения (${proposals.length})</h2>
    <table>
      <thead><tr><th>Поставщик</th><th>Телефон</th><th>Цена</th><th>Срок</th><th>Оценка</th><th>Отзыв</th><th>Дата</th></tr></thead>
      <tbody>${pRows || '<tr><td colspan="7" style="text-align:center;color:#999">Предложений пока нет</td></tr>'}</tbody>
    </table>
  </div>
</body></html>`);
});

// Кабинет поставщика
app.get('/dashboard/supplier/:chatId', async (req, res) => {
  const chatId = req.params.chatId;
  const sup = await pool.query('SELECT * FROM suppliers WHERE chat_id=$1', [chatId]);
  if (!sup.rows[0]) return res.status(404).send('Поставщик не найден');
  const s = sup.rows[0];
  const cats = (s.categories || []).map(id => catById[id]?.name || id).join(', ');

  const ratingR = await db.getSupplierRating(chatId);
  const avgRating = ratingR.avg ? `⭐ ${parseFloat(ratingR.avg).toFixed(1)} (${ratingR.total} отзывов)` : 'Нет отзывов';

  const propsR = await pool.query(`
    SELECT p.*, t.title as tender_title, t.budget, t.category_id
    FROM proposals p JOIN tenders t ON p.tender_id=t.id
    WHERE p.supplier_chat_id=$1 ORDER BY p.submitted_at DESC
  `, [chatId]);

  let pRows = '';
  for (const p of propsR.rows) {
    const stars = p.rating ? '⭐'.repeat(p.rating) : '—';
    const status = p.rating ? `<span style="color:#16a34a">Завершён</span>` : `<span style="color:#2563eb">В работе</span>`;
    pRows += `<tr>
      <td><a href="/dashboard/tender/${p.tender_id}">${p.tender_id}</a></td>
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
    <a href="/dashboard">← Все тендеры</a>
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

app.get('/', (req, res) => res.json({ ok: true, service: 'Kyzmat.kg B2B Bot', version: '4.0' }));

// ─── Запуск ───────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🌐 API + Dashboard: порт ${PORT}`));
  bot.launch().then(() => console.log('🏗 Кызмат.kg B2B Bot v4.0 запущен'));
}).catch(err => { console.error('❌', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
