import admin from "firebase-admin";
import fs from "fs";

const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const DRY_RUN = process.argv.includes("--dry-run");

const BATCH_SIZE = 250;

const CHAIN_KEYWORDS = [
  "Walmart",
  "Casey's",
  "Dollar General",
  "Dollar Tree",
  "Family Dollar",
  "Walgreens",
  "CVS",
  "Hy-Vee",
  "Fareway",
  "Aldi",
  "Menards",
  "Home Depot",
  "Lowe's",
  "Target",
  "Kwik Star",
  "Kum & Go",
];

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"))
  ),
});

const db = admin.firestore();
db.settings({ timeoutSeconds: 600 });

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function cleanStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function detectType(p) {
  const shop = cleanStr(p.shop).toLowerCase();
  const amenity = cleanStr(p.amenity).toLowerCase();
  const categories = Array.isArray(p.categories)
    ? p.categories.map((x) => cleanStr(x).toLowerCase())
    : [];

  if (shop === "supermarket" || shop === "grocery") {
    return { type: "Grocery", score: 100 };
  }

  if (
    categories.includes("gas_station") ||
    categories.includes("convenience_store") ||
    amenity === "fuel" ||
    shop === "convenience"
  ) {
    return { type: "Convenience", score: 90 };
  }

  if (shop === "hardware") {
    return { type: "Hardware", score: 80 };
  }

  if (shop === "alcohol" || shop === "liquor") {
    return { type: "Liquor", score: 70 };
  }

  if (amenity === "pharmacy" || shop === "pharmacy") {
    return { type: "Pharmacy", score: 60 };
  }

  return { type: "Rest", score: 40 };
}

function detectHours(hoursText) {
  const raw = cleanStr(hoursText);
  if (!raw) return { label: "unknown", score: 35 };

  const t = raw.toLowerCase();

  if (
    t.includes("24/7") ||
    t.includes("24 hours") ||
    t.includes("24hrs") ||
    t.includes("24 hr")
  ) {
    return { label: "24/7", score: 100 };
  }

  if (
    t.includes("seasonal") ||
    t.includes("season ") ||
    t.includes("summer only") ||
    t.includes("winter only")
  ) {
    return { label: "seasonal", score: 10 };
  }

  if (
    t.includes("23:") ||
    t.includes("22:") ||
    t.includes("11pm") ||
    t.includes("12am") ||
    t.includes("midnight")
  ) {
    return { label: "late night", score: 80 };
  }

  if (
    t.includes("20:") ||
    t.includes("21:") ||
    t.includes("8pm") ||
    t.includes("9pm") ||
    t.includes("10pm")
  ) {
    return { label: "normal retail", score: 60 };
  }

  return { label: "limited", score: 40 };
}

function isChain(p) {
  const chainText = `${cleanStr(p.name)} ${cleanStr(p.brand)}`.toLowerCase();

  for (const c of CHAIN_KEYWORDS) {
    if (chainText.includes(c.toLowerCase())) return true;
  }

  return false;
}

function reviewRaw(p) {
  const rating = Number(p.rating || 0);
  const reviews = Number(p.reviews || 0);
  return rating * Math.log(reviews + 1);
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildRankingReason(p) {
  const reviewLabel =
    p._reviewScore >= 70
      ? "strong reviews"
      : p._reviewScore >= 40
      ? "moderate reviews"
      : "limited reviews";

  const distanceLabel =
    p._distanceScore >= 70
      ? "close to hub"
      : p._distanceScore >= 35
      ? "moderate distance"
      : "far from hub";

  const typeLabel =
    p._type.type === "Convenience"
      ? "Convenience store"
      : p._type.type === "Liquor"
      ? "Liquor store"
      : p._type.type === "Hardware"
      ? "Hardware store"
      : p._type.type;

  return `${typeLabel}, ${p._hours.label}, ${reviewLabel}, ${distanceLabel}`;
}

(async () => {
  try {
    console.log("Loading prospects...");

    const snap = await db.collection("prospects").get();
    const prospects = [];

    snap.forEach((doc) => {
      prospects.push({ id: doc.id, ...doc.data() });
    });

    console.log(`Loaded ${prospects.length} prospects`);

    let excludedChains = 0;
    let excludedLatLng = 0;
    let totalEligible = 0;
    let totalVisible = 0;
    let totalBackup = 0;
    let totalExcluded = 0;

    const hubs = {};

    for (const p of prospects) {
      const hubId = cleanStr(p.sourceHubId);
      if (!hubId) continue;

      if (!hubs[hubId]) hubs[hubId] = [];
      hubs[hubId].push(p);
    }

    const hubIds = Object.keys(hubs).sort();
    console.log(`Found ${hubIds.length} hubs`);

    const updates = [];

    for (const hubId of hubIds) {
      const list = hubs[hubId];
      const eligible = [];

      for (const p of list) {
        const lat = safeNumber(p.lat);
        const lng = safeNumber(p.lng);
        const hubLat = safeNumber(p.sourceHubLat);
        const hubLng = safeNumber(p.sourceHubLng);
        const hubRadiusMiles = safeNumber(p.sourceHubRadiusMiles);

        if (
          lat === null ||
          lng === null ||
          hubLat === null ||
          hubLng === null ||
          hubRadiusMiles === null ||
          hubRadiusMiles <= 0
        ) {
          excludedLatLng++;
          totalExcluded++;
          p._eligible = false;
          p._reason = "missing_lat_lng";
          continue;
        }

        if (isChain(p)) {
          excludedChains++;
          totalExcluded++;
          p._eligible = false;
          p._reason = "excluded_chain";
          continue;
        }

        const type = detectType(p);
        const hours = detectHours(p.hoursText);
        const dist = haversine(lat, lng, hubLat, hubLng);
        const distScore = Math.max(0, 100 - (dist / hubRadiusMiles) * 100);
        const review = reviewRaw(p);

        p._eligible = true;
        p._type = type;
        p._hours = hours;
        p._distance = dist;
        p._distanceScore = distScore;
        p._reviewRaw = review;

        eligible.push(p);
      }

      const maxReviewRaw =
        eligible.length > 0
          ? Math.max(...eligible.map((x) => x._reviewRaw), 1)
          : 1;

      for (const p of eligible) {
        const reviewScore = (p._reviewRaw / maxReviewRaw) * 100;

        const hubScore =
          p._type.score * 0.5 +
          p._hours.score * 0.2 +
          reviewScore * 0.2 +
          p._distanceScore * 0.1;

        p._reviewScore = reviewScore;
        p._hubScore = hubScore;
      }

      eligible.sort((a, b) => {
        if (b._hubScore !== a._hubScore) return b._hubScore - a._hubScore;
        if (a._distance !== b._distance) return a._distance - b._distance;

        const aName = cleanStr(a.name).toLowerCase();
        const bName = cleanStr(b.name).toLowerCase();
        if (aName !== bName) return aName.localeCompare(bName);

        return a.id.localeCompare(b.id);
      });

      const top10 = eligible.slice(0, 10);
      console.log(`\nHub ${hubId} top 10:`);
      top10.forEach((p, i) => {
        console.log(
          `${i + 1}. ${cleanStr(p.name) || "(unnamed)"} | score=${p._hubScore.toFixed(
            2
          )} | type=${p._type.type} | hours=${p._hours.label} | reviews=${p._reviewScore.toFixed(
            1
          )} | dist=${p._distance.toFixed(1)}`
        );
      });

      let visibleCountForHub = 0;

      for (let i = 0; i < eligible.length; i++) {
        const p = eligible[i];
        const rank = i + 1;
        const status = cleanStr(p.status) || "open";
        const showOnMap = rank <= 10 && status === "open";

        if (rank <= 250) {
          if (showOnMap) totalVisible++;
          if (rank > 10) totalBackup++;
          totalEligible++;

          updates.push({
            id: p.id,
            data: {
              status,
              hubId: cleanStr(p.sourceHubId),
              hubName: cleanStr(p.sourceHubName),
              hubScore: Number(p._hubScore.toFixed(4)),
              hubRank: rank,
              hubEligible: true,
              showOnMap,
              rankingType: p._type.type,
              rankingHours: p._hours.label,
              rankingReviews: Number(p._reviewScore.toFixed(4)),
              rankingDistance: Number(p._distanceScore.toFixed(4)),
              rankingReason: buildRankingReason(p),
              rankingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          });

          if (showOnMap) visibleCountForHub++;
        } else {
          totalExcluded++;

          updates.push({
            id: p.id,
            data: {
              status,
              hubId: cleanStr(p.sourceHubId),
              hubName: cleanStr(p.sourceHubName),
              hubScore: Number(p._hubScore.toFixed(4)),
              hubRank: null,
              hubEligible: false,
              showOnMap: false,
              rankingType: p._type.type,
              rankingHours: p._hours.label,
              rankingReviews: Number(p._reviewScore.toFixed(4)),
              rankingDistance: Number(p._distanceScore.toFixed(4)),
              rankingReason: buildRankingReason(p),
              rankingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          });
        }
      }

      for (const p of list.filter((x) => !x._eligible)) {
        const status = cleanStr(p.status) || "open";

        updates.push({
          id: p.id,
          data: {
            status,
            hubId: cleanStr(p.sourceHubId),
            hubName: cleanStr(p.sourceHubName),
            hubScore: 0,
            hubRank: null,
            hubEligible: false,
            showOnMap: false,
            rankingType: null,
            rankingHours: null,
            rankingReviews: 0,
            rankingDistance: 0,
            rankingReason: p._reason,
            rankingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }

      console.log(
        `Hub ${hubId}: total=${list.length}, eligible=${eligible.length}, visibleTop10=${visibleCountForHub}`
      );
    }

    console.log("\n========== SUMMARY ==========");
    console.log(`Loaded prospects: ${prospects.length}`);
    console.log(`Eligible prospects: ${totalEligible}`);
    console.log(`Visible on map: ${totalVisible}`);
    console.log(`Backup leads: ${totalBackup}`);
    console.log(`Excluded chains: ${excludedChains}`);
    console.log(`Missing lat/lng: ${excludedLatLng}`);
    console.log(`Total excluded: ${totalExcluded}`);
    console.log(`Hubs processed: ${hubIds.length}`);

    if (DRY_RUN) {
      console.log("Dry run complete. No writes performed.");
      process.exit(0);
    }

    console.log(`Writing ${updates.length} updates...`);

    let batch = db.batch();
    let opsInBatch = 0;
    let totalWritten = 0;
    let batchNum = 1;

    for (const u of updates) {
      const ref = db.collection("prospects").doc(u.id);
      batch.set(ref, u.data, { merge: true });
      opsInBatch++;
      totalWritten++;

      if (opsInBatch === BATCH_SIZE) {
        console.log(`Writing batch ${batchNum}...`);
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
        batchNum++;
      }
    }

    if (opsInBatch > 0) {
      console.log(`Writing batch ${batchNum}...`);
      await batch.commit();
    }

    console.log("\n========== WRITE COMPLETE ==========");
    console.log(`Total written: ${totalWritten}`);
    console.log(`Eligible prospects: ${totalEligible}`);
    console.log(`Visible on map: ${totalVisible}`);
    console.log(`Backup leads: ${totalBackup}`);
    console.log(`Total excluded: ${totalExcluded}`);
    console.log(`Hubs processed: ${hubIds.length}`);
    console.log("Ranking complete.");

    process.exit(0);
  } catch (err) {
    console.error("Ranking failed:");
    console.error(err);
    process.exit(1);
  }
})();