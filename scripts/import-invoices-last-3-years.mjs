/**
 * Import invoices (headers + lines) from Sage CSV exports into Firestore.
 * Rolling window: keeps invoices with InvoiceDate >= (today - YEARS_BACK years)
 *
 * Changes in this version:
 * - NO MORE rowIndex fallback for invoice line IDs
 * - Invoice line IDs now use a deterministic business signature hash
 * - Duplicate logical lines in the same import run are skipped
 * - Safe to rerun without recreating doubled line docs
 *
 * Defaults (override via env vars):
 *   SERVICE_ACCOUNT_PATH = C:\\SageExports\\serviceAccountKey.json
 *   CSV_HH_PATH          = \\ets02\\ETS02_SAGE\\SageExports\\Inv_HH.csv
 *   CSV_HD_PATH          = \\ets02\\ETS02_SAGE\\SageExports\\Inv_HD.csv
 *   YEARS_BACK           = 3
 *
 * Collections:
 *   invoices/{invoiceNo}              (header)
 *   invoices/{invoiceNo}/lines/{id}   (lines)
 *
 * Run (PowerShell):
 *   node .\import-invoices-last-3-years.mjs
 * or:
 *   $env:YEARS_BACK="3"; node .\import-invoices-last-3-years.mjs
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
const YEARS_BACK = Number(process.env.YEARS_BACK || 3);
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 450);

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

function stableHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function buildLineBusinessSignature(r, invoiceNo) {
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

  const signature = buildLineBusinessSignature(r, invoiceNo);
  return normalizeDocId(`${invoiceNo}__sig__${stableHash(signature)}`);
}

function streamParseCsv(filePath, onRow, label) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });

    let rowCount = 0;
    let skippedCount = 0;
    let parseErrorCount = 0;
    let processing = Promise.resolve();
    let finishedReading = false;
    let settled = false;

    function done(err) {
      if (settled) return;
      settled = true;

      if (err) {
        reject(err);
      } else {
        process.stdout.write(
          `${label}: parsed ${rowCount.toLocaleString()} rows (skipped ${skippedCount.toLocaleString()}, parseErr ${parseErrorCount.toLocaleString()})\n`
        );
        resolve({ rowCount, skippedCount, parseErrorCount });
      }
    }

    const papaStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
      header: true,
      skipEmptyLines: "greedy",
      quoteChar: '"',
      escapeChar: '"',
      transformHeader: (h) => String(h ?? "").replace(/^\uFEFF/, "").trim(),
      beforeFirstChunk: (chunk) => {
        let c = chunk.replace(/^\uFEFF/, "");

        const nl = c.indexOf("\n");
        if (nl === -1) return c;

        const headerLine = c.slice(0, nl).replace(/\r$/, "");
        const rest = c.slice(nl + 1);

        const cols = [];
        let cur = "";
        let inQ = false;

        for (let i = 0; i < headerLine.length; i++) {
          const ch = headerLine[i];
          if (ch === '"') {
            const next = headerLine[i + 1];
            if (inQ && next === '"') {
              cur += '"';
              i++;
            } else {
              inQ = !inQ;
            }
          } else if (ch === "," && !inQ) {
            cols.push(cur);
            cur = "";
          } else {
            cur += ch;
          }
        }
        cols.push(cur);

        const seen = new Map();
        const deduped = cols.map((raw) => {
          const name = raw.trim();
          const key = name.toLowerCase();
          const n = (seen.get(key) || 0) + 1;
          seen.set(key, n);
          if (n === 1) return raw;

          const base = name.replace(/^"|"$/g, "");
          const outName = `${base}_${n}`;
          return raw.startsWith('"') ? `"${outName}"` : outName;
        });

        return deduped.join(",") + "\n" + rest;
      },
    });

    papaStream.on("data", (row) => {
      papaStream.pause();

      processing = processing
        .then(async () => {
          rowCount++;

          if (!row || typeof row !== "object" || Object.keys(row).length === 0) {
            skippedCount++;
            return;
          }

          try {
            const ok = await onRow(row, rowCount);
            if (!ok) skippedCount++;
          } catch {
            parseErrorCount++;
            skippedCount++;
          }

          if (rowCount % 200000 === 0) {
            process.stdout.write(
              `${label}: parsed ${rowCount.toLocaleString()} rows (skipped ${skippedCount.toLocaleString()}, parseErr ${parseErrorCount.toLocaleString()})\r`
            );
          }
        })
        .then(() => {
          papaStream.resume();
          if (finishedReading) {
            return processing.then(() => done());
          }
        })
        .catch((err) => done(err));
    });

    papaStream.on("finish", () => {
      finishedReading = true;
      processing.then(() => done()).catch((err) => done(err));
    });

    papaStream.on("error", (err) => done(err));
    fileStream.on("error", (err) => done(err));

    fileStream.pipe(papaStream);
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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const cutoff = cutoffDate(YEARS_BACK);

async function run() {
  console.log(
    `Importing invoices with InvoiceDate >= ${cutoff.toLocaleDateString()} (YEARS_BACK=${YEARS_BACK})`
  );

  const inRangeInvoiceNos = new Set();
  const headerFreight = new Map();
  const headerDiscount = new Map();

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

  if (headerBatchCount > 0) {
    await commitWithRetry(headerBatch);
  }

  console.log(`Headers done. Written: ${headersWritten.toLocaleString()}`);
  console.log("Streaming lines:", CSV_HD_PATH);

  const merchTotals = new Map();
  const seenLineKeys = new Set();

  let lineBatch = db.batch();
  let lineBatchCount = 0;
  let linesWritten = 0;
  let duplicateLinesSkipped = 0;

  await streamParseCsv(
    CSV_HD_PATH,
    async (r, rowIndex) => {
      const invoiceNo = cleanStr(ciGet(r, "InvoiceNo"));
      if (!invoiceNo || !inRangeInvoiceNos.has(invoiceNo)) return false;

      if (!cleanStr(ciGet(r, "ItemCode")) && !cleanStr(ciGet(r, "ItemCodeDesc"))) {
        return false;
      }

      const docId = normalizeDocId(invoiceNo);
      const lineId = makeLineId(invoiceNo, r);
      const dedupeKey = `${docId}|${lineId}`;

      if (seenLineKeys.has(dedupeKey)) {
        duplicateLinesSkipped++;
        return false;
      }
      seenLineKeys.add(dedupeKey);

      const ref = db.collection("invoices").doc(docId).collection("lines").doc(lineId);

      const extensionAmt = parseNumber(ciGet(r, "ExtensionAmt"));
      const unitPrice = parseNumber(ciGet(r, "UnitPrice"));

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
        process.stdout.write(
          `Committed lines... ${linesWritten.toLocaleString()} (dupSkipped ${duplicateLinesSkipped.toLocaleString()})\r`
        );
      }

      return true;
    },
    "Lines"
  );

  if (lineBatchCount > 0) {
    await commitWithRetry(lineBatch);
  }

  console.log(`Lines done. Written: ${linesWritten.toLocaleString()}`);
  console.log(`Duplicate logical lines skipped: ${duplicateLinesSkipped.toLocaleString()}`);
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
      process.stdout.write(
        `Committed computed totals... ${totalsUpdated.toLocaleString()}\r`
      );
    }
  }

  if (totalsBatchCount > 0) {
    await commitWithRetry(totalsBatch);
  }

  console.log(`\nComputed totals updated for ${totalsUpdated.toLocaleString()} invoices.`);
  console.log("DONE.");
}

run().catch((err) => {
  console.error("IMPORT FAILED:", err);
  process.exit(1);
});