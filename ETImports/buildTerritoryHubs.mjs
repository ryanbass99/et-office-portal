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

const CLUSTER_DISTANCE_MILES = 50;
const MIN_CLUSTER_SIZE = 3;

function cleanText(v) {
  return String(v ?? "").trim();
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

function distanceMiles(a, b) {
  const R = 3958.8;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function distanceMeters(a, b) {
  return distanceMiles(a, b) * 1609.34;
}

function averageCenter(points) {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng };
}

function getAccountScore(a) {
  let score = 0;
  if (cleanText(a.customerName)) score += 100;
  if (cleanText(a.address1)) score += 40;
  if (cleanText(a.city)) score += 10;
  if (cleanText(a.state)) score += 10;
  if (cleanText(a.zip)) score += 10;
  return score;
}

function dedupeAccounts(rows) {
  const kept = [];

  for (const row of rows) {
    let merged = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];

      const sameAddr =
        cleanText(existing.address1).toLowerCase() ===
          cleanText(row.address1).toLowerCase() &&
        cleanText(existing.city).toLowerCase() ===
          cleanText(row.city).toLowerCase() &&
        cleanText(existing.state).toLowerCase() ===
          cleanText(row.state).toLowerCase();

      const close = distanceMeters(existing, row) <= 35;

      if (sameAddr || close) {
        if (getAccountScore(row) > getAccountScore(existing)) {
          kept[i] = row;
        }
        merged = true;
        break;
      }
    }

    if (!merged) kept.push(row);
  }

  return kept;
}

function clusterAccounts(accounts) {
  const clusters = [];

  for (const acct of accounts) {
    let placed = false;

    for (const cluster of clusters) {
      const center = averageCenter(cluster);

      if (distanceMiles(center, acct) <= CLUSTER_DISTANCE_MILES) {
        cluster.push(acct);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push([acct]);
    }
  }

  return clusters;
}

async function commitInChunks(ops, chunkSize = 400) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + chunkSize)) {
      if (op.type === "set") {
        batch.set(op.ref, op.data);
      } else if (op.type === "delete") {
        batch.delete(op.ref);
      }
    }
    await batch.commit();
  }
}

async function main() {
  console.log("Loading customerLocations...");

  const snap = await db.collection("customerLocations").get();
  const bySalesman = {};

  snap.forEach((doc) => {
    const d = doc.data();

    if (
      typeof d.lat !== "number" ||
      typeof d.lng !== "number" ||
      !d.salespersonNo
    ) {
      return;
    }

    if (!bySalesman[d.salespersonNo]) {
      bySalesman[d.salespersonNo] = [];
    }

    bySalesman[d.salespersonNo].push({
      lat: d.lat,
      lng: d.lng,
      customerNo: d.customerNo,
      customerName: d.customerName,
      address1: d.address1,
      city: d.city,
      state: d.state,
      zip: d.zip,
    });
  });

  console.log("Deleting existing hubs...");
  const existingHubSnap = await db.collection("salesmanTerritoryHubs").get();

  const deleteOps = [];
  existingHubSnap.forEach((doc) => {
    deleteOps.push({
      type: "delete",
      ref: doc.ref,
    });
  });

  await commitInChunks(deleteOps);

  const setOps = [];

  for (const salesman of Object.keys(bySalesman)) {
    console.log(`Processing salesman ${salesman}`);

    const deduped = dedupeAccounts(bySalesman[salesman]);
    const clusters = clusterAccounts(deduped);

    let clusterIndex = 1;

    for (const cluster of clusters) {
      if (cluster.length < MIN_CLUSTER_SIZE) continue;

      const center = averageCenter(cluster);

      let maxMiles = 0;
      for (const acct of cluster) {
        const dist = distanceMiles(center, acct);
        if (dist > maxMiles) maxMiles = dist;
      }

      const radiusMiles = maxMiles + 5;
      const radiusMeters = radiusMiles * 1609.34;

      const ref = db
        .collection("salesmanTerritoryHubs")
        .doc(`${salesman}_${clusterIndex}`);

      setOps.push({
        type: "set",
        ref,
        data: {
          salespersonNo: salesman,
          clusterId: `${salesman}_${clusterIndex}`,
          hubName: `Hub ${clusterIndex}`,
          lat: center.lat,
          lng: center.lng,
          accountCount: cluster.length,
          memberCustomerNos: cluster.map((x) => x.customerNo).filter(Boolean),
          radiusMiles,
          radiusMeters,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      clusterIndex++;
    }
  }

  console.log("Writing hubs...");
  await commitInChunks(setOps);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});