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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nowRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function milesToMeters(mi) {
  return Math.round(Number(mi) * 1609.344);
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

async function postOverpass(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "ETProductsProspector/1.0",
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Overpass ${url} HTTP ${res.status}: ${txt.slice(0, 250)}`);
  }

  return res.json();
}

async function overpass(query) {
  let lastErr = null;

  for (const url of OVERPASS_URLS) {
    try {
      console.log("Trying Overpass:", url);
      return await postOverpass(url, query);
    } catch (err) {
      lastErr = err;
      console.log("  -> failed, trying next endpoint...");
    }
  }

  throw lastErr || new Error("All Overpass endpoints failed.");
}

function buildOverpassQuery(lat, lng, radiusMeters) {
  return `
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
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const sourceRunId = nowRunId();

  console.log(`Starting pull_prospects_from_hubs run ${sourceRunId}...`);

  const hubsSnap = await db.collection("salesmanTerritoryHubs").get();
  console.log(`Loaded ${hubsSnap.size} territory hubs.`);

  let hubsProcessed = 0;
  let hubsSkipped = 0;
  let totalWritten = 0;

  for (const hubDoc of hubsSnap.docs) {
    const hub = hubDoc.data();

    const alreadyPulled = !!hub.prospectPullCompletedAt;
    if (alreadyPulled) {
      hubsSkipped++;
      console.log(`Skipping hub ${hubDoc.id} (already pulled before).`);
      continue;
    }

    const lat = toNum(hub.lat);
    const lng = toNum(hub.lng);
    const radiusMiles = toNum(hub.radiusMiles);

    if (lat === null || lng === null || radiusMiles === null || radiusMiles <= 0) {
      console.log(`Skipping hub ${hubDoc.id} (missing/invalid lat,lng,radiusMiles).`);
      continue;
    }

    const radiusMeters = milesToMeters(radiusMiles);
    const salespersonNo = cleanStr(hub.salespersonNo || hub.salesmanNo || hub.repNo || "");
    const salespersonName = cleanStr(
      hub.salespersonName || hub.salesmanName || hub.repName || ""
    );
    const city = cleanStr(hub.city || "");
    const state = cleanStr(hub.state || "").toUpperCase();

    console.log(
      `Pulling hub ${hubDoc.id} around (${lat}, ${lng}) radius ${radiusMiles}mi for ${
        salespersonName || salespersonNo || "unknown rep"
      }...`
    );

    try {
      const query = buildOverpassQuery(lat, lng, radiusMeters);
      const data = await overpass(query);
      const elements = data?.elements || [];

      console.log(`Hub ${hubDoc.id}: ${elements.length} raw OSM elements found.`);

      let writtenForHub = 0;
      let batch = db.batch();
      let opCount = 0;

      for (const el of elements) {
        const tags = el.tags || {};
        const elLat = el.lat ?? el.center?.lat ?? null;
        const elLng = el.lon ?? el.center?.lon ?? null;

        const address1 = cleanStr(tags["addr:housenumber"])
          ? `${cleanStr(tags["addr:housenumber"])} ${cleanStr(tags["addr:street"])}`
          : cleanStr(tags["addr:street"]);

        const zip = cleanStr(tags["addr:postcode"]);
        const phone = cleanStr(tags.phone || tags["contact:phone"]);
        const website = cleanStr(tags.website || tags["contact:website"]);
        const hoursText = cleanStr(tags.opening_hours);
        const name = cleanStr(tags.name) || "(unnamed)";
        const category = mapToCategory(tags);

        const placeId = `osm:${el.type}/${el.id}`;
        const docId = `osm_${hubDoc.id}_${el.type}_${el.id}`;

        batch.set(
          db.collection("prospects_raw").doc(docId),
          {
            source: "osm_overpass",
            sourceRunId,
            placeId,

            name,
            brand: cleanStr(tags.brand) || null,
            operator: cleanStr(tags.operator) || null,
            shop: cleanStr(tags.shop) || null,
            amenity: cleanStr(tags.amenity) || null,

            address1,
            city: city || cleanStr(tags["addr:city"]) || null,
            state: state || cleanStr(tags["addr:state"]).toUpperCase() || null,
            zip: zip || null,
            phone: phone || null,
            website: website || null,

            lat: elLat,
            lng: elLng,

            categories: [category],
            rating: null,
            reviews: null,
            hoursText: hoursText || null,

            sourceHubId: hubDoc.id,
            sourceHubLat: lat,
            sourceHubLng: lng,
            sourceHubRadiusMiles: radiusMiles,
            salespersonNo: salespersonNo || null,
            salespersonName: salespersonName || null,

            ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        writtenForHub++;
        totalWritten++;
        opCount++;

        if (opCount >= 450) {
          await batch.commit();
          batch = db.batch();
          opCount = 0;
          console.log(`Committed batch for hub ${hubDoc.id} at ${writtenForHub} rows.`);
        }
      }

      if (opCount > 0) {
        await batch.commit();
      }

      await hubDoc.ref.set(
        {
          prospectPullCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
          prospectPullRunId: sourceRunId,
          prospectPullSource: "osm_overpass",
          prospectPullCount: writtenForHub,
          prospectPullAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      hubsProcessed++;
      console.log(`✅ Hub ${hubDoc.id} complete. Wrote ${writtenForHub} prospects_raw docs.`);
    } catch (err) {
      console.log(`❌ Hub ${hubDoc.id} failed: ${err?.message || err}`);

      await hubDoc.ref.set(
        {
          prospectPullAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
          prospectPullFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          prospectPullError: String(err?.message || err).slice(0, 1000),
          prospectPullRunId: sourceRunId,
          prospectPullSource: "osm_overpass",
        },
        { merge: true }
      );
    }
  }

  console.log("");
  console.log("=====================================");
  console.log(`Run complete: ${sourceRunId}`);
  console.log(`Hubs processed: ${hubsProcessed}`);
  console.log(`Hubs skipped: ${hubsSkipped}`);
  console.log(`Total prospects_raw written: ${totalWritten}`);
  console.log("Next: run node process_prospects_raw.mjs");
  console.log("=====================================");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err?.message || err);
  process.exit(1);
});