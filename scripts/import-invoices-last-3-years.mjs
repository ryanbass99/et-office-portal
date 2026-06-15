/**
 * FAST NIGHTLY VERSION
 *
 * Imports only recent/new Sage invoices and lines, instead of all 3M lines.
 *
 * Default behavior:
 * - Looks back 14 days by invoice date
 * - Imports matching invoice headers
 * - Imports only line rows for those invoice numbers
 * - Safe to rerun
 *
 * After this runs, still run:
 *   node build_item_customer_index.mjs
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import Papa from "papaparse";
import admin from "firebase-admin";

const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || "C:\\SageExports\\serviceAccountKey.json";

const CSV_HH_PATH =
  process.env.CSV_HH_PATH || "\\\\ets02\\ETS02_SAGE\\SageExports\\Inv_HH.csv";

const CSV_HD_PATH =
  process.env.CSV_HD_PATH || "\\\\ets02\\ETS02_SAGE\\SageExports\\Inv_HD.csv";

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 400);

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseNumber(v) {
  const s0 = cleanStr(v);
  if (!s0) return 0;

  let s = s0.replaceAll(",", "").replaceAll("$", "").trim();

  const isParenNeg = s.startsWith("(") && s.endsWith(")");
  const isTrailNeg = s.endsWith("-");

  s = s.replace(/[()]/g, "").replace(/-$/, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  return isParenNeg || isTrailNeg ? -n : n;
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

function sanitizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = String(k ?? "").trim();
    if (!key) continue;
    out[key.replaceAll(".", "_")] = v;
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

function stableHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function buildLineSignature(r, invoiceNo) {
  return [
    cleanStr(invoiceNo),
    cleanStr(ciGet(r, "ItemCode")),
    cleanStr(ciGet(r, "ItemCodeDesc")),
    parseNumber(ciGet(r, "QuantityShipped")),
    parseNumber(ciGet(r, "ExtensionAmt")),
    parseNumber(ciGet(r, "UnitPrice")),
    cleanStr(ciGet(r, "WarehouseCode")),
    cleanStr(ciGet(r, "ProductLine")),
    cleanStr(ciGet(r, "AliasItemNo")),
    cleanStr(ciGet(r, "CommentText")),
    cleanStr(ciGet(r, "SalesAcctKey")),
  ].join("|");
}

function makeLineId(invoiceNo, r) {
  const explicitLineKey =
    cleanStr(ciGet(r, "LineKey")) ||
    cleanStr(ciGet(r, "InvoiceLineKey")) ||
    cleanStr(ciGet(r, "DetailSeqNo")) ||
    cleanStr(ciGet(r, "LineSeqNo"));

  if (explicitLineKey) {
    return normalizeDocId(`${invoiceNo}__${explicitLineKey}`);
  }

  return normalizeDocId(`${invoiceNo}__sig__${stableHash(buildLineSignature(r, invoiceNo))}`);
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function cutoffDate(daysBack) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
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

function parseCsvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");

  return Papa.parse(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => String(h ?? "").replace(/^\uFEFF/, "").trim(),
  }).data;
}

if (!fileExists(SERVICE_ACCOUNT_PATH)) {
  throw new Error(`Service account key not found at: ${SERVICE_ACCOUNT_PATH}`);
}

if (!fileExists(CSV_HH_PATH)) {
  throw new Error(`Header CSV not found at: ${CSV_HH_PATH}`);
}

if (!fileExists(CSV_HD_PATH)) {
  throw new Error(`Detail CSV not found at: ${CSV_HD_PATH}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function run() {
  const cutoff = cutoffDate(LOOKBACK_DAYS);

  console.log("FAST INVOICE IMPORT STARTED");
  console.log(`Looking back ${LOOKBACK_DAYS} days from today`);
  console.log(`Cutoff date: ${cutoff.toLocaleDateString()}`);
  console.log("Header CSV:", CSV_HH_PATH);
  console.log("Detail CSV:", CSV_HD_PATH);

  const headerRows = parseCsvFile(CSV_HH_PATH);
  console.log(`Header rows loaded: ${headerRows.length.toLocaleString()}`);

  const invoiceNosToImport = new Set();

  let headerBatch = db.batch();
  let headerBatchCount = 0;
  let headersWritten = 0;

  for (let i = 0; i < headerRows.length; i++) {
    const r = headerRows[i];

    const invoiceNo = cleanStr(
      ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
    );

    if (!invoiceNo) continue;

    const invoiceDateRaw = cleanStr(ciGet(r, "InvoiceDate") ?? ciGet(r, "Date"));
    const invoiceDate = parseUSDate(invoiceDateRaw);

    if (!invoiceDate || invoiceDate < cutoff) continue;

    invoiceNosToImport.add(invoiceNo);

    const freightAmt = parseNumber(ciGet(r, "FreightAmt"));
    const discountAmt = parseNumber(ciGet(r, "DiscountAmt"));

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
      source: {
        file: path.basename(CSV_HH_PATH),
        rowIndex: i + 1,
        mode: "fast-nightly",
      },
    };

    headerBatch.set(ref, payload, { merge: true });
    headerBatchCount++;
    headersWritten++;

    if (headerBatchCount >= BATCH_LIMIT) {
      await commitWithRetry(headerBatch);
      headerBatch = db.batch();
      headerBatchCount = 0;
      console.log(`Committed headers: ${headersWritten.toLocaleString()}`);
    }
  }

  if (headerBatchCount > 0) {
    await commitWithRetry(headerBatch);
  }

  console.log(`Recent invoices found: ${invoiceNosToImport.size.toLocaleString()}`);
  console.log(`Headers written: ${headersWritten.toLocaleString()}`);

  if (invoiceNosToImport.size === 0) {
    console.log("No recent invoices found. Done.");
    return;
  }

  const detailRows = parseCsvFile(CSV_HD_PATH);
  console.log(`Detail rows loaded: ${detailRows.length.toLocaleString()}`);

  let lineBatch = db.batch();
  let lineBatchCount = 0;
  let linesWritten = 0;
  let detailRowsChecked = 0;
  let matchingDetailRows = 0;

  const seenLineKeys = new Set();

  for (let i = 0; i < detailRows.length; i++) {
    const r = detailRows[i];

    detailRowsChecked++;

    const invoiceNo = cleanStr(
      ciGet(r, "InvoiceNo") ?? ciGet(r, "InvoiceNumber") ?? ciGet(r, "Invoice")
    );

    if (!invoiceNo || !invoiceNosToImport.has(invoiceNo)) continue;

    matchingDetailRows++;

    if (!cleanStr(ciGet(r, "ItemCode")) && !cleanStr(ciGet(r, "ItemCodeDesc"))) {
      continue;
    }

    const docId = normalizeDocId(invoiceNo);
    const invoiceRef = db.collection("invoices").doc(docId);

    lineBatch.set(invoiceRef, { invoiceNo }, { merge: true });
    lineBatchCount++;

    const lineId = makeLineId(invoiceNo, r);
    const dedupeKey = `${docId}|${lineId}`;

    if (seenLineKeys.has(dedupeKey)) {
      continue;
    }

    seenLineKeys.add(dedupeKey);

    const lineRef = invoiceRef.collection("lines").doc(lineId);

    const extensionAmt = parseNumber(ciGet(r, "ExtensionAmt"));
    const unitPrice = parseNumber(ciGet(r, "UnitPrice"));
    const quantityShipped = parseNumber(ciGet(r, "QuantityShipped"));

    const payload = {
      invoiceNo,

      itemCode: cleanStr(ciGet(r, "ItemCode")),
      itemCodeDesc: cleanStr(ciGet(r, "ItemCodeDesc")),

      // These keep compatibility with the simplified importer/page.
      description: cleanStr(ciGet(r, "ItemCodeDesc")),
      quantityShipped,
      qty: quantityShipped,
      unitPrice,
      extensionAmt,
      ext: extensionAmt,

      discount: parseNumber(ciGet(r, "Discount")),
      productLine: cleanStr(ciGet(r, "ProductLine")),
      aliasItemNo: cleanStr(ciGet(r, "AliasItemNo")),
      commentText: cleanStr(ciGet(r, "CommentText")),
      warehouseCode: cleanStr(ciGet(r, "WarehouseCode")),
      salesAcctKey: cleanStr(ciGet(r, "SalesAcctKey")),

      raw: sanitizeRow(r),
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: {
        file: path.basename(CSV_HD_PATH),
        rowIndex: i + 1,
        mode: "fast-nightly",
      },
    };

    lineBatch.set(lineRef, payload, { merge: true });
    lineBatchCount++;
    linesWritten++;

    if (lineBatchCount >= BATCH_LIMIT) {
      await commitWithRetry(lineBatch);
      lineBatch = db.batch();
      lineBatchCount = 0;
      console.log(`Committed lines: ${linesWritten.toLocaleString()}`);
    }
  }

  if (lineBatchCount > 0) {
    await commitWithRetry(lineBatch);
  }

  console.log(`Detail rows checked: ${detailRowsChecked.toLocaleString()}`);
  console.log(`Matching detail rows: ${matchingDetailRows.toLocaleString()}`);
  console.log(`Lines written: ${linesWritten.toLocaleString()}`);
  console.log("FAST INVOICE IMPORT DONE");
}

run().catch((err) => {
  console.error("IMPORT FAILED:", err);
  process.exit(1);
});