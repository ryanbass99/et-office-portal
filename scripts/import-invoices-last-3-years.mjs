/**
 * FIXED VERSION — ALWAYS IMPORTS LINES
 * - Removes dependency on header timing
 * - Ensures invoice exists before writing lines
 * - Safe to rerun (no duplicates)
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

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseNumber(v) {
  const s = cleanStr(v).replaceAll(",", "").replaceAll("$", "");
  const n = Number(s.replace(/[()\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeDocId(raw) {
  return cleanStr(raw).replaceAll("/", "-");
}

function ciGet(row, key) {
  if (key in row) return row[key];
  const lk = key.toLowerCase();
  const found = Object.keys(row).find((k) => k.toLowerCase() === lk);
  return found ? row[found] : undefined;
}

function stableHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function makeLineId(invoiceNo, r) {
  const signature = [
    invoiceNo,
    cleanStr(ciGet(r, "ItemCode")),
    parseNumber(ciGet(r, "ExtensionAmt")),
  ].join("|");

  return `${invoiceNo}__${stableHash(signature)}`;
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function run() {
  console.log("IMPORT STARTED");

  const lines = Papa.parse(fs.readFileSync(CSV_HD_PATH, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data;

  let batch = db.batch();
  let count = 0;

  for (const r of lines) {
    const invoiceNo = cleanStr(ciGet(r, "InvoiceNo"));
    if (!invoiceNo) continue;

    const docId = normalizeDocId(invoiceNo);
    const invoiceRef = db.collection("invoices").doc(docId);

    // ENSURE INVOICE EXISTS
    batch.set(invoiceRef, { invoiceNo }, { merge: true });

    if (!cleanStr(ciGet(r, "ItemCode"))) continue;

    const lineId = makeLineId(invoiceNo, r);

    const lineRef = invoiceRef.collection("lines").doc(lineId);

    batch.set(lineRef, {
      invoiceNo,
      itemCode: cleanStr(ciGet(r, "ItemCode")),
      description: cleanStr(ciGet(r, "ItemCodeDesc")),
      qty: parseNumber(ciGet(r, "QuantityShipped")),
      unitPrice: parseNumber(ciGet(r, "UnitPrice")),
      ext: parseNumber(ciGet(r, "ExtensionAmt")),
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    count++;

    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
      console.log("Committed:", count);
    }
  }

  if (count % 400 !== 0) {
    await batch.commit();
  }

  console.log("DONE:", count);
}

run().catch(console.error);