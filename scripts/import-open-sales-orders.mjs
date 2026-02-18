/**
 * Import Open Sales Orders lines into Firestore + write per-salesperson stats.
 *
 * - Filters: QuantityOrdered > 0
 * - Writes line docs to: openSalesOrderLines
 * - Writes stats docs to: openSalesOrderStats/{salespersonNo}
 *
 * Run:
 *   node scripts/import-open-sales-orders.mjs
 *
 * Env overrides:
 *   SERVICE_ACCOUNT_PATH (default C:\\SageExports\\serviceAccountKey.json)
 *   CSV_PATH            (default C:\\SageExports\\SO_Open.csv)
 *   LINES_COLLECTION    (default openSalesOrderLines)
 *   STATS_COLLECTION    (default openSalesOrderStats)
 */

import fs from "fs";
import path from "path";
import Papa from "papaparse";
import admin from "firebase-admin";

const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || "C:\\SageExports\\serviceAccountKey.json";
const CSV_PATH = process.env.CSV_PATH || "C:\\SageExports\\SO_Open.csv";

const LINES_COLLECTION = process.env.LINES_COLLECTION || "openSalesOrderLines";
const STATS_COLLECTION = process.env.STATS_COLLECTION || "openSalesOrderStats";

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toUpper(v) {
  return cleanStr(v).toUpperCase();
}

function parseNumber(v) {
  const s = cleanStr(v);
  if (!s) return 0;
  const n = Number(s.replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : 0;
}

function parseUSDate(mmddyyyy) {
  const s = cleanStr(mmddyyyy);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !day || !year) return null;
  return new Date(year, month - 1, day);
}

function normalizeDocId(raw) {
  return cleanStr(raw).replaceAll("/", "-");
}

function makeLineDocId({ salesOrderNo, itemCode, rowIndex }) {
  return normalizeDocId(`${salesOrderNo}__${itemCode}__${rowIndex}`);
}

async function commitWithRetry(batch, attempt = 1) {
  try {
    await batch.commit();
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      attempt <= 6 &&
      (msg.includes("ABORTED") ||
        msg.includes("DEADLINE_EXCEEDED") ||
        msg.includes("RESOURCE_EXHAUSTED"))
    ) {
      const waitMs = 250 * attempt * attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      return commitWithRetry(batch, attempt + 1);
    }
    throw err;
  }
}

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  throw new Error(`Service account key not found at: ${SERVICE_ACCOUNT_PATH}`);
}
if (!fs.existsSync(CSV_PATH)) {
  throw new Error(`CSV not found at: ${CSV_PATH}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

console.log("Reading CSV:", CSV_PATH);

const csvText = fs.readFileSync(CSV_PATH, "utf8");
const parsed = Papa.parse(csvText, {
  header: true,
  skipEmptyLines: true,
  dynamicTyping: false,
});

if (parsed.errors?.length) {
  console.warn("CSV parse warnings/errors:", parsed.errors.slice(0, 10));
}

const rows = parsed.data || [];
console.log("Rows loaded:", rows.length);

let written = 0;
let skippedZeroQty = 0;
let skippedMissingKeys = 0;

let batch = db.batch();
let batchCount = 0;
const BATCH_LIMIT = 450;

// Stats accumulator per salesperson
// salespersonNo -> { orders:Set, lines:number, qty:number }
const stats = new Map();

for (let i = 0; i < rows.length; i++) {
  const r = rows[i] || {};

  const get = (k) => {
    if (k in r) return r[k];
    const lk = String(k).toLowerCase();
    const foundKey = Object.keys(r).find((x) => String(x).toLowerCase() === lk);
    return foundKey ? r[foundKey] : undefined;
  };

  const salesOrderNo = cleanStr(get("SalesOrderNo"));
  const salespersonRaw = cleanStr(get("SalespersonNo"));
  const salespersonNo = salespersonRaw ? salespersonRaw.padStart(4, "0") : "";
  const customerNo = cleanStr(get("CustomerNo"));
  const itemCode = cleanStr(get("ItemCode"));
  const qty = parseNumber(get("QuantityOrdered"));

  if (qty <= 0) {
    skippedZeroQty++;
    continue;
  }
  if (!salesOrderNo || !salespersonNo || !itemCode) {
    skippedMissingKeys++;
    continue;
  }

  // accumulate stats
  const s = stats.get(salespersonNo) || { orders: new Set(), lines: 0, qty: 0 };
  s.orders.add(salesOrderNo);
  s.lines += 1;
  s.qty += qty;
  stats.set(salespersonNo, s);

  const orderDateRaw = cleanStr(get("OrderDate"));
  const orderDate = parseUSDate(orderDateRaw);

  const docId = makeLineDocId({ salesOrderNo, itemCode, rowIndex: i + 1 });
  const ref = db.collection(LINES_COLLECTION).doc(docId);

  const payload = {
    salesOrderNo,
    salespersonNo,
    customerNo,
    itemCode,
    quantityOrdered: qty,

    orderDate: orderDate ? admin.firestore.Timestamp.fromDate(orderDate) : null,

    shipToName: cleanStr(get("ShipToName")),
    shipToAddress1: cleanStr(get("ShipToAddress1")),
    shipToCity: cleanStr(get("ShipToCity")),
    shipToState: toUpper(get("ShipToState")),
    shipToZipCode: cleanStr(get("ShipToZipCode")),

    itemCodeDesc: cleanStr(get("ItemCodeDesc")),

    source: { file: path.basename(CSV_PATH), rowIndex: i + 1 },
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  batch.set(ref, payload, { merge: true });
  batchCount++;
  written++;

  if (batchCount >= BATCH_LIMIT) {
    await commitWithRetry(batch);
    batch = db.batch();
    batchCount = 0;
    process.stdout.write(`Committed lines... total written: ${written}\r`);
  }
}

if (batchCount > 0) {
  await commitWithRetry(batch);
}

console.log("\nLines import done.");
console.log("Written:", written);
console.log("Skipped (qty<=0):", skippedZeroQty);
console.log("Skipped (missing keys):", skippedMissingKeys);

// Write stats docs (one per salesperson)
console.log("Writing stats docs:", stats.size);

let statsBatch = db.batch();
let statsBatchCount = 0;
const STATS_BATCH_LIMIT = 400;

for (const [salespersonNo, s] of stats.entries()) {
  const ref = db.collection(STATS_COLLECTION).doc(normalizeDocId(salespersonNo));
  statsBatch.set(
    ref,
    {
      salespersonNo,
      openOrders: s.orders.size,
      openLines: s.lines,
      totalQty: s.qty,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      sourceFile: path.basename(CSV_PATH),
    },
    { merge: true }
  );
  statsBatchCount++;

  if (statsBatchCount >= STATS_BATCH_LIMIT) {
    await commitWithRetry(statsBatch);
    statsBatch = db.batch();
    statsBatchCount = 0;
    process.stdout.write("Committed stats batch...\r");
  }
}

if (statsBatchCount > 0) {
  await commitWithRetry(statsBatch);
}

console.log("\nDone. Stats collection:", STATS_COLLECTION);
