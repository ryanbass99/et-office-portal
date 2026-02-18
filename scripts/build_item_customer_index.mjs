/**
 * Build itemCustomerIndex from Sage invoice exports for a rolling window (default 3 years).
 *
 * Purpose (ET Office Portal):
 *   Power the Customers page "Show accounts that ordered item code: X" filter quickly.
 *
 * Output:
 *   itemCustomerIndex/{itemCode__salespersonNo} (doc)
 *     - itemCode (upper)
 *     - salespersonNo (4-digit string)
 *     - customerNos (array of customer numbers as strings)
 *     - customerCount
 *     - yearsBack
 *     - updatedAt
 *
 * Defaults (override via env vars):
 *   SERVICE_ACCOUNT_PATH = C:\\SageExports\\serviceAccountKey.json
 *   CSV_HH_PATH          = C:\\SageExports\\Inv_HH.csv
 *   CSV_HD_PATH          = C:\\SageExports\\Inv_HD.csv
 *   YEARS_BACK           = 3
 *
 * Run:
 *   node scripts/build_item_customer_index.mjs
 * or:
 *   set YEARS_BACK=3
 *   node scripts/build_item_customer_index.mjs
 */

import fs from "fs";
import path from "path";
import Papa from "papaparse";
import admin from "firebase-admin";

const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || "C:\\SageExports\\serviceAccountKey.json";
const CSV_HH_PATH = process.env.CSV_HH_PATH || "C:\\SageExports\\Inv_HH.csv";
const CSV_HD_PATH = process.env.CSV_HD_PATH || "C:\\SageExports\\Inv_HD.csv";
const YEARS_BACK = Number(process.env.YEARS_BACK || 3);

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeDocId(raw) {
  return cleanStr(raw).replaceAll("/", "-");
}

function padSalesperson(v) {
  const s = cleanStr(v);
  if (!s) return "";
  return s.length >= 4 ? s : s.padStart(4, "0");
}

/** MM/DD/YYYY -> Date (local). If parse fails, returns null. */
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

function cutoffDate(yearsBack) {
  const now = new Date();
  return new Date(now.getFullYear() - yearsBack, now.getMonth(), now.getDate());
}

function ciGet(row, key) {
  if (key in row) return row[key];
  const lk = String(key).toLowerCase();
  const found = Object.keys(row).find((k) => String(k).toLowerCase() === lk);
  return found ? row[found] : undefined;
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

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

if (!exists(SERVICE_ACCOUNT_PATH)) {
  throw new Error(`Service account key not found at: ${SERVICE_ACCOUNT_PATH}`);
}
if (!exists(CSV_HH_PATH)) {
  throw new Error(`Header CSV not found at: ${CSV_HH_PATH}`);
}
if (!exists(CSV_HD_PATH)) {
  throw new Error(`Detail CSV not found at: ${CSV_HD_PATH}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const cutoff = cutoffDate(YEARS_BACK);
console.log(
  `Building itemCustomerIndex for invoices with InvoiceDate >= ${cutoff.toLocaleDateString()} (YEARS_BACK=${YEARS_BACK})`
);

// 1) Read headers and build invoiceNo -> { customerNo, salespersonNo } for in-range invoices
console.log("Reading headers:", CSV_HH_PATH);
const hhText = fs.readFileSync(CSV_HH_PATH, "utf8");
const hhParsed = Papa.parse(hhText, { header: true, skipEmptyLines: true });
const hhRows = hhParsed.data || [];
console.log("Header rows loaded:", hhRows.length);

const invMap = new Map(); // invoiceNo -> { customerNo, salespersonNo }
let hhKept = 0;

for (let i = 0; i < hhRows.length; i++) {
  const r = hhRows[i] || {};
  const invoiceNo = cleanStr(
    ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
  );
  if (!invoiceNo) continue;

  const invoiceDateRaw = cleanStr(ciGet(r, "InvoiceDate") ?? ciGet(r, "Date"));
  const invoiceDate = parseUSDate(invoiceDateRaw);
  if (!invoiceDate || invoiceDate < cutoff) continue;

  const customerNo = cleanStr(ciGet(r, "CustomerNo") ?? ciGet(r, "CustomerNumber"));
  const salespersonNo = padSalesperson(
    ciGet(r, "SalespersonNo") ?? ciGet(r, "SalesmanNo") ?? ciGet(r, "Salesperson")
  );

  if (!customerNo || !salespersonNo) continue;

  invMap.set(invoiceNo, { customerNo, salespersonNo });
  hhKept++;
}

console.log(`In-range invoices mapped: ${hhKept}`);

// 2) Read lines and build index: (itemCodeUpper, salespersonNo) -> Set(customerNo)
console.log("Reading lines:", CSV_HD_PATH);
const hdText = fs.readFileSync(CSV_HD_PATH, "utf8");
const hdParsed = Papa.parse(hdText, { header: true, skipEmptyLines: true });
const hdRows = hdParsed.data || [];
console.log("Line rows loaded:", hdRows.length);

const idx = new Map(); // key -> { itemCode, salespersonNo, customers:Set }
let linesUsed = 0;

for (let i = 0; i < hdRows.length; i++) {
  const r = hdRows[i] || {};
  const invoiceNo = cleanStr(
    ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
  );
  if (!invoiceNo) continue;

  const header = invMap.get(invoiceNo);
  if (!header) continue;

  const itemCode = cleanStr(ciGet(r, "ItemCode") ?? ciGet(r, "Item")).toUpperCase();
  if (!itemCode) continue;

  const key = `${itemCode}__${header.salespersonNo}`;
  const cur = idx.get(key) || {
    itemCode,
    salespersonNo: header.salespersonNo,
    customers: new Set(),
  };
  cur.customers.add(header.customerNo);
  idx.set(key, cur);
  linesUsed++;
}

console.log(`Lines contributing to index: ${linesUsed}`);
console.log(`Index docs to write: ${idx.size}`);

// 3) Write to Firestore
let batch = db.batch();
let batchCount = 0;
const BATCH_LIMIT = 300; // docs may include arrays; keep batch smaller
let written = 0;

for (const [key, v] of idx.entries()) {
  const docId = normalizeDocId(key);
  const ref = db.collection("itemCustomerIndex").doc(docId);

  const customerNos = Array.from(v.customers.values()).sort();
  const payload = {
    itemCode: v.itemCode,
    salespersonNo: v.salespersonNo,
    customerNos,
    customerCount: customerNos.length,
    yearsBack: YEARS_BACK,
    sourceFiles: {
      headers: path.basename(CSV_HH_PATH),
      lines: path.basename(CSV_HD_PATH),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  batch.set(ref, payload, { merge: true });
  batchCount++;
  written++;

  if (batchCount >= BATCH_LIMIT) {
    await commitWithRetry(batch);
    batch = db.batch();
    batchCount = 0;
    process.stdout.write(`Committed index docs... ${written}\r`);
  }
}

if (batchCount > 0) await commitWithRetry(batch);

console.log(`\nDONE. Wrote ${written} itemCustomerIndex docs.`);
