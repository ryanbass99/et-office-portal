/**
 * Import invoices (headers + lines) from Sage CSV exports into Firestore.
 * Rolling window: keeps invoices with InvoiceDate >= (today - YEARS_BACK years)
 *
 * Improvements vs earlier version:
 * - Streams CSVs (handles multi‑million rows without huge RAM use)
 * - Trims/sanitizes headers, removes BOM
 * - Skips malformed rows safely (bad quotes / too few fields) instead of poisoning the import
 * - Captures header fields you export (CustomerPONo, NonTaxableSalesAmt, DiscountAmt, Comment, InvoiceType, SalesTaxAmt)
 * - Captures detail fields you export (Discount, ProductLine, AliasItemNo, CommentText, WarehouseCode, SalesAcctKey, UnitPrice, ExtensionAmt)
 * - Computes merchTotal + invoiceTotalComputed without re-reading Firestore (uses HH freight/discount maps)
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
 * Run (PowerShell):
 *   node .\import-invoices-last-3-years.tight.mjs
 * or:
 *   $env:YEARS_BACK="3"; node .\import-invoices-last-3-years.tight.mjs
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

// Tune if you want
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 450);

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

function osExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
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
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("UNAVAILABLE"))
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
    if (!key) continue;
    const safeKey = key.replaceAll(".", "_");
    out[safeKey] = v;
  }
  return out;
}

function ciGet(row, key) {
  if (!row) return undefined;
  if (key in row) return row[key];
  const lk = String(key).toLowerCase();
  const found = Object.keys(row).find((k) => String(k).toLowerCase() === lk);
  return found ? row[found] : undefined;
}

function streamParseCsv(filePath, onRow, label) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });

    let rowCount = 0;
    let skippedCount = 0;
    let parseErrorCount = 0;

    Papa.parse(stream, {
      header: true,
      skipEmptyLines: "greedy",
      quoteChar: '"',
      escapeChar: '"',
      transformHeader: (h) => String(h ?? "").replace(/^\uFEFF/, "").trim(),
      beforeFirstChunk: (chunk) => chunk.replace(/^\uFEFF/, ""), // strip BOM
      step: async (results) => {
        rowCount++;
        const row = results?.data;

        if (!row || typeof row !== "object" || Object.keys(row).length === 0) {
          skippedCount++;
          return;
        }

        if (results?.errors?.length) {
          parseErrorCount += results.errors.length;
        }

        try {
          const ok = await onRow(row, rowCount);
          if (!ok) skippedCount++;
        } catch {
          skippedCount++;
        }

        if (rowCount % 200000 === 0) {
          process.stdout.write(
            `${label}: parsed ${rowCount.toLocaleString()} rows (skipped ${skippedCount.toLocaleString()}, parseErr ${parseErrorCount.toLocaleString()})\r`
          );
        }
      },
      complete: () => {
        process.stdout.write(
          `${label}: parsed ${rowCount.toLocaleString()} rows (skipped ${skippedCount.toLocaleString()}, parseErr ${parseErrorCount.toLocaleString()})\n`
        );
        resolve({ rowCount, skippedCount, parseErrorCount });
      },
      error: (err) => reject(err),
    });
  });
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

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const cutoff = cutoffDate(YEARS_BACK);

console.log(
  `Importing invoices with InvoiceDate >= ${cutoff.toLocaleDateString()} (YEARS_BACK=${YEARS_BACK})`
);

const inRangeInvoiceNos = new Set();
const headerFreight = new Map();   // invoiceNo -> number
const headerDiscount = new Map();  // invoiceNo -> number

let headerBatch = db.batch();
let headerBatchCount = 0;
let headersWritten = 0;

console.log("Streaming headers:", CSV_HH_PATH);

await streamParseCsv(
  CSV_HH_PATH,
  async (r, rowIndex) => {
    const invoiceNo = cleanStr(ciGet(r, "InvoiceNo"));
    if (!invoiceNo) return false;

    const invoiceDateRaw = cleanStr(ciGet(r, "InvoiceDate") ?? ciGet(r, "Date"));
    const invoiceDate = parseUSDate(invoiceDateRaw);
    if (!invoiceDate || invoiceDate < cutoff) return false;

    inRangeInvoiceNos.add(invoiceNo);

    const freightAmt = parseNumber(ciGet(r, "FreightAmt"));
    const discountAmt = parseNumber(ciGet(r, "DiscountAmt"));
    headerFreight.set(invoiceNo, freightAmt);
    headerDiscount.set(invoiceNo, discountAmt);

    const docId = normalizeDocId(invoiceNo);
    const ref = db.collection("invoices").doc(docId);

    const payload = {
      invoiceNo,
      invoiceDate: admin.firestore.Timestamp.fromDate(invoiceDate),

      customerNo: cleanStr(ciGet(r, "CustomerNo") ?? ciGet(r, "CustomerNumber")),
      arDivisionNo: cleanStr(ciGet(r, "ARDivisionNo") ?? ciGet(r, "DivisionNo")),
      salespersonNo: cleanStr(ciGet(r, "SalespersonNo")).padStart(4, "0"),

      taxAmt: parseNumber(ciGet(r, "SalesTaxAmt")),
      customerPONo: cleanStr(ciGet(r, "CustomerPONo")),
      nonTaxableSalesAmt: parseNumber(ciGet(r, "NonTaxableSalesAmt")),
      freightAmt,
      discountAmt,
      comment: cleanStr(ciGet(r, "Comment")),
      invoiceType: cleanStr(ciGet(r, "InvoiceType")),

      raw: sanitizeRow(r),
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: { file: path.basename(CSV_HH_PATH), rowIndex },
    };

    headerBatch.set(ref, payload, { merge: true });
    headerBatchCount++;
    headersWritten++;

    if (headerBatchCount >= BATCH_LIMIT) {
      await commitWithRetry(headerBatch);
      headerBatch = db.batch();
      headerBatchCount = 0;
      process.stdout.write(`Committed headers... ${headersWritten.toLocaleString()}\r`);
    }

    return true;
  },
  "Headers"
);

if (headerBatchCount > 0) await commitWithRetry(headerBatch);

console.log(`Headers done. Written: ${headersWritten.toLocaleString()}`);

console.log("Streaming lines:", CSV_HD_PATH);

const merchTotals = new Map(); // invoiceNo -> sum(extensionAmt)

let lineBatch = db.batch();
let lineBatchCount = 0;
let linesWritten = 0;

function makeLineId(invoiceNo, lineKey, rowIndex) {
  const k = cleanStr(lineKey);
  if (k) return normalizeDocId(`${invoiceNo}__${k}`);
  return normalizeDocId(`${invoiceNo}__${rowIndex}`);
}

await streamParseCsv(
  CSV_HD_PATH,
  async (r, rowIndex) => {
    const invoiceNo = cleanStr(ciGet(r, "InvoiceNo"));
    if (!invoiceNo || !inRangeInvoiceNos.has(invoiceNo)) return false;

    const docId = normalizeDocId(invoiceNo);

    const lineKey =
      ciGet(r, "LineKey") ??
      ciGet(r, "InvoiceLineKey") ??
      ciGet(r, "DetailSeqNo") ??
      ciGet(r, "LineSeqNo") ??
      "";

    const lineId = makeLineId(invoiceNo, lineKey, rowIndex);
    const ref = db.collection("invoices").doc(docId).collection("lines").doc(lineId);

    const extensionAmt = parseNumber(ciGet(r, "ExtensionAmt"));
    const unitPrice = parseNumber(ciGet(r, "UnitPrice"));

    // Minimal validation (skips most malformed rows cleanly)
    if (!cleanStr(ciGet(r, "ItemCode")) && !cleanStr(ciGet(r, "ItemCodeDesc"))) return false;

    const payload = {
      invoiceNo,
      itemCode: cleanStr(ciGet(r, "ItemCode")),
      itemCodeDesc: cleanStr(ciGet(r, "ItemCodeDesc")),
      quantityShipped: parseNumber(ciGet(r, "QuantityShipped")),

      discount: parseNumber(ciGet(r, "Discount")),
      productLine: cleanStr(ciGet(r, "ProductLine")),
      aliasItemNo: cleanStr(ciGet(r, "AliasItemNo")),
      commentText: cleanStr(ciGet(r, "CommentText")),
      unitPrice,
      extensionAmt,
      warehouseCode: cleanStr(ciGet(r, "WarehouseCode")),
      salesAcctKey: cleanStr(ciGet(r, "SalesAcctKey")),

      raw: sanitizeRow(r),
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: { file: path.basename(CSV_HD_PATH), rowIndex },
    };

    lineBatch.set(ref, payload, { merge: true });
    lineBatchCount++;
    linesWritten++;

    merchTotals.set(invoiceNo, (merchTotals.get(invoiceNo) || 0) + extensionAmt);

    if (lineBatchCount >= BATCH_LIMIT) {
      await commitWithRetry(lineBatch);
      lineBatch = db.batch();
      lineBatchCount = 0;
      process.stdout.write(`Committed lines... ${linesWritten.toLocaleString()}\r`);
    }

    return true;
  },
  "Lines"
);

if (lineBatchCount > 0) await commitWithRetry(lineBatch);

console.log(`Lines done. Written: ${linesWritten.toLocaleString()}`);

console.log("Updating computed totals on invoice headers...");

let totalsBatch = db.batch();
let totalsBatchCount = 0;
let totalsUpdated = 0;

for (const [invoiceNo, merchTotal] of merchTotals.entries()) {
  const docId = normalizeDocId(invoiceNo);
  const ref = db.collection("invoices").doc(docId);

  const freightAmt = headerFreight.get(invoiceNo) || 0;
  const discountAmt = headerDiscount.get(invoiceNo) || 0;

  totalsBatch.set(
    ref,
    {
      merchTotal,
      invoiceTotalComputed: merchTotal + freightAmt - discountAmt,
      totalsComputedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  totalsBatchCount++;
  totalsUpdated++;

  if (totalsBatchCount >= BATCH_LIMIT) {
    await commitWithRetry(totalsBatch);
    totalsBatch = db.batch();
    totalsBatchCount = 0;
    process.stdout.write(`Committed computed totals... ${totalsUpdated.toLocaleString()}\r`);
  }
}

if (totalsBatchCount > 0) await commitWithRetry(totalsBatch);

console.log(`\nComputed totals updated for ${totalsUpdated.toLocaleString()} invoices.`);
console.log("DONE.");
