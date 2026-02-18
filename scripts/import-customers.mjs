import fs from "fs";
import admin from "firebase-admin";
import Papa from "papaparse";

const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const CSV_PATH = "C:\\sageexports\\customers.csv";

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeDocId(customerNo) {
  // Firestore doc IDs cannot contain forward slashes.
  return cleanStr(customerNo).replaceAll("/", "-");
}

// --- Helpers for Carvana-style filters ---
function parseUSDate(mmddyyyy) {
  const s = cleanStr(mmddyyyy);
  // expected: MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !day || !year) return null;
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysAgoFrom(dateObj) {
  if (!dateObj) return null;
  const now = new Date();
  // Normalize to local midnight to avoid off-by-one from time-of-day
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()).getTime();
  const diffMs = a - b;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / 86400000);
}

function activityBucket(daysAgo) {
  if (daysAgo === null || daysAgo === undefined) return "unknown";
  if (daysAgo < 60) return "lt60";
  if (daysAgo <= 120) return "60_120";
  return "gt120";
}

function toBoolFromYN(v) {
  const s = cleanStr(v).toUpperCase();
  return s === "Y" || s === "YES" || s === "TRUE" || s === "T" || s === "1";
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isResourceExhausted(err) {
  const msg = String(err?.message || "");
  const code = String(err?.code || "");
  return (
    code.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.toLowerCase().includes("quota exceeded")
  );
}

async function commitWithRetry(batch, attempt = 1) {
  try {
    await batch.commit();
  } catch (e) {
    if (!isResourceExhausted(e) || attempt >= 8) throw e;

    const backoff = Math.min(60000, 1000 * Math.pow(2, attempt)); // up to 60s
    console.log(
      `Throttled (attempt ${attempt}). Waiting ${Math.round(
        backoff / 1000
      )}s then retrying...`
    );
    await sleep(backoff);
    return commitWithRetry(batch, attempt + 1);
  }
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const csvText = fs.readFileSync(CSV_PATH, "utf8");

// Tolerant CSV parse (keeps going and reports issues)
const parsed = Papa.parse(csvText, {
  header: true,
  skipEmptyLines: true,
});

if (parsed.errors?.length) {
  console.log("CSV parse warnings/errors (showing up to 10):");
  parsed.errors.slice(0, 10).forEach((e) => console.log(e));
}

const records = parsed.data;
console.log(`Loaded ${records.length} customer rows from CSV.`);

let batch = db.batch();
let batchCount = 0;
let totalWritten = 0;

for (const row of records) {
  const customerNo = cleanStr(row.CustomerNo);
  if (!customerNo) continue;

  const customerName = cleanStr(row.CustomerName);
  const state = cleanStr(row.State);
  const creditHold = cleanStr(row.CreditHold);
  const dateLastActivityStr = cleanStr(row.DateLastActivity);
  const lastActivityDate = parseUSDate(dateLastActivityStr);
  const lastActivityDaysAgo = daysAgoFrom(lastActivityDate);

  const docId = normalizeDocId(customerNo);
  const ref = db.collection("customers").doc(docId);

  const data = {
    customerNo,
    customerName,
    customerNameLower: customerName.toLowerCase(),
    address1: cleanStr(row.AddressLine1),
    city: cleanStr(row.City),
    state,
    stateUpper: state.toUpperCase(),
    zip: cleanStr(row.ZipCode),
    phone: cleanStr(row.TelephoneNo),
    email: cleanStr(row.EmailAddress),
    salespersonNo: cleanStr(row.SalespersonNo),
    status: cleanStr(row.CustomerStatus),
    creditHold,
    creditHoldBool: toBoolFromYN(creditHold),
    dateLastActivity: dateLastActivityStr,
    lastActivityTs: lastActivityDate
      ? admin.firestore.Timestamp.fromDate(lastActivityDate)
      : null,
    lastActivityDaysAgo: lastActivityDaysAgo ?? null,
    lastActivityBucket: activityBucket(lastActivityDaysAgo),

    // Optional fields (only present if exported)
    udf250Totalsales: cleanStr(row["UDF_25TOTALSALES"] ?? row["UDF_25TOTALSALES\r"]),
    udfEtNonRental: cleanStr(row.UDF_ET_NON_RENTAL),
    currentBalance: cleanStr(row.CurrentBalance),
    agingCategory1: cleanStr(row.AgingCategory1),
    agingCategory2: cleanStr(row.AgingCategory2),
    agingCategory3: cleanStr(row.AgingCategory3),
    agingCategory4: cleanStr(row.AgingCategory4),

    updatedAt: new Date().toISOString(),
    source: "sage_csv",
  };

  batch.set(ref, data, { merge: true });
  batchCount++;
  totalWritten++;

  // Use small batches + pacing to avoid throttling
  if (batchCount === 100) {
    console.log(`Committing... total queued so far: ${totalWritten}`);
    await commitWithRetry(batch);
    console.log(`Committed ${totalWritten} so far ✅`);
    batch = db.batch();
    batchCount = 0;

    // small pause to reduce quota pressure
    await sleep(300);
  }
}

if (batchCount > 0) {
  console.log(`Final commit... total queued: ${totalWritten}`);
  await commitWithRetry(batch);
}

console.log(`Done. Upserted ${totalWritten} customers into Firestore.`);
