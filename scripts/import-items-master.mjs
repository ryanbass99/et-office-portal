// import-items-master.mjs
// Usage:
//   node import-items-master.mjs
//
// Expects CSV at: C:\SageExports\Items.csv  (change below if needed)
//
// Requires env vars (same as your other scripts):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//
// Optional env vars:
//   FIRESTORE_ITEMS_COLLECTION  (default: itemsMaster)
//   ITEMS_CSV_PATH              (default: C:\SageExports\Items.csv)
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Papa from "papaparse";
import admin from "firebase-admin";

// Load env vars for standalone scripts (Next.js loads .env.local automatically, Node does not)
// Try project root first, then parent of /scripts
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env.local") });

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeStr(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return normalizeStr(v).toUpperCase();
}

// Build prefixes for partial search.
// Example word "POKEMON" => ["PO","POK","POKE","POKEM",...]
// We cap to keep Firestore doc size reasonable.
function buildSearchPrefixes(desc) {
  const s = upper(desc);
  const words = s.split(/[^A-Z0-9]+/g).filter(Boolean);

  const prefixes = new Set();
  for (const w of words) {
    const maxLen = Math.min(w.length, 12); // cap to 12 chars
    for (let i = 2; i <= maxLen; i++) {
      prefixes.add(w.slice(0, i));
    }
  }
  return Array.from(prefixes);
}

function initAdmin() {
  if (admin.apps.length) return;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: mustEnv("FIREBASE_PROJECT_ID"),
      clientEmail: mustEnv("FIREBASE_CLIENT_EMAIL"),
      privateKey: mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    }),
  });
}

async function main() {
  initAdmin();
  const db = admin.firestore();

const csvPath =
  process.env.ITEMS_CSV_PATH || "\\\\ets02\\ETS02_SAGE\\SageExports\\Items.csv";
  const collectionName =
    process.env.FIRESTORE_ITEMS_COLLECTION || "itemsMaster";

  const allowedPL = new Set(["NOV", "FOOD", "EYE", "CELL"]);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const csvText = fs.readFileSync(csvPath, "utf8");

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors?.length) {
    console.log("CSV parse errors:", parsed.errors.slice(0, 5));
    // continue anyway
  }

  const rows = parsed.data || [];
  console.log(`Rows parsed: ${rows.length}`);

  let kept = 0;
  let skipped = 0;

  const colRef = db.collection(collectionName);

  // Firestore batch limit is 500 ops
  let batch = db.batch();
  let batchCount = 0;
  let written = 0;

  async function commitBatch() {
    if (batchCount === 0) return;
    await batch.commit();
    written += batchCount;
    console.log(`Committed ${batchCount} docs (total written: ${written})`);
    batch = db.batch();
    batchCount = 0;
  }

  for (const r of rows) {
    // Support either exact header names or variations
    const itemCode = normalizeStr(r.ItemCode ?? r.itemCode ?? r.ITEMCODE);
    const itemCodeDesc = normalizeStr(
      r.ItemCodeDesc ?? r.itemCodeDesc ?? r.ITEMCODEDESC
    );
    const productLine = upper(r.ProductLine ?? r.productLine ?? r.PRODUCTLINE);
    const inactiveItem = upper(
      r.InactiveItem ?? r.inactiveItem ?? r.INACTIVEITEM
    );
    const standardUnitPriceRaw =
      r.StandardUnitPrice ?? r.standardUnitPrice ?? r.STANDARDUNITPRICE;

    if (!itemCode) {
      skipped++;
      continue;
    }

    if (!allowedPL.has(productLine)) {
      skipped++;
      continue;
    }

    if (inactiveItem !== "N") {
      skipped++;
      continue;
    }

    // Parse price (optional)
    const standardUnitPrice = Number(standardUnitPriceRaw || 0);

    const docId = itemCode; // keep as-is (your codes include leading zeros for numeric items)
    const ref = colRef.doc(docId);

    const descUpper = upper(itemCodeDesc);
    const prefixes = buildSearchPrefixes(descUpper);

    const doc = {
      itemCode: itemCode,
      ItemCode: itemCode, // keep a Sage-like alias too
      itemCodeDesc: descUpper,
      ItemCodeDesc: descUpper,
      productLine,
      ProductLine: productLine,
      standardUnitPrice,
      StandardUnitPrice: standardUnitPrice,
      inactiveItem: inactiveItem,
      InactiveItem: inactiveItem,
      searchPrefixes: prefixes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: {
        file: path.basename(csvPath),
      },
    };

    batch.set(ref, doc, { merge: true });
    batchCount++;
    kept++;

    if (batchCount >= 450) {
      // commit a bit early to be safe
      await commitBatch();
    }
  }

  await commitBatch();

  console.log("DONE");
  console.log(`Kept: ${kept}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Collection: ${collectionName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});