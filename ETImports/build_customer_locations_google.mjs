import "dotenv/config";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

const SERVICE_ACCOUNT_PATH =
  "C:\\sageexports\\serviceAccountKey.json";

if (!process.env.GOOGLE_GEOCODE_API_KEY) {
  throw new Error("Missing GOOGLE_GEOCODE_API_KEY in .env");
}

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  throw new Error(`Missing service account file at ${SERVICE_ACCOUNT_PATH}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const GOOGLE_KEY = process.env.GOOGLE_GEOCODE_API_KEY;

function clean(v) {
  return String(v ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAddress(c) {
  return [clean(c.address1), clean(c.city), clean(c.state), clean(c.zip)]
    .filter(Boolean)
    .join(", ");
}

async function geocodeAddress(address) {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) +
    "&key=" +
    encodeURIComponent(GOOGLE_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status === "OK" && data.results?.length) {
    const r = data.results[0];
    return {
      ok: true,
      status: data.status,
      formattedAddress: r.formatted_address || "",
      lat: r.geometry?.location?.lat ?? null,
      lng: r.geometry?.location?.lng ?? null,
    };
  }

  return {
    ok: false,
    status: data.status || "UNKNOWN",
    formattedAddress: "",
    lat: null,
    lng: null,
  };
}

async function main() {
  console.log("Loading customers...");

  const snap = await db.collection("customers").get();

  const rows = [];
  snap.forEach((doc) => {
    const c = doc.data() || {};

    const customerStatus = clean(c.customerStatus).toUpperCase();
    const salespersonNo = clean(c.salespersonNo);

    if (customerStatus !== "A") return;
    if (!salespersonNo) return;
    if (salespersonNo === "0001") return;

    const address = buildAddress(c);
    if (!address) return;

    rows.push({
      docId: doc.id,
      customerNo: clean(c.customerNo) || doc.id,
      customerName: clean(c.customerName),
      salespersonNo,
      address1: clean(c.address1),
      city: clean(c.city),
      state: clean(c.state),
      zip: clean(c.zip || c.zipCode),
      address,
    });
  });

  console.log(`Eligible active assigned customers: ${rows.length}`);

  let processed = 0;
  let success = 0;
  let failed = 0;

  for (const row of rows) {
    processed += 1;

    try {
      const geo = await geocodeAddress(row.address);

      await db.collection("customerLocations").doc(row.customerNo).set(
        {
          customerNo: row.customerNo,
          customerName: row.customerName,
          salespersonNo: row.salespersonNo,
          address1: row.address1,
          city: row.city,
          state: row.state,
          zip: row.zip,
          sourceAddress: row.address,
          lat: geo.lat,
          lng: geo.lng,
          formattedAddress: geo.formattedAddress,
          geocodeStatus: geo.status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (geo.ok && typeof geo.lat === "number" && typeof geo.lng === "number") {
        success += 1;
        console.log(
          `[${processed}/${rows.length}] OK   ${row.customerNo} ${row.customerName}`
        );
      } else {
        failed += 1;
        console.log(
          `[${processed}/${rows.length}] FAIL ${row.customerNo} ${row.customerName} (${geo.status})`
        );
      }
    } catch (err) {
      failed += 1;
      console.log(
        `[${processed}/${rows.length}] ERR  ${row.customerNo} ${row.customerName} :: ${err.message}`
      );

      await db.collection("customerLocations").doc(row.customerNo).set(
        {
          customerNo: row.customerNo,
          customerName: row.customerName,
          salespersonNo: row.salespersonNo,
          address1: row.address1,
          city: row.city,
          state: row.state,
          zip: row.zip,
          sourceAddress: row.address,
          lat: null,
          lng: null,
          formattedAddress: "",
          geocodeStatus: `ERROR: ${err.message}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await sleep(60);
  }

  console.log("====================================");
  console.log(`Processed: ${processed}`);
  console.log(`Success:   ${success}`);
  console.log(`Failed:    ${failed}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});