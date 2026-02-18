import fs from "fs";
import admin from "firebase-admin";
import Papa from "papaparse";

// ---- PATHS (edit these) ----
const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const CUSTOMERS_CSV_PATH = "C:\\sageexports\\customers.csv";
const CONTACTS_CSV_PATH = "C:\\sageexports\\customer_contacts.csv";

// ---- CONFIG ----
// If your company uses different buyer contact codes, add them here.
const BUYER_CONTACT_CODES = new Set(["BUYER"]);

// If you want a fallback when no BUYER exists, set this true and define fallback codes.
// Example: AP, OWNER, PURCH, etc.
// For now, you asked "buyer only if buyer exists" -> keep false.
const ALLOW_FALLBACK_EMAIL = false;
const FALLBACK_CONTACT_CODES = new Set(["AP", "OWNER", "PURCH"]);

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeDocId(customerNo) {
  // Firestore doc IDs cannot contain forward slashes.
  return cleanStr(customerNo).replaceAll("/", "-");
}

function readCsv(path) {
  const csv = fs.readFileSync(path, "utf8");
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors?.length) {
    console.error("CSV parse errors:", parsed.errors.slice(0, 5));
  }
  return parsed.data;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function commitWithRetry(batch, attempt = 1) {
  try {
    await batch.commit();
  } catch (e) {
    const msg = String(e?.message || e);
    // Simple backoff for transient errors
    if (attempt <= 5 && (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("DEADLINE_EXCEEDED") || msg.includes("ABORTED"))) {
      const waitMs = 500 * attempt * attempt;
      console.log(`Retrying batch commit in ${waitMs}ms (attempt ${attempt})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return commitWithRetry(batch, attempt + 1);
    }
    throw e;
  }
}

function buildBuyerEmailMap(contactsRows) {
  // contactsRows expected columns (from your screenshot):
  // CustomerNo, ContactCode, ContactName, EmailAddress
  const map = new Map(); // customerNo -> buyerEmail

  for (const r of contactsRows) {
    const customerNo = cleanStr(r.CustomerNo);
    const contactCode = cleanStr(r.ContactCode).toUpperCase();
    const email = cleanStr(r.EmailAddress);

    if (!customerNo || !email) continue;

    // Prefer BUYER codes only
    if (BUYER_CONTACT_CODES.has(contactCode)) {
      // If multiple buyer rows exist, keep the first one we encounter
      if (!map.has(customerNo)) map.set(customerNo, email);
    }
  }

  if (!ALLOW_FALLBACK_EMAIL) return map;

  // Optional fallback logic if you ever want it later
  for (const r of contactsRows) {
    const customerNo = cleanStr(r.CustomerNo);
    const contactCode = cleanStr(r.ContactCode).toUpperCase();
    const email = cleanStr(r.EmailAddress);
    if (!customerNo || !email) continue;

    if (!map.has(customerNo) && FALLBACK_CONTACT_CODES.has(contactCode)) {
      map.set(customerNo, email);
    }
  }

  return map;
}

async function main() {
  // --- Firebase Admin init ---
  const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  const db = admin.firestore();

  console.log("Reading contacts CSV...");
  const contactsRows = readCsv(CONTACTS_CSV_PATH);
  const buyerEmailByCustomerNo = buildBuyerEmailMap(contactsRows);
  console.log(`Buyer emails found for ${buyerEmailByCustomerNo.size} customers`);

  console.log("Reading customers CSV...");
  const customerRows = readCsv(CUSTOMERS_CSV_PATH);
  console.log(`Customers rows: ${customerRows.length}`);

  // --- Write customers ---
  // Firestore batch limit = 500 operations per batch
  const batches = chunk(customerRows, 450); // keep a little buffer

  let totalWritten = 0;

  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const batch = db.batch();

    for (const r of batchRows) {
      const customerNo = cleanStr(r.CustomerNo);
      if (!customerNo) continue;

      const docId = normalizeDocId(customerNo);
      const ref = db.collection("customers").doc(docId);

      // pull buyerEmail if exists (buyer-only requirement)
      const buyerEmail = buyerEmailByCustomerNo.get(customerNo);

      // Build your customer doc payload.
      // Keep your existing fields; add SalespersonNo2 and buyerEmail (when present).
      const payload = {
        customerNo,
        customerName: cleanStr(r.CustomerName),
        addressLine1: cleanStr(r.AddressLine1),
        city: cleanStr(r.City),
        state: cleanStr(r.State),
        zipCode: cleanStr(r.ZipCode),
        telephoneNo: cleanStr(r.TelephoneNo),

        salespersonNo: cleanStr(r.SalespersonNo),
        salespersonNo2: cleanStr(r.SalespersonNo2), // ✅ you asked to include this

        customerStatus: cleanStr(r.CustomerStatus),
        creditHold: cleanStr(r.CreditHold),
        dateLastActivity: cleanStr(r.DateLastActivity),

        // If you have numeric fields in CSV, you can parse them here.
        // Leaving as strings is OK too if your UI expects that.
        udf_25TotalSales: cleanStr(r.UDF_25TOTALSALES),
        udfEtNonRentalAvg25: cleanStr(r.UDF_ET_NON_RENTAL_WEEK_AVG_25),

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Only set buyerEmail if buyer exists (per your request)
      if (buyerEmail) payload.buyerEmail = buyerEmail;

      batch.set(ref, payload, { merge: true });
      totalWritten++;
    }

    console.log(`Committing batch ${i + 1}/${batches.length}...`);
    await commitWithRetry(batch);
  }

  console.log(`✅ Done. Customer docs written/updated: ${totalWritten}`);
  console.log(`✅ buyerEmail applied to: ${buyerEmailByCustomerNo.size} customers (only when BUYER exists)`);
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err);
  process.exit(1);
});
