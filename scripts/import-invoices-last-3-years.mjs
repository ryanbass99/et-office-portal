/**
 * Import invoices (headers + lines) from Sage CSV exports into Firestore.
 * Rolling window: keeps invoices with InvoiceDate >= (today - YEARS_BACK years)
 *
 * Defaults (override via env vars):
 *   SERVICE_ACCOUNT_PATH = C:\\SageExports\\serviceAccountKey.json
 *   CSV_HH_PATH          = C:\\SageExports\\Inv_HH.csv
 *   CSV_HD_PATH          = C:\\SageExports\\Inv_HD.csv
 *   YEARS_BACK           = 3
 *
 * Collections:
 *   invoices/{invoiceNo}              (header)
 *   invoices/{invoiceNo}/lines/{id}   (lines)
 *
 * Run:
 *   node scripts/import_invoices_last_year.mjs
 * or:
 *   YEARS_BACK=3 node scripts/import_invoices_last_year.mjs
 *
 * Notes:
 * - Uses InvoiceDate (MM/DD/YYYY) for filtering.
 * - Lines are imported only if their parent header is in-range.
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

function parseNumber(v) {
  const s = cleanStr(v);
  if (!s) return 0;
  const n = Number(s.replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : 0;
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

function normalizeDocId(raw) {
  // Firestore doc IDs cannot contain forward slashes.
  return cleanStr(raw).replaceAll("/", "-");
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

function cutoffDate(yearsBack) {
  const now = new Date();
  return new Date(now.getFullYear() - yearsBack, now.getMonth(), now.getDate());
}


function sanitizeRow(row) {
  // Firestore rejects empty field names. Also trim keys.
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = String(k ?? "").trim();
    if (!key) continue; // drop empty header columns
    // Also avoid keys containing only dots or invalid segments by replacing consecutive dots
    // Keep it simple: replace '.' with '_'
    const safeKey = key.replaceAll(".", "_");
    out[safeKey] = v;
  }
  return out;
}

function ciGet(row, key) {
  if (key in row) return row[key];
  const lk = String(key).toLowerCase();
  const found = Object.keys(row).find((k) => String(k).toLowerCase() === lk);
  return found ? row[found] : undefined;
}

if (!osExists(SERVICE_ACCOUNT_PATH)) {
  throw new Error(`Service account key not found at: ${SERVICE_ACCOUNT_PATH}`);
}
if (!osExists(CSV_HH_PATH)) {
  throw new Error(`Header CSV not found at: ${CSV_HH_PATH}`);
}
if (!osExists(CSV_HD_PATH)) {
  throw new Error(`Detail CSV not found at: ${CSV_HD_PATH}`);
}

function osExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const cutoff = cutoffDate(YEARS_BACK);

console.log(
  `Importing invoices with InvoiceDate >= ${cutoff.toLocaleDateString()} (YEARS_BACK=${YEARS_BACK})`
);

console.log("Reading headers:", CSV_HH_PATH);
const hhText = fs.readFileSync(CSV_HH_PATH, "utf8");
const hhParsed = Papa.parse(hhText, { header: true, skipEmptyLines: true });
if (hhParsed.errors?.length)
  console.warn("Header CSV parse warnings:", hhParsed.errors.slice(0, 10));

const hhRows = hhParsed.data || [];
console.log("Header rows loaded:", hhRows.length);

// Keep set of invoiceNos that are in-range so we only import their lines
const inRangeInvoiceNos = new Set();

let batch = db.batch();
let batchCount = 0;
const BATCH_LIMIT = 450;

let headersWritten = 0;
let headersSkipped = 0;

for (let i = 0; i < hhRows.length; i++) {
  const r = hhRows[i] || {};
  const invoiceNo = cleanStr(
    ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
  );
  if (!invoiceNo) {
    headersSkipped++;
    continue;
  }

  const invoiceDateRaw = cleanStr(ciGet(r, "InvoiceDate") ?? ciGet(r, "Date"));
  const invoiceDate = parseUSDate(invoiceDateRaw);

  if (!invoiceDate || invoiceDate < cutoff) {
    headersSkipped++;
    continue;
  }

  inRangeInvoiceNos.add(invoiceNo);

  const docId = normalizeDocId(invoiceNo);
  const ref = db.collection("invoices").doc(docId);

  const payload = {
    invoiceNo,
    invoiceDate: admin.firestore.Timestamp.fromDate(invoiceDate),

    customerNo: cleanStr(ciGet(r, "CustomerNo") ?? ciGet(r, "CustomerNumber")),
    arDivisionNo: cleanStr(ciGet(r, "ARDivisionNo") ?? ciGet(r, "DivisionNo")),
    salespersonNo: cleanStr(
      ciGet(r, "SalespersonNo") ??
        ciGet(r, "SalesmanNo") ??
        ciGet(r, "Salesperson")
    ).padStart(4, "0"),

    invoiceTotal: parseNumber(
      ciGet(r, "InvoiceTotal") ??
        ciGet(r, "Total") ??
        ciGet(r, "InvoiceAmt") ??
        ciGet(r, "InvoiceAmount")
    ),
    taxAmt: parseNumber(ciGet(r, "TaxAmt") ?? ciGet(r, "TaxAmount")),
    freightAmt: parseNumber(ciGet(r, "FreightAmt") ?? ciGet(r, "FreightAmount")),

    raw: sanitizeRow(r),
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: { file: path.basename(CSV_HH_PATH), rowIndex: i + 1 },
  };

  batch.set(ref, payload, { merge: true });
  batchCount++;
  headersWritten++;

  if (batchCount >= BATCH_LIMIT) {
    await commitWithRetry(batch);
    batch = db.batch();
    batchCount = 0;
    process.stdout.write(`Committed headers... ${headersWritten}\r`);
  }
}

if (batchCount > 0) await commitWithRetry(batch);

console.log(
  `\nHeaders done. Written: ${headersWritten}, Skipped(out of range/missing): ${headersSkipped}`
);

console.log("Reading lines:", CSV_HD_PATH);
const hdText = fs.readFileSync(CSV_HD_PATH, "utf8");
const hdParsed = Papa.parse(hdText, { header: true, skipEmptyLines: true });
if (hdParsed.errors?.length)
  console.warn("Line CSV parse warnings:", hdParsed.errors.slice(0, 10));

const hdRows = hdParsed.data || [];
console.log("Line rows loaded:", hdRows.length);

let linesWritten = 0;
let linesSkipped = 0;

batch = db.batch();
batchCount = 0;

function makeLineId(invoiceNo, lineKey, rowIndex) {
  const k = cleanStr(lineKey);
  if (k) return normalizeDocId(`${invoiceNo}__${k}`);
  return normalizeDocId(`${invoiceNo}__${rowIndex}`);
}

for (let i = 0; i < hdRows.length; i++) {
  const r = hdRows[i] || {};
  const invoiceNo = cleanStr(
    ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
  );
  if (!invoiceNo || !inRangeInvoiceNos.has(invoiceNo)) {
    linesSkipped++;
    continue;
  }

  const docId = normalizeDocId(invoiceNo);
  const lineKey =
    ciGet(r, "LineKey") ??
    ciGet(r, "InvoiceLineKey") ??
    ciGet(r, "DetailSeqNo") ??
    ciGet(r, "LineSeqNo") ??
    "";

  const lineId = makeLineId(invoiceNo, lineKey, i + 1);
  const ref = db.collection("invoices").doc(docId).collection("lines").doc(lineId);

  const qty = parseNumber(
    ciGet(r, "QuantityShipped") ??
      ciGet(r, "Quantity") ??
      ciGet(r, "QtyShipped") ??
      ciGet(r, "Qty")
  );

  const payload = {
    invoiceNo,
    itemCode: cleanStr(ciGet(r, "ItemCode") ?? ciGet(r, "Item")),
    itemCodeDesc: cleanStr(
      ciGet(r, "ItemCodeDesc") ??
        ciGet(r, "ItemDescription") ??
        ciGet(r, "Desc")
    ),
    quantityShipped: qty,
    unitPrice: parseNumber(ciGet(r, "UnitPrice") ?? ciGet(r, "Price")),
    extensionAmt: parseNumber(
      ciGet(r, "ExtensionAmt") ?? ciGet(r, "ExtAmount") ?? ciGet(r, "Amount")
    ),

    raw: sanitizeRow(r),
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: { file: path.basename(CSV_HD_PATH), rowIndex: i + 1 },
  };

  batch.set(ref, payload, { merge: true });
  batchCount++;
  linesWritten++;

  if (batchCount >= BATCH_LIMIT) {
    await commitWithRetry(batch);
    batch = db.batch();
    batchCount = 0;
    process.stdout.write(`Committed lines... ${linesWritten}\r`);
  }
}

if (batchCount > 0) await commitWithRetry(batch);

console.log(
  `\nLines done. Written: ${linesWritten}, Skipped(not in-range): ${linesSkipped}`
);
console.log("DONE.");
