import admin from "firebase-admin";
import fs from "fs";

const SERVICE_ACCOUNT_PATH = "C:\\SageExports\\serviceAccountKey.json";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"))
    ),
  });
}

const db = admin.firestore();

const WRITE_BATCH_SIZE = 250;
const PROGRESS_EVERY = 5000;

function clean(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return clean(v).toUpperCase();
}

function normalizeAddress(address1, city, state, zip) {
  return [upper(address1), upper(city), upper(state), clean(zip)]
    .filter(Boolean)
    .join("|");
}

function normalizeName(name) {
  return upper(name).replace(/\s+/g, " ").trim();
}

function isBadName(name) {
  const n = upper(name);
  return (
    !n ||
    n === "(UNNAMED)" ||
    n === "UNNAMED" ||
    n === "UNKNOWN" ||
    n === "UNKNOWN PROSPECT"
  );
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = clean(v);
    if (s) return s;
  }
  return "";
}

function getProspectDisplayName(p) {
  return firstNonEmpty(
    !isBadName(p.name) ? p.name : "",
    p.brand,
    p.operator,
    p.shop,
    p.store,
    p.amenity,
    p.tourism,
    p.leisure,
    p.building,
    p.display_name,
    p.address1,
    [clean(p.city), clean(p.state)].filter(Boolean).join(", "),
    "Unknown Prospect"
  );
}

function hasRealBusinessSignal(p) {
  return Boolean(
    firstNonEmpty(
      !isBadName(p.name) ? p.name : "",
      p.brand,
      p.operator,
      p.shop,
      p.store,
      p.amenity,
      p.tourism,
      p.leisure
    )
  );
}

function isValidCoord(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeDocData(id, raw) {
  const lat =
    typeof raw.lat === "number"
      ? raw.lat
      : typeof raw.latitude === "number"
      ? raw.latitude
      : null;

  const lng =
    typeof raw.lng === "number"
      ? raw.lng
      : typeof raw.lon === "number"
      ? raw.lon
      : typeof raw.longitude === "number"
      ? raw.longitude
      : null;

  const address1 = firstNonEmpty(
    raw.address1,
    raw.address,
    raw.street,
    raw["addr:street"]
  );

  const city = firstNonEmpty(raw.city, raw["addr:city"], raw.cityLabel);
  const state = firstNonEmpty(raw.state, raw["addr:state"], raw.stateLabel);
  const zip = firstNonEmpty(raw.zip, raw.zipCode, raw.postcode, raw["addr:postcode"]);

  const normalized = {
    id,
    sourceRunId: clean(raw.sourceRunId),
    sourceHubId: clean(raw.sourceHubId),
    sourceHubName: clean(raw.sourceHubName),
    osmType: clean(raw.osmType || raw.type),
    osmId: clean(raw.osmId || raw.id),
    name: clean(raw.name),
    brand: clean(raw.brand),
    operator: clean(raw.operator),
    shop: clean(raw.shop),
    store: clean(raw.store),
    amenity: clean(raw.amenity),
    tourism: clean(raw.tourism),
    leisure: clean(raw.leisure),
    building: clean(raw.building),
    display_name: clean(raw.display_name),
    address1,
    city,
    state,
    zip,
    phone: clean(raw.phone),
    website: clean(raw.website),
    lat,
    lng,
    cityState: [clean(city), clean(state)].filter(Boolean).join(", "),
    prospectName: "",
  };

  normalized.prospectName = getProspectDisplayName(normalized);
  return normalized;
}

async function loadExistingCustomers() {
  console.log("Loading customers...");
  const snap = await db.collection("customers").get();

  const byAddress = new Set();
  const byNameCity = new Set();

  snap.forEach((doc) => {
    const d = doc.data() || {};

    const addressKey = normalizeAddress(d.address1, d.city, d.state, d.zip || d.zipCode);
    if (addressKey) byAddress.add(addressKey);

    const nameKey = `${normalizeName(d.customerName)}|${upper(d.city)}|${upper(d.state)}`;
    if (nameKey !== "||") byNameCity.add(nameKey);
  });

  console.log(`Loaded ${snap.size} customers`);
  return { byAddress, byNameCity };
}

function getRejectReason(p, existingCustomers) {
  if (!isValidCoord(p.lat) || !isValidCoord(p.lng)) {
    return "invalid_coords";
  }

  if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    return "invalid_coords_range";
  }

  const addressKey = normalizeAddress(p.address1, p.city, p.state, p.zip);
  const nameCityKey = `${normalizeName(p.prospectName)}|${upper(p.city)}|${upper(p.state)}`;

  if (addressKey && existingCustomers.byAddress.has(addressKey)) {
    return "already_customer_address";
  }

  if (
    normalizeName(p.prospectName) &&
    upper(p.city) &&
    existingCustomers.byNameCity.has(nameCityKey)
  ) {
    return "already_customer_name_city";
  }

  if (!hasRealBusinessSignal(p)) {
    if (!p.address1 && !p.phone && !p.website) {
      return "too_sparse";
    }
  }

  if (
    !hasRealBusinessSignal(p) &&
    p.prospectName === [clean(p.city), clean(p.state)].filter(Boolean).join(", ")
  ) {
    return "generic_city_state";
  }

  if (
    !hasRealBusinessSignal(p) &&
    !p.address1 &&
    !p.phone &&
    !p.website &&
    !p.zip
  ) {
    return "junk_generic";
  }

  return "";
}

async function commitOps(ops) {
  if (!ops.length) return;

  let batch = db.batch();
  let inBatch = 0;

  for (const op of ops) {
    if (op.type === "set") {
      batch.set(op.ref, op.data, { merge: false });
    } else if (op.type === "delete") {
      batch.delete(op.ref);
    }

    inBatch++;

    if (inBatch >= WRITE_BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) {
    await batch.commit();
  }
}

async function main() {
  const existingCustomers = await loadExistingCustomers();

  const rawSnap = await db.collection("prospects_raw").get();
  console.log(`Processing ${rawSnap.size} prospects_raw`);

  let processed = 0;
  let accepted = 0;
  let rejected = 0;
  let ops = [];

  for (const doc of rawSnap.docs) {
    const raw = doc.data() || {};
    const p = normalizeDocData(doc.id, raw);

    const rejectReason = getRejectReason(p, existingCustomers);

    if (rejectReason) {
      rejected++;

      ops.push({
        type: "set",
        ref: db.collection("prospects_rejected").doc(doc.id),
        data: {
          ...raw,
          normalizedName: p.prospectName,
          address1: p.address1,
          city: p.city,
          state: p.state,
          zip: p.zip,
          lat: p.lat,
          lng: p.lng,
          rejectReason,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      ops.push({
        type: "delete",
        ref: db.collection("prospects").doc(doc.id),
      });
    } else {
      accepted++;

      ops.push({
        type: "set",
        ref: db.collection("prospects").doc(doc.id),
        data: {
          ...raw,
          name: p.name,
          brand: p.brand,
          operator: p.operator,
          shop: p.shop,
          store: p.store,
          amenity: p.amenity,
          tourism: p.tourism,
          leisure: p.leisure,
          building: p.building,
          display_name: p.display_name,
          address1: p.address1,
          city: p.city,
          state: p.state,
          zip: p.zip,
          phone: p.phone,
          website: p.website,
          lat: p.lat,
          lng: p.lng,
          prospectName: p.prospectName,
          sourceRunId: p.sourceRunId,
          sourceHubId: p.sourceHubId,
          sourceHubName: p.sourceHubName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      ops.push({
        type: "delete",
        ref: db.collection("prospects_rejected").doc(doc.id),
      });
    }

    processed++;

    if (ops.length >= WRITE_BATCH_SIZE) {
      await commitOps(ops);
      ops = [];
    }

    if (processed % PROGRESS_EVERY === 0) {
      console.log(
        `Processed ${processed}/${rawSnap.size} | Accepted ${accepted} | Rejected ${rejected}`
      );
    }
  }

  if (ops.length) {
    await commitOps(ops);
  }

  console.log("====================================");
  console.log(`Processed: ${processed}`);
  console.log(`Accepted:  ${accepted}`);
  console.log(`Rejected:  ${rejected}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});