import admin from "firebase-admin";
import fs from "fs";

const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function initFirebase() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function nowRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function mapToCategory(tags = {}) {
  const shop = tags.shop || "";
  const amenity = tags.amenity || "";

  if (shop === "convenience") return "convenience_store";
  if (amenity === "fuel") return "gas_station";
  if (shop === "supermarket") return "grocery_store";
  if (shop === "hardware") return "hardware_store";
  if (shop === "alcohol") return "liquor_store";
  if (shop === "tobacco" || shop === "vape") return "smoke_shop";

  if (shop) return `shop:${shop}`;
  if (amenity) return `amenity:${amenity}`;
  return "other";
}

function milesToMeters(mi) {
  return Math.round(Number(mi) * 1609.344);
}

async function postOverpass(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "ETProductsProspector/1.0",
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Overpass ${url} HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  return res.json();
}

async function overpass(query) {
  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      console.log("Trying Overpass:", url);
      return await postOverpass(url, query);
    } catch (e) {
      lastErr = e;
      console.log("  -> failed, trying next...");
    }
  }
  throw lastErr || new Error("All Overpass endpoints failed.");
}

async function main() {
  initFirebase();
  const db = admin.firestore();

  // Usage:
  // node pull_prospects_osm_city.mjs <lat> <lng> <radiusMiles> "CityLabel" "ST"
  const lat = Number(process.argv[2]);
  const lng = Number(process.argv[3]);
  const radiusMiles = Number(process.argv[4]);
  const cityLabel = cleanStr(process.argv[5] || "");
  const state = cleanStr(process.argv[6] || "").toUpperCase();

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMiles) || !cityLabel || !state) {
    console.log('Usage: node pull_prospects_osm_city.mjs <lat> <lng> <radiusMiles> "CityLabel" "ST"');
    console.log('Example: node pull_prospects_osm_city.mjs 41.873618 -94.677667 6 "Coon Rapids" "IA"');
    process.exit(1);
  }

  const radiusMeters = milesToMeters(radiusMiles);
  const sourceRunId = nowRunId();

  console.log(
    `Pulling OSM prospects around (${lat}, ${lng}) radius ${radiusMiles}mi (${radiusMeters}m) for ${cityLabel}, ${state} (run ${sourceRunId})...`
  );

  const q = `
[out:json][timeout:90];
(
  node(around:${radiusMeters},${lat},${lng})["shop"="convenience"];
  way(around:${radiusMeters},${lat},${lng})["shop"="convenience"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="convenience"];

  node(around:${radiusMeters},${lat},${lng})["amenity"="fuel"];
  way(around:${radiusMeters},${lat},${lng})["amenity"="fuel"];
  relation(around:${radiusMeters},${lat},${lng})["amenity"="fuel"];

  node(around:${radiusMeters},${lat},${lng})["shop"="supermarket"];
  way(around:${radiusMeters},${lat},${lng})["shop"="supermarket"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="supermarket"];

  node(around:${radiusMeters},${lat},${lng})["shop"="hardware"];
  way(around:${radiusMeters},${lat},${lng})["shop"="hardware"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="hardware"];

  node(around:${radiusMeters},${lat},${lng})["shop"="alcohol"];
  way(around:${radiusMeters},${lat},${lng})["shop"="alcohol"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="alcohol"];

  node(around:${radiusMeters},${lat},${lng})["shop"="tobacco"];
  way(around:${radiusMeters},${lat},${lng})["shop"="tobacco"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="tobacco"];

  node(around:${radiusMeters},${lat},${lng})["shop"="vape"];
  way(around:${radiusMeters},${lat},${lng})["shop"="vape"];
  relation(around:${radiusMeters},${lat},${lng})["shop"="vape"];
);
out center tags;
`;

  const data = await overpass(q);
  const elements = data?.elements || [];
  console.log("OSM elements:", elements.length);

  if (!elements.length) {
    console.log("⚠️ No results. Try increasing radiusMiles (e.g. 8 or 10).");
    return;
  }

  const col = db.collection("prospects_raw");
  let written = 0;
  let batch = db.batch();

  for (const el of elements) {
    const tags = el.tags || {};
    const name = cleanStr(tags.name) || "(unnamed)";
    const category = mapToCategory(tags);

    const elLat = el.lat ?? el.center?.lat ?? null;
    const elLng = el.lon ?? el.center?.lon ?? null;

    const address1 = cleanStr(tags["addr:housenumber"])
      ? `${cleanStr(tags["addr:housenumber"])} ${cleanStr(tags["addr:street"])}`
      : cleanStr(tags["addr:street"]);

    const zip = cleanStr(tags["addr:postcode"]);
    const phone = cleanStr(tags.phone || tags["contact:phone"]);
    const website = cleanStr(tags.website || tags["contact:website"]);
    const hoursText = cleanStr(tags.opening_hours);

    const placeId = `osm:${el.type}/${el.id}`;
    const docId = `osm_${el.type}_${el.id}`;

    batch.set(
      col.doc(docId),
      {
        source: "osm_overpass",
        sourceRunId,
        placeId,
        name,
        address1,
        city: cityLabel,
        state,
        zip,
        phone,
        website,
        lat: elLat,
        lng: elLng,
        categories: [category],
        rating: null,
        reviews: null,
        hoursText,
        // helpful for debugging/verification
        queryCenterLat: lat,
        queryCenterLng: lng,
        queryRadiusMiles: radiusMiles,
        ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    written++;
    if (written % 450 === 0) {
      await batch.commit();
      console.log("Committed batch at", written);
      batch = db.batch();
    }
  }

  await batch.commit();

  console.log(`✅ Wrote/updated ${written} prospects_raw docs (sourceRunId=${sourceRunId}).`);
  console.log("Next: run node process_prospects_raw.mjs to dedupe + filter + promote.");
}

main().catch((err) => {
  console.error("❌ Failed:", err?.message || err);
  process.exit(1);
});