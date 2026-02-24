import fs from "fs";
import admin from "firebase-admin";
import Papa from "papaparse";

// ---- PATHS (edit these) ----
const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const CUSTOMERS_CSV_PATH = "C:\\sageexports\\customers.csv";
const CONTACTS_CSV_PATH = "C:\\sageexports\\customer_contacts.csv";

// ---- CONFIG ----
// Contact codes we consider "buyer".
const BUYER_CODE = "BUYER";
const BUYER2_CODES = new Set(["BUYER 2", "BUYER2"]);

// If you want a fallback when no BUYER/BUYER2 exists, set this true and define fallback codes.
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

function normalizeContactCode(v) {
  // Trim + collapse multiple spaces + uppercase
  return cleanStr(v).replace(/\s+/g, " ").toUpperCase();
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
    if (
      attempt <= 5 &&
      (msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("DEADLINE_EXCEEDED") ||
        msg.includes("ABORTED"))
    ) {
      const waitMs = 500 * attempt * attempt;
      console.log(`Retrying batch commit in ${waitMs}ms (attempt ${attempt})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return commitWithRetry(batch, attempt + 1);
    }
    throw e;
  }
}

function buildBuyerEmailsByCustomerNo(contactsRows) {
  // contactsRows expected columns:
  // CustomerNo, ContactCode, ContactName, EmailAddress
  //
  // Returns Map(customerNo -> { buyerEmail, buyer2Email })
  const map = new Map();

  const ensure = (customerNo) => {
    if (!map.has(customerNo)) map.set(customerNo, { buyerEmail: "", buyer2Email: "" });
    return map.get(customerNo);
  };

  for (const r of contactsRows) {
    const customerNo = cleanStr(r.CustomerNo);
    const contactCode = normalizeContactCode(r.ContactCode);
    const email = cleanStr(r.EmailAddress);

    if (!customerNo || !email) continue;

    if (contactCode === BUYER_CODE) {
      const obj = ensure(customerNo);
      // keep first BUYER email found
      if (!obj.buyerEmail) obj.buyerEmail = email;
      continue;
    }

    if (BUYER2_CODES.has(contactCode)) {
      const obj = ensure(customerNo);
      // keep first BUYER 2 email found
      if (!obj.buyer2Email) obj.buyer2Email = email;
      continue;
    }
  }

  if (!ALLOW_FALLBACK_EMAIL) return map;

  // Optional fallback logic if you ever want it later
  for (const r of contactsRows) {
    const customerNo = cleanStr(r.CustomerNo);
    const contactCode = normalizeContactCode(r.ContactCode);
    const email = cleanStr(r.EmailAddress);

    if (!customerNo || !email) continue;

    const obj = ensure(customerNo);
    if (!obj.buyerEmail && !obj.buyer2Email && FALLBACK_CONTACT_CODES.has(contactCode)) {
      obj.buyerEmail = email;
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
  const buyerEmailsByCustomerNo = buildBuyerEmailsByCustomerNo(contactsRows);

  // counts
  let countBuyer = 0;
  let countBuyer2 = 0;
  for (const [, v] of buyerEmailsByCustomerNo) {
    if (v.buyerEmail) countBuyer++;
    if (v.buyer2Email) countBuyer2++;
  }
  console.log(`BUYER emails found for ${countBuyer} customers`);
  console.log(`BUYER 2 emails found for ${countBuyer2} customers`);

  console.log("Reading customers CSV...");
  const customerRows = readCsv(CUSTOMERS_CSV_PATH);
  console.log(`Customers rows: ${customerRows.length}`);

  // --- Write customers ---
  const batches = chunk(customerRows, 450);
  let totalWritten = 0;

  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const batch = db.batch();

    for (const r of batchRows) {
      const customerNo = cleanStr(r.CustomerNo);
      if (!customerNo) continue;

      const docId = normalizeDocId(customerNo);
      const ref = db.collection("customers").doc(docId);

      const emails = buyerEmailsByCustomerNo.get(customerNo) || { buyerEmail: "", buyer2Email: "" };

      const payload = {
        customerNo,
        customerName: cleanStr(r.CustomerName),
        addressLine1: cleanStr(r.AddressLine1),
        city: cleanStr(r.City),
        state: cleanStr(r.State),
        zipCode: cleanStr(r.ZipCode),
        telephoneNo: cleanStr(r.TelephoneNo),

        salespersonNo: cleanStr(r.SalespersonNo),
        salespersonNo2: cleanStr(r.SalespersonNo2),

        customerStatus: cleanStr(r.CustomerStatus),
        creditHold: cleanStr(r.CreditHold),
        dateLastActivity: cleanStr(r.DateLastActivity),

        udf_25TotalSales: cleanStr(r.UDF_25TOTALSALES),
        udfEtNonRentalAvg25: cleanStr(r.UDF_ET_NON_RENTAL_WEEK_AVG_25),

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Save both if present.
      // Also: if BUYER is missing but BUYER 2 exists, we still populate buyerEmail
      // so your UI (which likely reads buyerEmail) will show an address.
      if (emails.buyerEmail) payload.buyerEmail = emails.buyerEmail;
      if (emails.buyer2Email) payload.buyer2Email = emails.buyer2Email;
      if (!emails.buyerEmail && emails.buyer2Email) payload.buyerEmail = emails.buyer2Email;

      batch.set(ref, payload, { merge: true });
      totalWritten++;
    }

    console.log(`Committing batch ${i + 1}/${batches.length}...`);
    await commitWithRetry(batch);
  }

  console.log(`✅ Done. Customer docs written/updated: ${totalWritten}`);
  console.log(`✅ buyerEmail (BUYER, or BUYER 2 fallback) applied for ${countBuyer + (countBuyer2 - 0)} customers (see counts above)`);
  console.log(`✅ buyer2Email applied for ${countBuyer2} customers`);
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err);
  process.exit(1);
});
