/**
 * Weekly job: compute Top 5 company item codes sold in last 60 days
 * + EXCLUDES itemCode "170"
 * + Optionally enriches description from items collection
 *
 * Output: companyStats/topItems_60d
 */

import admin from "firebase-admin";
import fs from "fs";

const SERVICE_ACCOUNT_PATH =
  process.env.SA_PATH || "C:\\sageexports\\serviceAccountKey.json";

function initAdmin() {
  if (admin.apps.length) return;

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return;
  }

  const raw = fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const CONFIG = {
  INVOICES_COLLECTION: "invoices",
  INVOICE_DATE_FIELD: "invoiceDate", // Timestamp
  LINES_SUBCOLLECTION: "lines",

  // OPTIONAL item master lookup (set to "" to disable)
  ITEMS_COLLECTION: "items", // <-- change if your item master collection is named differently
  ITEM_DESC_FIELD: "itemCodeDesc", // <-- change if your item master field name differs

  ITEM_FIELDS: ["itemCode", "itemNo", "item", "ItemCode", "ItemNo"],
  DESC_FIELDS: ["itemCodeDesc", "ItemCodeDesc", "raw.itemCodeDesc", "raw.ItemCodeDesc"],

  QTY_FIELDS: [
    "qtyShipped",
    "qty",
    "quantity",
    "QtyShipped",
    "Qty",
    "quantityShipped",
    "QuantityShipped",
    "Qty_Shipped",
    "QuantityOrdered",
    "QtyOrdered",
    "raw.QuantityShipped",
    "raw.QtyShipped",
    "raw.Qty",
    "raw.QuantityOrdered",
    "raw.QtyOrdered",
  ],

  SALES_FIELDS: [
    "extSales",
    "extension",
    "lineTotal",
    "extendedPrice",
    "amount",
    "ExtSales",
    "ExtensionAmt",
    "Extension",
    "ExtAmt",
    "LineAmt",
    "raw.ExtensionAmt",
    "raw.Extension",
    "raw.ExtAmt",
    "raw.LineAmt",
  ],
};

const DAYS_BACK = 60;
const TOP_N = 5;

// tuning
const INVOICE_PAGE_SIZE = 500;
const MAX_INVOICES = 25000; // safety cap

// always exclude these item codes
const EXCLUDE_CODES = new Set(["170"]);

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/[$,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItem(v) {
  return String(v ?? "").trim().toUpperCase();
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (k.includes(".")) {
      const [a, b] = k.split(".");
      const v = obj?.[a]?.[b];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      continue;
    }

    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;

    const vr = obj?.raw?.[k];
    if (vr !== undefined && vr !== null && String(vr).trim() !== "") return vr;
  }
  return undefined;
}

async function getDescriptions(db, itemCodes) {
  if (!CONFIG.ITEMS_COLLECTION) return new Map();
  const out = new Map();

  // Best effort: 1 read per item code (only TOP 5)
  for (const code of itemCodes) {
    try {
      const snap = await db.collection(CONFIG.ITEMS_COLLECTION).doc(code).get();
      if (!snap.exists) continue;
      const v = snap.data() || {};
      const desc = v?.[CONFIG.ITEM_DESC_FIELD];
      if (desc && String(desc).trim()) out.set(code, String(desc).trim());
    } catch {
      // ignore lookup failures
    }
  }
  return out;
}

async function main() {
  initAdmin();
  const db = admin.firestore();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_BACK);
  const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

  console.log(
    `Computing Top ${TOP_N} items (last ${DAYS_BACK} days) since ${cutoff.toISOString()}`
  );

  const invRef = db.collection(CONFIG.INVOICES_COLLECTION);

  let last = null;
  let scannedInvoices = 0;

 const map = new Map(); // itemCode -> {qty, sales, lines, description}

  while (scannedInvoices < MAX_INVOICES) {
    let q = invRef
      .where(CONFIG.INVOICE_DATE_FIELD, ">=", cutoffTs)
      .orderBy(CONFIG.INVOICE_DATE_FIELD, "desc")
      .limit(INVOICE_PAGE_SIZE);

    if (last) q = q.startAfter(last);

    const invSnap = await q.get();
    if (invSnap.empty) break;

    for (const invDoc of invSnap.docs) {
      scannedInvoices += 1;

      const linesSnap = await invDoc.ref
        .collection(CONFIG.LINES_SUBCOLLECTION)
        .get();

      for (const lineDoc of linesSnap.docs) {
        const x = lineDoc.data();

        const code = normalizeItem(pickFirst(x, CONFIG.ITEM_FIELDS));
if (!code) continue;
if (EXCLUDE_CODES.has(code)) continue;

const desc = String(pickFirst(x, CONFIG.DESC_FIELDS) ?? "").trim();

const qty = toNumber(pickFirst(x, CONFIG.QTY_FIELDS));
const sales = toNumber(pickFirst(x, CONFIG.SALES_FIELDS));

const prev = map.get(code) || { qty: 0, sales: 0, lines: 0, description: "" };

map.set(code, {
  qty: prev.qty + qty,
  sales: prev.sales + sales,
  lines: prev.lines + 1,
  // keep the first non-empty description we ever see for that code
  description: prev.description || desc,
});

      }

      if (scannedInvoices >= MAX_INVOICES) break;
    }

    if (invSnap.docs.length < INVOICE_PAGE_SIZE) break;
    last = invSnap.docs[invSnap.docs.length - 1];

    if (scannedInvoices % 2000 === 0) {
      console.log(`Scanned invoices: ${scannedInvoices}`);
    }
  }

  const arr = Array.from(map.entries()).map(([itemCode, v]) => ({
  itemCode,
  qty: v.qty,
  sales: v.sales,
  lines: v.lines,
  description: v.description || "",
}));


  const hasSales = arr.some((x) => x.sales > 0);
  const hasQty = arr.some((x) => x.qty > 0);

  arr.sort((a, b) => {
    if (hasSales) return b.sales - a.sales;
    if (hasQty) return b.qty - a.qty;
    return b.lines - a.lines;
  });

  function startsWithCasey(desc) {
  return String(desc ?? "").trim().toLowerCase().startsWith("casey");
}

const topCodes = arr.slice(0, TOP_N * 3);

const top = topCodes
  .filter((x) => !EXCLUDE_CODES.has(x.itemCode))
  .filter((x) => !startsWithCasey(x.description))
  .slice(0, TOP_N);


  const metric = hasSales ? "sales" : hasQty ? "qty" : "lines";

  const topWithDesc = top;


  console.log("Top items:", topWithDesc);

  await db.collection("companyStats").doc("topItems_60d").set(
    {
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
      daysBack: DAYS_BACK,
      topN: TOP_N,
      scannedInvoices,
      metric,
      excludedCodes: Array.from(EXCLUDE_CODES),
      items: topWithDesc,
    },
    { merge: true }
  );

  console.log(`✅ Wrote companyStats/topItems_60d (metric=${metric})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
