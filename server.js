const express = require('express');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

function loadLocalEnvironment() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvironment();

const app = express();
const PORT = process.env.PORT || 3000;
const databaseName = process.env.DB_NAME || 'buffet_pos';
const legacyDatabasePath = path.join(__dirname, 'data', 'buffet-pos.sqlite');
let salesDatabase;
const adminSessions = new Map();
const adminLoginAttempts = new Map();
const adminSessionCookie = 'platera_admin_session';
const adminSessionDurationMs = 30 * 60 * 1000;
const adminLoginBlockDurationMs = 60 * 1000;

function readLegacySales() {
  if (!fs.existsSync(legacyDatabasePath)) return [];
  const legacyDatabase = new DatabaseSync(legacyDatabasePath, { readOnly: true });
  try {
    const tables = legacyDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sales'").get();
    if (!tables) return [];
    return legacyDatabase.prepare('SELECT * FROM sales ORDER BY created_at, sale_id').all();
  } finally {
    legacyDatabase.close();
  }
}

function legacySaleValues(row) {
  const order = JSON.parse(row.order_json);
  return [
    row.sale_id,
    row.created_at,
    row.source,
    row.table_id,
    row.party_id,
    row.payment_method,
    row.guest_count,
    row.adults,
    row.senior_count ?? order.seniorCount ?? 0,
    row.children,
    row.free_children ?? order.freeChildCount ?? 0,
    row.plates,
    row.items_json || JSON.stringify(order.items || []),
    row.discount_type,
    row.promo_json,
    row.custom_discount_pct ?? 0,
    row.subtotal,
    row.discount_amount,
    row.service_charge ?? 0,
    row.service_charge_pct,
    row.tax_rate,
    row.tax_amount ?? 0,
    row.total,
    row.order_json
  ];
}

const saleInsertSql = `
  INSERT INTO sales (
    sale_id, created_at, source, table_id, party_id, payment_method, guest_count,
    adults, senior_count, children, free_children, plates, items_json, discount_type, promo_json,
    custom_discount_pct, subtotal, discount_amount, service_charge,
    service_charge_pct, tax_rate, tax_amount, total, order_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE sale_id = VALUES(sale_id)
`;

async function initializeSalesDatabase() {
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error('DB_NAME must contain only letters, numbers, and underscores.');
  }
  const port = Number(process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port.');
  }
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  };
  const adminConnection = await mysql.createConnection(config);
  try {
    await adminConnection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await adminConnection.end();
  }

  salesDatabase = mysql.createPool({
    ...config,
    database: databaseName,
    charset: 'utf8mb4',
    connectionLimit: 10,
    decimalNumbers: true
  });
  await salesDatabase.query(`
    CREATE TABLE IF NOT EXISTS sales (
      sale_id VARCHAR(80) PRIMARY KEY,
      created_at VARCHAR(40) NOT NULL,
      source VARCHAR(16) NOT NULL,
      table_id VARCHAR(16),
      party_id VARCHAR(80),
      payment_method VARCHAR(24) NOT NULL,
      guest_count INT NOT NULL,
      adults INT,
      senior_count INT NOT NULL DEFAULT 0,
      children INT,
      free_children INT NOT NULL DEFAULT 0,
      plates INT NOT NULL,
      items_json LONGTEXT NOT NULL,
      discount_type VARCHAR(40),
      promo_json LONGTEXT,
      custom_discount_pct DECIMAL(7, 2) NOT NULL DEFAULT 0,
      subtotal DECIMAL(12, 2) NOT NULL,
      discount_amount DECIMAL(12, 2) NOT NULL,
      service_charge DECIMAL(12, 2) NOT NULL DEFAULT 0,
      service_charge_pct DECIMAL(7, 2),
      tax_rate DECIMAL(7, 2),
      tax_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
      total DECIMAL(12, 2) NOT NULL,
      order_json LONGTEXT NOT NULL,
      INDEX sales_created_at_idx (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [salesColumns] = await salesDatabase.query('SHOW COLUMNS FROM sales');
  const salesColumnNames = new Set(salesColumns.map((column) => column.Field));
  if (!salesColumnNames.has('senior_count')) {
    await salesDatabase.query('ALTER TABLE sales ADD COLUMN senior_count INT NOT NULL DEFAULT 0');
  }
  if (!salesColumnNames.has('free_children')) {
    await salesDatabase.query('ALTER TABLE sales ADD COLUMN free_children INT NOT NULL DEFAULT 0');
  }
  await salesDatabase.query(`
    CREATE TABLE IF NOT EXISTS dish_cost_entries (
      entry_id CHAR(36) PRIMARY KEY,
      business_date DATE NOT NULL,
      dish_name VARCHAR(80) NOT NULL,
      total_cost DECIMAL(12, 2) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      INDEX dish_cost_date_idx (business_date, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await salesDatabase.query(`
    CREATE TABLE IF NOT EXISTS dish_catalog (
      dish_id CHAR(36) PRIMARY KEY,
      dish_name VARCHAR(80) NOT NULL UNIQUE,
      default_cost DECIMAL(12, 2) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const legacySales = readLegacySales();
  if (legacySales.length) {
    const connection = await salesDatabase.getConnection();
    try {
      await connection.beginTransaction();
      for (const row of legacySales) {
        await connection.execute(saleInsertSql, legacySaleValues(row));
      }
      await connection.commit();
      console.log(`Imported ${legacySales.length} legacy SQLite sales into MariaDB.`);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

const menu = {
  categories: [
    { id: 'hot-line', name: 'Hot Line', description: 'Chef-crafted mains and signature favorites.' },
    { id: 'sides', name: 'Sides & Salads', description: 'Fresh, vibrant, and family-style additions.' },
    { id: 'desserts', name: 'Desserts', description: 'Sweet bites to finish the meal.' },
    { id: 'beverages', name: 'Beverages', description: 'Cold drinks and refreshing options.' }
  ],
  items: [
    { id: 'bbq-ribs', name: 'BBQ Ribs', category: 'hot-line', price: 18.5, prep: 'Grilled to order', popular: true },
    { id: 'butter-chicken', name: 'Butter Chicken', category: 'hot-line', price: 16.75, prep: 'Creamy tomato base', popular: true },
    { id: 'beef-stew', name: 'Beef Stew', category: 'hot-line', price: 17.25, prep: 'Slow-cooked comfort', popular: false },
    { id: 'fish-tacos', name: 'Fish Tacos', category: 'hot-line', price: 15.5, prep: 'Citrus slaw', popular: false },
    { id: 'caesar-salad', name: 'Caesar Salad', category: 'sides', price: 9.25, prep: 'Garden fresh', popular: true },
    { id: 'roasted-veggies', name: 'Roasted Veggies', category: 'sides', price: 8.5, prep: 'Seasonal medley', popular: false },
    { id: 'fruit-bowl', name: 'Fruit Bowl', category: 'sides', price: 7.75, prep: 'Daily selection', popular: false },
    { id: 'macaroni', name: 'Macaroni Bake', category: 'sides', price: 10.25, prep: 'Cheesy and rich', popular: true },
    { id: 'choco-lava', name: 'Chocolate Lava Cake', category: 'desserts', price: 8.5, prep: 'Warm and gooey', popular: true },
    { id: 'lemon-tart', name: 'Lemon Tart', category: 'desserts', price: 7.25, prep: 'Tangy finish', popular: false },
    { id: 'ice-cream', name: 'Ice Cream Bar', category: 'desserts', price: 6.75, prep: 'Three flavors', popular: true },
    { id: 'mango-sorbet', name: 'Mango Sorbet', category: 'desserts', price: 6.5, prep: 'Refreshing scoop', popular: false },
    { id: 'iced-tea', name: 'Iced Tea', category: 'beverages', price: 3.5, prep: 'House brewed', popular: true },
    { id: 'lemonade', name: 'Fresh Lemonade', category: 'beverages', price: 3.25, prep: 'Cool and crisp', popular: false },
    { id: 'sparkling-water', name: 'Sparkling Water', category: 'beverages', price: 2.75, prep: 'Citrus twist', popular: false },
    { id: 'coffee', name: 'Coffee', category: 'beverages', price: 3, prep: 'Freshly brewed', popular: true }
  ]
};

const discounts = [
  { id: 'none', label: 'None', rate: 0 },
  { id: 'student', label: 'Student', rate: 0.05 },
  { id: 'senior', label: 'Senior', rate: 0.1 },
  { id: 'family', label: 'Family', rate: 0.08 },
  { id: 'employee', label: 'Employee', rate: 0.15 }
];

const inventory = [];
async function saveSale(order, source) {
  await salesDatabase.execute(saleInsertSql, [
    order.id,
    order.createdAt,
    source,
    order.tableId || null,
    order.partyId || null,
    order.paymentMethod,
    order.guestCount ?? order.paxCount ?? 0,
    order.adults ?? null,
    order.seniorCount ?? 0,
    order.children ?? null,
    order.freeChildCount ?? 0,
    order.plates ?? order.assignedPlates ?? 0,
    JSON.stringify(order.items || []),
    order.discountType || null,
    order.promo ? JSON.stringify(order.promo) : null,
    order.customDiscountPct || 0,
    order.subtotal,
    order.discountAmount,
    order.serviceCharge || 0,
    order.serviceChargePct ?? null,
    order.taxRate ?? null,
    order.taxAmount || 0,
    order.total,
    JSON.stringify(order)
  ]);
}

async function getRecentSales(limit = 10) {
  const [rows] = await salesDatabase.execute(
    'SELECT order_json FROM sales ORDER BY created_at DESC, sale_id DESC LIMIT ?',
    [Math.max(1, Math.min(100, Number(limit) || 10))]
  );
  return rows.map((row) => JSON.parse(row.order_json));
}

async function getSalesSummary() {
  const [rows] = await salesDatabase.execute(`
    SELECT
      COUNT(*) AS saleCount,
      COALESCE(SUM(guest_count), 0) AS guestCount,
      COALESCE(SUM(total), 0) AS earnings
    FROM sales
  `);
  const [summary] = rows;
  return {
    saleCount: summary.saleCount,
    guestCount: summary.guestCount,
    earnings: Number(Number(summary.earnings).toFixed(2))
  };
}

function getSalesDateFilter(startDate, endDate, timezoneOffset = 0) {
  const clauses = [];
  const values = [];
  if (!Number.isInteger(timezoneOffset) || timezoneOffset < -840 || timezoneOffset > 840) {
    throw new Error('Timezone offset must be between -840 and 840 minutes.');
  }
  const utcBoundary = (date) => new Date(Date.parse(`${date}T00:00:00.000Z`) + timezoneOffset * 60 * 1000).toISOString();
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (startDate) {
    if (!validDate(startDate)) throw new Error('Start date must use YYYY-MM-DD format.');
    clauses.push('created_at >= ?');
    values.push(utcBoundary(startDate));
  }
  if (endDate) {
    if (!validDate(endDate)) throw new Error('End date must use YYYY-MM-DD format.');
    const nextDay = new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const exclusiveEnd = utcBoundary(nextDay);
    clauses.push('created_at < ?');
    values.push(exclusiveEnd);
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error('Start date must be on or before end date.');
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

async function getSalesPage({ startDate, endDate, timezoneOffset, search, source, page, pageSize }) {
  const dateFilter = getSalesDateFilter(startDate, endDate, timezoneOffset);
  const clauses = dateFilter.sql ? [dateFilter.sql.slice(6)] : [];
  const values = [...dateFilter.values];
  if (search) {
    clauses.push('(sale_id LIKE ? OR table_id LIKE ? OR party_id LIKE ?)');
    const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(term, term, term);
  }
  if (source !== 'all') {
    clauses.push('source = ?');
    values.push(source);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;
  const [countRows] = await salesDatabase.execute(`SELECT COUNT(*) AS totalCount FROM sales ${whereSql}`, values);
  const [rows] = await salesDatabase.execute(
    `SELECT order_json, source FROM sales ${whereSql} ORDER BY created_at DESC, sale_id DESC LIMIT ? OFFSET ?`,
    [...values, pageSize, offset]
  );
  const totalCount = Number(countRows[0].totalCount);
  return {
    sales: rows.map((row) => ({ ...JSON.parse(row.order_json), source: row.source })),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize)
  };
}

async function getFilteredSalesSummary({ startDate, endDate, timezoneOffset, source }) {
  const dateFilter = getSalesDateFilter(startDate, endDate, timezoneOffset);
  const clauses = dateFilter.sql ? [dateFilter.sql.slice(6)] : [];
  const values = [...dateFilter.values];
  if (source !== 'all') {
    clauses.push('source = ?');
    values.push(source);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await salesDatabase.execute(`
    SELECT
      COUNT(*) AS saleCount,
      COALESCE(SUM(guest_count), 0) AS guestCount,
      COALESCE(SUM(total), 0) AS earnings
    FROM sales
    ${whereSql}
  `, values);
  const summary = rows[0];
  return {
    saleCount: Number(summary.saleCount),
    guestCount: Number(summary.guestCount),
    earnings: Number(Number(summary.earnings).toFixed(2))
  };
}

const buffet = {
  tables: [
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `T${String(index + 1).padStart(2, '0')}`,
      seats: 4,
      status: 'available'
    })),
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `T${String(index + 21).padStart(2, '0')}`,
      seats: 6,
      status: 'available'
    }))
  ],
  parties: [],
  plates: { initialCleanStock: 240, cleanStock: 240, inUse: 0, inDishwashing: 7, minimumThresholdPct: 15 },
  pricing: { adultPrice: 299, seniorPrice: 240, childPrice: 110, childFreeHeightFt: 3, weekendSurcharge: 0, serviceChargePct: 0.1, taxRate: 0.08 },
  promos: [],
  plateEvents: []
};

function buffetSnapshot() {
  const activeParties = buffet.parties.filter((party) => party.status === 'seated');
  const availableStock = Math.max(0, buffet.plates.cleanStock - buffet.plates.inUse);
  return {
    ...buffet,
    tables: buffet.tables.map((table) => ({
      ...table,
      party: activeParties.find((party) => party.tableId === table.id) || null,
      status: activeParties.some((party) => party.tableId === table.id) ? 'occupied' : 'available'
    })),
    totalDiners: activeParties.reduce((sum, party) => sum + party.paxCount, 0),
    availableStock,
    stockPct: buffet.plates.initialCleanStock ? availableStock / buffet.plates.initialCleanStock * 100 : 0
  };
}

function recordPlateEvent(type, quantity, partyId, details = {}) {
  buffet.plateEvents.unshift({ type, quantity, partyId, ...details, at: new Date().toISOString() });
  buffet.plateEvents = buffet.plateEvents.slice(0, 100);
}

function numberInRange(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function normalizeRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? number / 100 : number;
}

function calculateBuffetBill(party, promoId, customDiscountPct = 0) {
  const pricing = buffet.pricing;
  const weekend = [0, 6].includes(new Date().getDay());
  const surchargeRate = weekend ? normalizeRate(pricing.weekendSurcharge) : 0;
  const serviceChargeRate = normalizeRate(pricing.serviceChargePct);
  const taxRate = normalizeRate(pricing.taxRate);
  const seniorCount = Math.max(0, Number(party.seniorCount || 0));
  const validAdultCount = Math.max(0, Number(party.adults || 0));
  const childCount = Math.max(0, Number(party.children || 0));
  const adultSubtotal = validAdultCount * pricing.adultPrice * (1 + surchargeRate);
  const seniorSubtotal = seniorCount * pricing.seniorPrice * (1 + surchargeRate);
  const childSubtotal = childCount * pricing.childPrice * (1 + surchargeRate);
  const subtotal = adultSubtotal + seniorSubtotal + childSubtotal;
  const promo = buffet.promos.find((entry) => entry.id === promoId && entry.active);
  let discountAmount = 0;
  if (customDiscountPct > 0) {
    discountAmount = subtotal * customDiscountPct / 100;
  } else if (promo?.type === 'percentage') {
    const basis = promo.appliesTo === 'adults' ? adultSubtotal : promo.appliesTo === 'children' ? childSubtotal : subtotal;
    discountAmount = basis * promo.value / 100;
  } else if (promo?.type === 'fixed') {
    discountAmount = Math.min(subtotal, promo.value);
  } else if (promo?.type === 'tier' && party.paxCount >= Number(promo.conditions.minPax || 0)) {
    discountAmount = subtotal * promo.value / 100;
  } else if (promo?.type === 'birthday') {
    discountAmount = Math.min(adultSubtotal, Math.floor(party.adults / Math.max(1, Number(promo.conditions.freeEvery || 4))) * pricing.adultPrice * (1 + surchargeRate));
  }
  const discountedSubtotal = subtotal - discountAmount;
  const serviceCharge = discountedSubtotal * serviceChargeRate;
  const taxAmount = (discountedSubtotal + serviceCharge) * taxRate;
  const total = discountedSubtotal + serviceCharge + taxAmount;
  return {
    subtotal: Number(subtotal.toFixed(2)),
    discountAmount: Number(discountAmount.toFixed(2)),
    promo: promo || null,
    serviceCharge: Number(serviceCharge.toFixed(2)),
    taxAmount: Number(taxAmount.toFixed(2)),
    total: Number(total.toFixed(2))
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function getDiscountRate(discountType) {
  const discount = discounts.find((entry) => entry.id === discountType);
  return discount ? Number(discount.rate) : 0;
}

function calculateOrder({ items = [], guestCount = 1, discountType = 'none', serviceChargePct = 0, taxRate = 0 }) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity || 1), 0);
  const discountRate = getDiscountRate(discountType);
  const discountAmount = subtotal * discountRate;
  const discountedSubtotal = subtotal - discountAmount;
  const normalizedServiceCharge = normalizeRate(serviceChargePct);
  const normalizedTaxRate = normalizeRate(taxRate);
  const serviceCharge = discountedSubtotal * normalizedServiceCharge;
  const taxAmount = (discountedSubtotal + serviceCharge) * normalizedTaxRate;
  const total = discountedSubtotal + serviceCharge + taxAmount;

  return {
    guestCount,
    items,
    subtotal: Number(subtotal.toFixed(2)),
    discountRate,
    discountAmount: Number(discountAmount.toFixed(2)),
    serviceCharge: Number(serviceCharge.toFixed(2)),
    taxRate: Number(normalizedTaxRate.toFixed(4)),
    taxAmount: Number(taxAmount.toFixed(2)),
    total: Number(total.toFixed(2))
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/buffet/state', (req, res) => {
  res.json(buffetSnapshot());
});

app.patch('/api/buffet/pricing', (req, res) => {
  const fields = ['adultPrice', 'seniorPrice', 'childPrice', 'childFreeHeightFt', 'weekendSurcharge', 'serviceChargePct', 'taxRate'];
  for (const field of fields) {
    if (req.body[field] !== undefined && !numberInRange(req.body[field], 0, field === 'weekendSurcharge' || field === 'serviceChargePct' || field === 'taxRate' ? 100 : 10000)) {
      return res.status(400).json({ message: `Invalid ${field}.` });
    }
  }
  for (const field of fields) {
    if (req.body[field] !== undefined) {
      const rawValue = Number(req.body[field]);
      const value = field === 'weekendSurcharge' || field === 'serviceChargePct' || field === 'taxRate' ? normalizeRate(rawValue) : rawValue;
      buffet.pricing[field] = Number(Number(value).toFixed(2));
    }
  }
  res.json(buffet.pricing);
});

app.patch('/api/buffet/plates', (req, res) => {
  const { action, quantity, source, partyId } = req.body;
  const count = action === 'wash-all' ? buffet.plates.inDishwashing : quantity;
  const allowZero = action === 'set-available';
  if (typeof count !== 'number' || !Number.isInteger(count) || count < (allowZero ? 0 : 1)) {
    return res.status(400).json({ message: allowZero ? 'Available clean plates must be a non-negative whole number.' : 'Quantity must be a positive whole number.' });
  }
  if (action === 'unavailable') {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!['clean', 'in-use', 'dishwashing'].includes(source)) {
      return res.status(400).json({ message: 'Choose clean, in-use, or dishwashing plates.' });
    }
    if (!reason || reason.length > 120) {
      return res.status(400).json({ message: 'Enter a reason of 1 to 120 characters.' });
    }
    let party = null;
    if (source === 'clean' && count > buffet.plates.cleanStock - buffet.plates.inUse) {
      return res.status(400).json({ message: `Only ${Math.max(0, buffet.plates.cleanStock - buffet.plates.inUse)} unassigned clean plates are available.` });
    }
    if (source === 'in-use') {
      party = buffet.parties.find((entry) => entry.id === partyId && entry.status === 'seated');
      if (!party) return res.status(400).json({ message: 'Choose an active table for the in-use plates.' });
      if (count > party.assignedPlates) {
        return res.status(400).json({ message: `That table has only ${party.assignedPlates} assigned plates.` });
      }
    }
    if (source === 'dishwashing' && count > buffet.plates.inDishwashing) {
      return res.status(400).json({ message: `Only ${buffet.plates.inDishwashing} plates are in dishwashing.` });
    }
    if (source === 'clean') {
      buffet.plates.cleanStock -= count;
    } else if (source === 'in-use') {
      party.assignedPlates -= count;
      buffet.plates.inUse -= count;
      buffet.plates.cleanStock -= count;
    } else {
      buffet.plates.inDishwashing -= count;
    }
    recordPlateEvent('unavailable', count, party?.id || null, { source, reason });
    return res.json(buffetSnapshot());
  }
  if (action === 'receive') {
    buffet.plates.cleanStock += count;
    recordPlateEvent('received', count, null);
  } else if (action === 'remove') {
    const availableStock = buffet.plates.cleanStock - buffet.plates.inUse;
    if (count > availableStock) return res.status(400).json({ message: `Only ${Math.max(0, availableStock)} unassigned clean plates are available to remove.` });
    buffet.plates.cleanStock -= count;
    recordPlateEvent('removed', count, null);
  } else if (action === 'set-available') {
    const difference = count - (buffet.plates.cleanStock - buffet.plates.inUse);
    if (difference > 0) {
      buffet.plates.cleanStock += difference;
      recordPlateEvent('received', difference, null);
    } else if (difference < 0) {
      const removed = Math.abs(difference);
      buffet.plates.cleanStock -= removed;
      recordPlateEvent('removed', removed, null);
    }
  } else if (action === 'wash' || action === 'wash-all') {
    if (count > buffet.plates.inDishwashing) return res.status(400).json({ message: 'Cannot wash more plates than are in dishwashing.' });
    buffet.plates.inDishwashing -= count;
    buffet.plates.cleanStock += count;
    recordPlateEvent('received', count, null);
  } else {
    return res.status(400).json({ message: 'Action must be receive, remove, set-available, unavailable, wash, or wash-all.' });
  }
  res.json(buffetSnapshot());
});

app.patch('/api/buffet/threshold', (req, res) => {
  const value = Number(req.body.minimumThresholdPct);
  if (!numberInRange(value, 1, 100)) return res.status(400).json({ message: 'Threshold must be between 1 and 100 percent.' });
  buffet.plates.minimumThresholdPct = value;
  res.json(buffetSnapshot());
});

app.post('/api/buffet/parties', (req, res) => {
  const table = buffet.tables.find((entry) => entry.id === req.body.tableId);
  const adults = Number(req.body.adults);
  const children = Number(req.body.children || 0);
  const seniorCount = Math.max(0, Number(req.body.seniorCount || 0));
  const freeChildCount = Math.max(0, Number(req.body.freeChildCount || 0));
  if (!table) return res.status(400).json({ message: 'Choose a valid table.' });
  if (buffet.parties.some((party) => party.tableId === table.id && party.status === 'seated')) return res.status(409).json({ message: 'That table is already occupied.' });
  if (!Number.isInteger(adults) || adults < 0 || !Number.isInteger(children) || children < 0 || !Number.isInteger(seniorCount) || seniorCount < 0 || !Number.isInteger(freeChildCount) || freeChildCount < 0 || adults + seniorCount + children + freeChildCount < 1) {
    return res.status(400).json({ message: 'Enter at least one guest.' });
  }
  const paxCount = adults + seniorCount + children + freeChildCount;
  if (paxCount > table.seats) return res.status(400).json({ message: `This table seats up to ${table.seats}.` });
  const available = buffet.plates.cleanStock - buffet.plates.inUse;
  if (paxCount > available) return res.status(409).json({ message: `Only ${Math.max(0, available)} clean plates are available.` });
  const party = {
    id: `PTY-${Date.now().toString(36).toUpperCase()}`,
    tableId: table.id,
    adults,
    children,
    seniorCount,
    freeChildCount,
    paxCount,
    assignedPlates: paxCount,
    status: 'seated',
    checkedInAt: new Date().toISOString()
  };
  buffet.parties.push(party);
  buffet.plates.inUse += paxCount;
  recordPlateEvent('distributed', paxCount, party.id);
  res.status(201).json({ party, state: buffetSnapshot() });
});

app.patch('/api/buffet/parties/:id/plates', (req, res) => {
  const party = buffet.parties.find((entry) => entry.id === req.params.id && entry.status === 'seated');
  const rawQuantity = req.body.quantity;
  const quantity = Number(rawQuantity);
  const action = req.body.action;
  if (!party) return res.status(404).json({ message: 'Active party not found.' });
  if (!Number.isInteger(quantity) || quantity < (action === 'set' ? 0 : 1) || (action === 'set' && typeof rawQuantity !== 'number')) {
    return res.status(400).json({ message: action === 'set' ? 'Plate count must be a non-negative whole number.' : 'Quantity must be a positive whole number.' });
  }
  if (action === 'distribute') {
    const available = buffet.plates.cleanStock - buffet.plates.inUse;
    if (quantity > available) return res.status(409).json({ message: `Only ${Math.max(0, available)} clean plates are available.` });
    party.assignedPlates += quantity;
    buffet.plates.inUse += quantity;
  } else if (action === 'bus') {
    if (quantity > party.assignedPlates) return res.status(400).json({ message: 'Cannot bus more plates than this party has in use.' });
    party.assignedPlates -= quantity;
    buffet.plates.inUse -= quantity;
    buffet.plates.cleanStock -= quantity;
    buffet.plates.inDishwashing += quantity;
  } else if (action === 'set') {
    const difference = quantity - party.assignedPlates;
    if (difference > 0) {
      const available = buffet.plates.cleanStock - buffet.plates.inUse;
      if (difference > available) return res.status(409).json({ message: `Only ${Math.max(0, available)} clean plates are available.` });
      buffet.plates.inUse += difference;
      recordPlateEvent('distributed', difference, party.id);
    } else if (difference < 0) {
      const returned = Math.abs(difference);
      buffet.plates.inUse -= returned;
      buffet.plates.cleanStock -= returned;
      buffet.plates.inDishwashing += returned;
      recordPlateEvent('bussed', returned, party.id);
    }
    party.assignedPlates = quantity;
    return res.json({ party, state: buffetSnapshot() });
  } else {
    return res.status(400).json({ message: 'Action must be distribute, bus, or set.' });
  }
  recordPlateEvent(action === 'bus' ? 'bussed' : 'distributed', quantity, party.id);
  res.json({ party, state: buffetSnapshot() });
});

app.patch('/api/buffet/parties/:id/release', (req, res) => {
  const party = buffet.parties.find((entry) => entry.id === req.params.id && entry.status === 'seated');
  if (!party) return res.status(404).json({ message: 'Active party not found.' });
  const platesToBus = party.assignedPlates;
  if (platesToBus > 0) {
    buffet.plates.inUse -= platesToBus;
    buffet.plates.cleanStock -= platesToBus;
    buffet.plates.inDishwashing += platesToBus;
    recordPlateEvent('bussed', platesToBus, party.id);
  }
  party.assignedPlates = 0;
  party.status = 'released';
  party.releasedAt = new Date().toISOString();
  res.json({ party, state: buffetSnapshot() });
});

app.post('/api/buffet/promos', (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim().toUpperCase();
  const type = String(req.body.type || 'percentage');
  const value = Number(req.body.value);
  const appliesTo = ['adults', 'children', 'subtotal'].includes(req.body.appliesTo) ? req.body.appliesTo : 'subtotal';
  if (!name || !code) return res.status(400).json({ message: 'Promo name and code are required.' });
  if (!['percentage', 'fixed', 'tier', 'birthday'].includes(type)) return res.status(400).json({ message: 'Unsupported promo type.' });
  if (!Number.isFinite(value) || value < 0 || (['percentage', 'tier'].includes(type) && value > 100)) return res.status(400).json({ message: 'Promo value is out of range.' });
  const minPax = Number(req.body.minPax || 0);
  const freeEvery = Number(req.body.freeEvery || 4);
  if (!Number.isInteger(minPax) || minPax < 0 || !Number.isInteger(freeEvery) || freeEvery < 1) {
    return res.status(400).json({ message: 'Promo conditions must be positive whole numbers.' });
  }
  if (buffet.promos.some((promo) => promo.code === code)) return res.status(409).json({ message: 'That promo code already exists.' });
  const promo = {
    id: `${slugify(code)}-${Date.now().toString(36)}`,
    code,
    name,
    type,
    value,
    active: true,
    appliesTo,
    conditions: {
      minPax,
      freeEvery
    }
  };
  buffet.promos.push(promo);
  res.status(201).json(promo);
});

app.patch('/api/buffet/promos/:id', (req, res) => {
  const promo = buffet.promos.find((entry) => entry.id === req.params.id);
  if (!promo) return res.status(404).json({ message: 'Promo not found.' });
  if (req.body.active !== undefined) promo.active = Boolean(req.body.active);
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ message: 'Promo name cannot be empty.' });
    promo.name = name;
  }
  if (req.body.value !== undefined) {
    const value = Number(req.body.value);
    if (!numberInRange(value, 0, ['percentage', 'tier'].includes(promo.type) ? 100 : 10000)) return res.status(400).json({ message: 'Invalid promo value.' });
    promo.value = value;
  }
  if (req.body.conditions && typeof req.body.conditions === 'object') {
    const conditions = { ...promo.conditions, ...req.body.conditions };
    if (conditions.minPax !== undefined && (!Number.isInteger(Number(conditions.minPax)) || Number(conditions.minPax) < 0)) {
      return res.status(400).json({ message: 'Minimum party size must be a non-negative whole number.' });
    }
    if (conditions.freeEvery !== undefined && (!Number.isInteger(Number(conditions.freeEvery)) || Number(conditions.freeEvery) < 1)) {
      return res.status(400).json({ message: 'Birthday interval must be a positive whole number.' });
    }
    promo.conditions = conditions;
  }
  res.json(promo);
});

app.post('/api/buffet/checkout', async (req, res) => {
  const party = buffet.parties.find((entry) => entry.id === req.body.partyId && entry.status === 'seated');
  if (!party) return res.status(404).json({ message: 'Active party not found.' });
  const paymentMethod = String(req.body.paymentMethod || 'cash');
  if (!['cash', 'card', 'mobile'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose cash, card, or mobile wallet.' });
  const customDiscountPct = Number(req.body.customDiscountPct || 0);
  if (!numberInRange(customDiscountPct, 0, 50)) return res.status(400).json({ message: 'Manual discount must be between 0 and 50 percent.' });
  const bill = calculateBuffetBill(party, customDiscountPct ? null : req.body.promoId, customDiscountPct);
  const createdAt = new Date().toISOString();
  const order = {
    id: `BUF-${randomUUID()}`,
    partyId: party.id,
    tableId: party.tableId,
    adults: party.adults,
    seniorCount: party.seniorCount,
    children: party.children,
    freeChildCount: party.freeChildCount,
    paxCount: party.paxCount,
    paymentMethod,
    customDiscountPct,
    ...bill,
    createdAt
  };
  try {
    await saveSale(order, 'buffet');
  } catch (error) {
    console.error('Could not persist buffet sale:', error);
    return res.status(500).json({ message: 'Could not save this sale. The party is still active; try again.' });
  }
  buffet.plates.inUse -= party.assignedPlates;
  buffet.plates.cleanStock -= party.assignedPlates;
  buffet.plates.inDishwashing += party.assignedPlates;
  recordPlateEvent('bussed', party.assignedPlates, party.id);
  party.status = 'closed';
  party.checkedOutAt = createdAt;
  res.status(201).json({ order, state: buffetSnapshot() });
});

app.get('/api/menu', (req, res) => {
  res.json(menu);
});

app.get('/api/discounts', (req, res) => {
  res.json(discounts);
});

app.post('/api/discounts', (req, res) => {
  const label = String(req.body.label || '').trim();
  const numericRate = Number(req.body.rate);

  if (!label) {
    return res.status(400).json({ message: 'Discount name is required.' });
  }

  if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate >= 1) {
    return res.status(400).json({ message: 'Discount rate must be between 0 and 1, such as 0.15.' });
  }

  const id = slugify(label);
  const duplicate = discounts.some((discount) => discount.id === id || discount.label.toLowerCase() === label.toLowerCase());
  if (duplicate) {
    return res.status(409).json({ message: 'This discount already exists.' });
  }

  const discount = { id, label, rate: Number(numericRate.toFixed(4)) };
  discounts.push(discount);
  return res.status(201).json(discount);
});

app.get('/api/inventory', (req, res) => {
  res.json(inventory);
});

app.post('/api/inventory', (req, res) => {
  const dishName = String(req.body.dish || '').trim();
  const cost = Number(req.body.cost);
  const rawIngredients = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];

  if (!dishName) {
    return res.status(400).json({ message: 'Dish name is required.' });
  }

  if (!Number.isFinite(cost) || cost < 0) {
    return res.status(400).json({ message: 'Dish cost must be zero or greater.' });
  }

  if (!rawIngredients.length) {
    return res.status(400).json({ message: 'Add at least one ingredient.' });
  }

  const ingredients = rawIngredients
    .map((entry) => ({
      name: String(entry.name || '').trim(),
      quantity: Number(entry.quantity || 0),
      unit: String(entry.unit || '').trim()
    }))
    .filter((entry) => entry.name && entry.quantity > 0);

  if (!ingredients.length) {
    return res.status(400).json({ message: 'Ingredient quantities must be greater than zero.' });
  }

  const record = {
    id: `${slugify(dishName)}-${Date.now().toString(36)}`,
    dish: dishName,
    cost: Number(cost.toFixed(2)),
    ingredients,
    createdAt: new Date().toISOString()
  };

  inventory.push(record);
  return res.status(201).json(record);
});

app.post('/api/menu/categories', (req, res) => {
  const { name } = req.body;
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    return res.status(400).json({ message: 'Category name is required.' });
  }

  const duplicate = menu.categories.some((category) => category.name.toLowerCase() === trimmedName.toLowerCase());
  if (duplicate) {
    return res.status(409).json({ message: 'A category with this name already exists.' });
  }

  const category = {
    id: slugify(trimmedName),
    name: trimmedName,
    description: `${trimmedName} dishes`
  };

  menu.categories.push(category);
  return res.status(201).json(category);
});

app.post('/api/menu/items', (req, res) => {
  const { name, category, price, prep } = req.body;
  const trimmedName = String(name || '').trim();
  const trimmedCategory = String(category || '').trim();
  const numericPrice = Number(price);

  if (!trimmedName) {
    return res.status(400).json({ message: 'Item name is required.' });
  }

  if (!trimmedCategory || !menu.categories.some((entry) => entry.id === trimmedCategory)) {
    return res.status(400).json({ message: 'A valid category is required.' });
  }

  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return res.status(400).json({ message: 'Price must be greater than zero.' });
  }

  const item = {
    id: `${slugify(trimmedName)}-${Date.now().toString(36)}`,
    name: trimmedName,
    category: trimmedCategory,
    price: Number(numericPrice.toFixed(2)),
    prep: String(prep || 'Chef special').trim() || 'Chef special',
    popular: false
  };

  menu.items.push(item);
  return res.status(201).json(item);
});

app.post('/api/orders', async (req, res) => {
  const guestCountValue = Number(req.body.guestCount);
  const plateCountValue = Number(req.body.plates);
  const guestCount = Number.isFinite(guestCountValue) && guestCountValue > 0 ? guestCountValue : 1;
  const plates = Number.isFinite(plateCountValue) && plateCountValue > 0 ? Math.min(plateCountValue, guestCount) : guestCount;
  const { items = [], discountType = 'none', paymentMethod = 'cash', serviceChargePct = 0.1, taxRate = 0.08 } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one menu item is required.' });
  }

  const orderPayload = calculateOrder({ items, guestCount, discountType, serviceChargePct, taxRate });
  const order = {
    id: `BUF-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    paymentMethod,
    guestCount,
    plates,
    items: orderPayload.items,
    subtotal: orderPayload.subtotal,
    discountType,
    discountAmount: orderPayload.discountAmount,
    serviceCharge: orderPayload.serviceCharge,
    taxRate: orderPayload.taxRate,
    taxAmount: orderPayload.taxAmount,
    total: orderPayload.total
  };

  try {
    await saveSale(order, 'menu');
  } catch (error) {
    console.error('Could not persist menu sale:', error);
    return res.status(500).json({ message: 'Could not save this sale.' });
  }
  res.status(201).json({ order, receipt: { ...order, status: 'Paid' } });
});

app.get('/api/orders', async (req, res) => {
  try {
    res.json(await getRecentSales(req.query.limit));
  } catch (error) {
    console.error('Could not read sales from MariaDB:', error);
    res.status(500).json({ message: 'Could not load sales.' });
  }
});

app.get('/api/sales', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const source = String(req.query.source || 'all');
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 25);
  const timezoneOffset = req.query.timezoneOffset === undefined ? 0 : Number(req.query.timezoneOffset);
  if (search.length > 100) return res.status(400).json({ message: 'Search must be 100 characters or fewer.' });
  if (!['all', 'buffet', 'menu'].includes(source)) return res.status(400).json({ message: 'Source must be all, buffet, or menu.' });
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return res.status(400).json({ message: 'Page must be positive and page size must be between 1 and 100.' });
  }
  try {
    getSalesDateFilter(String(req.query.startDate || ''), String(req.query.endDate || ''), timezoneOffset);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  try {
    res.json(await getSalesPage({
      startDate: String(req.query.startDate || ''),
      endDate: String(req.query.endDate || ''),
      timezoneOffset,
      search,
      source,
      page,
      pageSize
    }));
  } catch (error) {
    console.error('Could not read sales from MariaDB:', error);
    res.status(500).json({ message: 'Could not load sales.' });
  }
});

app.get('/api/sales/summary', async (req, res) => {
  const source = String(req.query.source || 'all');
  const timezoneOffset = req.query.timezoneOffset === undefined ? 0 : Number(req.query.timezoneOffset);
  if (!['all', 'buffet', 'menu'].includes(source)) return res.status(400).json({ message: 'Source must be all, buffet, or menu.' });
  try {
    getSalesDateFilter(String(req.query.startDate || ''), String(req.query.endDate || ''), timezoneOffset);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  try {
    if (req.query.startDate || req.query.endDate || source !== 'all') {
      res.json(await getFilteredSalesSummary({
        startDate: String(req.query.startDate || ''),
        endDate: String(req.query.endDate || ''),
        timezoneOffset,
        source
      }));
    } else {
      res.json(await getSalesSummary());
    }
  } catch (error) {
    console.error('Could not read sales summary from MariaDB:', error);
    res.status(500).json({ message: 'Could not load sales totals.' });
  }
});

app.get('/api/dish-costs', async (req, res) => {
  const date = String(req.query.date || '');
  const timezoneOffset = req.query.timezoneOffset === undefined ? 0 : Number(req.query.timezoneOffset);
  if (!date) return res.status(400).json({ message: 'Choose a date.' });
  try {
    getSalesDateFilter(date, date, timezoneOffset);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  try {
    const [rows] = await salesDatabase.execute(`
      SELECT
        entry_id AS id,
        DATE_FORMAT(business_date, '%Y-%m-%d') AS businessDate,
        dish_name AS dish,
        total_cost AS totalCost,
        created_at AS createdAt
      FROM dish_cost_entries
      WHERE business_date = ?
      ORDER BY created_at DESC, entry_id DESC
    `, [date]);
    const dishCostTotal = Number(rows.reduce((total, row) => total + Number(row.totalCost), 0).toFixed(2));
    const sales = await getFilteredSalesSummary({
      startDate: date,
      endDate: date,
      timezoneOffset,
      source: 'all'
    });
    res.json({
      date,
      entries: rows,
      dishCostTotal,
      earnings: sales.earnings,
      earningsAfterDishCosts: Number((sales.earnings - dishCostTotal).toFixed(2)),
      saleCount: sales.saleCount
    });
  } catch (error) {
    console.error('Could not read dish costs from MariaDB:', error);
    res.status(500).json({ message: 'Could not load dish costs and daily earnings.' });
  }
});

app.get('/api/dishes', async (req, res) => {
  try {
    const [rows] = await salesDatabase.query(`
      SELECT dish_id AS id, dish_name AS dish, default_cost AS defaultCost
      FROM dish_catalog
      ORDER BY dish_name
    `);
    res.json(rows);
  } catch (error) {
    console.error('Could not read saved dishes from MariaDB:', error);
    res.status(500).json({ message: 'Could not load saved dishes.' });
  }
});

app.post('/api/dish-costs', async (req, res) => {
  const dish = String(req.body.dish || '').trim();
  const date = String(req.body.date || '');
  const totalCost = req.body.totalCost;
  const saveToCatalog = req.body.saveToCatalog === true;
  if (!dish || dish.length > 80) return res.status(400).json({ message: 'Dish name must be between 1 and 80 characters.' });
  if (!date) return res.status(400).json({ message: 'Choose a business date.' });
  if (typeof totalCost !== 'number' || !Number.isFinite(totalCost) || totalCost < 0 || totalCost > 9999999999.99) {
    return res.status(400).json({ message: 'Dish cost must be a non-negative amount with a maximum of ₱9,999,999,999.99.' });
  }
  if (req.body.saveToCatalog !== undefined && typeof req.body.saveToCatalog !== 'boolean') {
    return res.status(400).json({ message: 'Save to catalog must be true or false.' });
  }
  try {
    getSalesDateFilter(date, date, 0);
  } catch (error) {
    return res.status(400).json({ message: `Choose a valid date. ${error.message}` });
  }
  const entry = {
    id: randomUUID(),
    date,
    dish,
    totalCost: Number(totalCost.toFixed(2)),
    createdAt: new Date().toISOString()
  };
  let connection;
  try {
    connection = await salesDatabase.getConnection();
    await connection.beginTransaction();
    let savedDish = null;
    if (saveToCatalog) {
      await connection.execute(`
        INSERT INTO dish_catalog (dish_id, dish_name, default_cost, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE default_cost = VALUES(default_cost), updated_at = VALUES(updated_at)
      `, [randomUUID(), dish, entry.totalCost, entry.createdAt, entry.createdAt]);
      const [catalogRows] = await connection.execute(`
        SELECT dish_id AS id, dish_name AS dish, default_cost AS defaultCost
        FROM dish_catalog
        WHERE dish_name = ?
      `, [dish]);
      savedDish = catalogRows[0];
    }
    await connection.execute(`
      INSERT INTO dish_cost_entries (entry_id, business_date, dish_name, total_cost, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [entry.id, entry.date, entry.dish, entry.totalCost, entry.createdAt]);
    await connection.commit();
    res.status(201).json({ ...entry, savedDish });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Could not save dish cost to MariaDB:', error);
    res.status(500).json({ message: 'Could not save the dish cost.' });
  } finally {
    if (connection) connection.release();
  }
});

app.delete('/api/dish-costs/:id', async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ message: 'Dish cost entry ID is invalid.' });
  }
  try {
    const [result] = await salesDatabase.execute('DELETE FROM dish_cost_entries WHERE entry_id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Dish cost entry not found.' });
    res.json({ deleted: true });
  } catch (error) {
    console.error('Could not delete dish cost from MariaDB:', error);
    res.status(500).json({ message: 'Could not delete the dish cost.' });
  }
});

function getAdminSessionToken(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const sessionCookie = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${adminSessionCookie}=`));
  return sessionCookie ? sessionCookie.slice(adminSessionCookie.length + 1) : '';
}

function requireAdminSession(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  const token = getAdminSessionToken(req);
  const session = adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ message: 'Admin sign-in is required.' });
  }
  next();
}

function adminPasswordMatches(candidate, configuredPassword) {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const configuredHash = createHash('sha256').update(configuredPassword).digest();
  return timingSafeEqual(candidateHash, configuredHash);
}

function validDatabaseAdminTable(table) {
  return ['sales', 'dish-costs', 'dishes'].includes(table);
}

function validDatabaseAdminId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80;
}

function parseAdminAmount(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 9999999999.99) {
    throw new Error(`${label} must be between 0 and 9,999,999,999.99.`);
  }
  return Number(value.toFixed(2));
}

function parseAdminDate(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}

app.get('/api/admin/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const configuredUsername = process.env.ADMIN_USERNAME || 'admin';
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  const token = getAdminSessionToken(req);
  const session = adminSessions.get(token);
  const authenticated = Boolean(session && session.expiresAt > Date.now());
  if (session && !authenticated) adminSessions.delete(token);
  res.json({
    username: configuredUsername,
    configured: configuredUsername.length > 0 && configuredPassword.length >= 12,
    authenticated
  });
});

app.post('/api/admin/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const configuredUsername = process.env.ADMIN_USERNAME || 'admin';
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  if (configuredPassword.length < 12) {
    return res.status(503).json({ message: 'Set ADMIN_PASSWORD to a value of at least 12 characters before using database administration.' });
  }
  const username = req.body?.username;
  const password = req.body?.password;
  if (typeof username !== 'string' || username.length > 128 || typeof password !== 'string' || password.length > 1024) {
    return res.status(400).json({ message: 'Enter the admin username and password.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = adminLoginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
  const now = Date.now();
  if (attempt.blockedUntil > now) {
    return res.status(429).json({ message: 'Too many failed sign-in attempts. Try again in 1 minute.' });
  }
  if (attempt.blockedUntil > 0) {
    attempt.failures = 0;
    attempt.blockedUntil = 0;
  }
  const usernameMatches = adminPasswordMatches(username, configuredUsername);
  const passwordMatches = adminPasswordMatches(password, configuredPassword);
  if (!usernameMatches || !passwordMatches) {
    attempt.failures += 1;
    if (attempt.failures >= 5) attempt.blockedUntil = now + adminLoginBlockDurationMs;
    adminLoginAttempts.set(ip, attempt);
    return res.status(attempt.blockedUntil ? 429 : 401).json({
      message: attempt.blockedUntil ? 'Too many failed sign-in attempts. Try again in 1 minute.' : 'The admin username or password is incorrect.'
    });
  }

  adminLoginAttempts.delete(ip);
  const token = randomBytes(32).toString('hex');
  for (const [sessionToken, session] of adminSessions) {
    if (session.expiresAt <= Date.now()) adminSessions.delete(sessionToken);
  }
  adminSessions.set(token, { expiresAt: Date.now() + adminSessionDurationMs });
  const secureCookie = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${adminSessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secureCookie}`);
  res.json({ authenticated: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  adminSessions.delete(getAdminSessionToken(req));
  res.setHeader('Set-Cookie', `${adminSessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ authenticated: false });
});

app.get('/api/admin/records/:table', requireAdminSession, async (req, res) => {
  const { table } = req.params;
  if (!validDatabaseAdminTable(table)) return res.status(404).json({ message: 'Database table not found.' });
  const search = String(req.query.search || '').trim();
  const page = Number(req.query.page || 1);
  const pageSize = 25;
  if (search.length > 100) return res.status(400).json({ message: 'Search must be 100 characters or fewer.' });
  if (!Number.isInteger(page) || page < 1) return res.status(400).json({ message: 'Page must be a positive whole number.' });

  let whereSql = '';
  let values = [];
  if (search) {
    const pattern = `%${search}%`;
    if (table === 'sales') {
      whereSql = 'WHERE sale_id LIKE ? OR table_id LIKE ? OR payment_method LIKE ?';
      values = [pattern, pattern, pattern];
    } else {
      whereSql = 'WHERE dish_name LIKE ?';
      values = [pattern];
    }
  }
  const tables = {
    sales: {
      sqlName: 'sales',
      orderBy: 'created_at DESC, sale_id DESC',
      columns: `sale_id AS id, created_at AS createdAt, source, payment_method AS paymentMethod,
        guest_count AS guestCount, subtotal, discount_amount AS discountAmount,
        service_charge AS serviceCharge, tax_amount AS taxAmount, total`
    },
    'dish-costs': {
      sqlName: 'dish_cost_entries',
      orderBy: 'business_date DESC, created_at DESC, entry_id DESC',
      columns: `entry_id AS id, DATE_FORMAT(business_date, '%Y-%m-%d') AS businessDate,
        dish_name AS dish, total_cost AS totalCost, created_at AS createdAt`
    },
    dishes: {
      sqlName: 'dish_catalog',
      orderBy: 'dish_name ASC',
      columns: `dish_id AS id, dish_name AS dish, default_cost AS defaultCost, updated_at AS updatedAt`
    }
  }[table];

  try {
    const [countRows] = await salesDatabase.execute(`SELECT COUNT(*) AS totalCount FROM ${tables.sqlName} ${whereSql}`, values);
    const offset = (page - 1) * pageSize;
    const [rows] = await salesDatabase.execute(
      `SELECT ${tables.columns} FROM ${tables.sqlName} ${whereSql} ORDER BY ${tables.orderBy} LIMIT ? OFFSET ?`,
      [...values, pageSize, offset]
    );
    const totalCount = Number(countRows[0].totalCount);
    res.json({ records: rows, page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize) });
  } catch (error) {
    console.error(`Could not read ${table} for database administration:`, error);
    res.status(500).json({ message: 'Could not load database records.' });
  }
});

app.put('/api/admin/records/:table/:id', requireAdminSession, async (req, res) => {
  const { table, id } = req.params;
  if (!validDatabaseAdminTable(table)) return res.status(404).json({ message: 'Database table not found.' });
  if (!validDatabaseAdminId(id)) return res.status(400).json({ message: 'Record ID is invalid.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ message: 'Provide the fields to update.' });
  }

  try {
    if (table === 'sales') {
      const paymentMethod = String(req.body.paymentMethod || '');
      if (!['cash', 'card', 'mobile'].includes(paymentMethod)) {
        return res.status(400).json({ message: 'Payment method must be cash, card, or mobile wallet.' });
      }
      let createdAt;
      let total;
      try {
        createdAt = parseAdminDate(req.body.createdAt, 'Sale date');
        total = parseAdminAmount(req.body.total, 'Sale total');
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
      const [rows] = await salesDatabase.execute(`
        SELECT subtotal, service_charge AS serviceCharge, tax_amount AS taxAmount, order_json
        FROM sales
        WHERE sale_id = ?
      `, [id]);
      if (!rows.length) return res.status(404).json({ message: 'Sale not found.' });
      const sale = rows[0];
      const subtotalCents = Math.round(Number(sale.subtotal) * 100);
      const totalCents = Math.round(total * 100);
      const baseCents = Math.round((Number(sale.subtotal) + Number(sale.serviceCharge) + Number(sale.taxAmount)) * 100);
      const discountCents = baseCents - totalCents;
      if (discountCents < 0 || discountCents > subtotalCents) {
        return res.status(400).json({ message: 'Sale total must be between the service and tax charges and the pre-discount total.' });
      }
      const discountAmount = Number((discountCents / 100).toFixed(2));
      let order;
      try {
        order = JSON.parse(sale.order_json);
      } catch {
        console.error(`Could not parse stored order JSON for sale ${id}.`);
        return res.status(500).json({ message: 'This sale has invalid stored details and cannot be edited.' });
      }
      order.createdAt = createdAt;
      order.paymentMethod = paymentMethod;
      order.discountAmount = discountAmount;
      order.total = total;
      await salesDatabase.execute(`
        UPDATE sales
        SET created_at = ?, payment_method = ?, discount_amount = ?, total = ?, order_json = ?
        WHERE sale_id = ?
      `, [createdAt, paymentMethod, discountAmount, total, JSON.stringify(order), id]);
      return res.json({ id, createdAt, paymentMethod, discountAmount, total });
    }

    const dish = typeof req.body.dish === 'string' ? req.body.dish.trim() : '';
    if (!dish || dish.length > 80) return res.status(400).json({ message: 'Dish name must be between 1 and 80 characters.' });
    const amountField = table === 'dish-costs' ? 'totalCost' : 'defaultCost';
    const amountLabel = table === 'dish-costs' ? 'Dish cost' : 'Default cost';
    let amount;
    try {
      amount = parseAdminAmount(req.body[amountField], amountLabel);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }

    if (table === 'dish-costs') {
      const businessDate = String(req.body.businessDate || '');
      try {
        getSalesDateFilter(businessDate, businessDate, 0);
      } catch (error) {
        return res.status(400).json({ message: `Choose a valid business date. ${error.message}` });
      }
      const [result] = await salesDatabase.execute(`
        UPDATE dish_cost_entries
        SET business_date = ?, dish_name = ?, total_cost = ?
        WHERE entry_id = ?
      `, [businessDate, dish, amount, id]);
      if (!result.affectedRows) {
        const [existing] = await salesDatabase.execute('SELECT entry_id FROM dish_cost_entries WHERE entry_id = ?', [id]);
        if (!existing.length) return res.status(404).json({ message: 'Dish-cost entry not found.' });
      }
      return res.json({ id, businessDate, dish, totalCost: amount });
    }

    const updatedAt = new Date().toISOString();
    const [result] = await salesDatabase.execute(`
      UPDATE dish_catalog
      SET dish_name = ?, default_cost = ?, updated_at = ?
      WHERE dish_id = ?
    `, [dish, amount, updatedAt, id]);
    if (!result.affectedRows) {
      const [existing] = await salesDatabase.execute('SELECT dish_id FROM dish_catalog WHERE dish_id = ?', [id]);
      if (!existing.length) return res.status(404).json({ message: 'Saved dish not found.' });
    }
    return res.json({ id, dish, defaultCost: amount, updatedAt });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A saved dish with that name already exists.' });
    console.error(`Could not update ${table} record ${id}:`, error);
    res.status(500).json({ message: 'Could not update the database record.' });
  }
});

app.delete('/api/admin/records/:table/:id', requireAdminSession, async (req, res) => {
  const { table, id } = req.params;
  if (!validDatabaseAdminTable(table)) return res.status(404).json({ message: 'Database table not found.' });
  if (!validDatabaseAdminId(id)) return res.status(400).json({ message: 'Record ID is invalid.' });
  const primaryKeys = {
    sales: ['sales', 'sale_id'],
    'dish-costs': ['dish_cost_entries', 'entry_id'],
    dishes: ['dish_catalog', 'dish_id']
  };
  const [tableName, key] = primaryKeys[table];
  try {
    const [result] = await salesDatabase.execute(`DELETE FROM ${tableName} WHERE ${key} = ?`, [id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Database record not found.' });
    res.json({ deleted: true });
  } catch (error) {
    console.error(`Could not delete ${table} record ${id}:`, error);
    res.status(500).json({ message: 'Could not delete the database record.' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  await initializeSalesDatabase();
  app.listen(PORT, () => {
    console.log(`Buffet POS server running on http://localhost:${PORT}`);
  });
}

startServer().catch(async (error) => {
  console.error('Could not initialize MariaDB. Start XAMPP MySQL and verify DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_NAME.', error);
  if (salesDatabase) await salesDatabase.end();
  process.exitCode = 1;
});
