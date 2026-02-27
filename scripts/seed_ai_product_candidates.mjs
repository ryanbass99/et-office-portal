// scripts/seed_ai_product_candidates.mjs
import admin from "firebase-admin";
import { createHash } from "crypto";

// ---- CONFIG ----
// Option A: Use service account JSON path (recommended for local scripts)
// Set GOOGLE_APPLICATION_CREDENTIALS to your service account json file path
//
// Windows PowerShell example:
// $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
//
// If you're already using another local-admin init approach, tell me and we’ll match it.

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

function nowTs() {
  return admin.firestore.Timestamp.now();
}

function hashId(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 24);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return admin.firestore.Timestamp.fromDate(d);
}

function candidateDoc(name, category, scoreTotal, opts = {}) {
  const firstDetectedAt = opts.firstDetectedAt ?? daysAgo(Math.floor(Math.random() * 10) + 1);
  const lastDetectedAt = opts.lastDetectedAt ?? daysAgo(Math.floor(Math.random() * 3));
  const id = hashId(`${name.toLowerCase().trim()}|${category}|${firstDetectedAt.toDate().toISOString().slice(0, 10)}`);

  const scoreTrend = Math.min(30, Math.max(0, Math.round(scoreTotal * 0.35)));
  const scoreMargin = Math.min(25, Math.max(0, Math.round(scoreTotal * 0.30)));
  const scoreImpulse = Math.min(20, Math.max(0, Math.round(scoreTotal * 0.20)));
  const scoreChannelFit = Math.min(15, Math.max(0, Math.round(scoreTotal * 0.15)));

  const priceMin = opts.priceMin ?? Number((Math.random() * 6 + 1).toFixed(2));
  const priceMax = opts.priceMax ?? Number((priceMin + Math.random() * 6 + 1).toFixed(2));
  const landed = opts.landedCostEstimate ?? Number((Math.min(14.5, priceMin + Math.random() * 3)).toFixed(2));
  const retail = opts.retailEstimate ?? Number((landed * (1.9 + Math.random() * 0.9)).toFixed(2));
  const marginPct = Number((((retail - landed) / retail) * 100).toFixed(1));

  const velocity = opts.velocity ?? (scoreTotal >= 85 ? "up" : scoreTotal >= 70 ? "flat" : "up");

  return {
    id,
    data: {
      name,
      category,
      scoreTotal,
      scoreTrend,
      scoreMargin,
      scoreImpulse,
      scoreChannelFit,
      riskScore: opts.riskScore ?? 0,
      riskNotes: opts.riskNotes ?? [],
      sources: {
        tiktok: {
          found: true,
          keywords: opts.tiktokKeywords ?? [name.split(" ")[0].toLowerCase(), "viral", "musthave"],
          exampleLinks: [],
          signalStrength: opts.tiktokStrength ?? Math.min(100, scoreTotal + 5),
        },
        amazon: {
          found: true,
          category: opts.amazonCategory ?? "Movers & Shakers",
          rank: opts.amazonRank ?? Math.floor(Math.random() * 200) + 1,
          signalStrength: opts.amazonStrength ?? Math.min(100, scoreTotal + 10),
        },
        temu: {
          found: true,
          signalStrength: opts.temuStrength ?? Math.min(100, scoreTotal),
        },
        alibaba: {
          found: true,
          supplierCount: opts.supplierCount ?? Math.floor(Math.random() * 60) + 10,
          priceMin,
          priceMax,
          moqNotes: opts.moqNotes ?? "MOQ varies (50–500).",
          topSuppliers: (opts.topSuppliers ?? []).slice(0, 5),
        },
      },
      landedCostEstimate: landed,
      retailEstimate: retail,
      marginEstimatePct: marginPct,
      status: opts.status ?? "new", // new | watch | investigate | ordered | pass
      createdAt: nowTs(),
      updatedAt: nowTs(),
      firstDetectedAt,
      lastDetectedAt,
      velocity, // up | flat | down
    },
  };
}

async function main() {
  const samples = [
    candidateDoc("Magnetic Phone Mount (Dash)", "Auto", 88, { status: "new" }),
    candidateDoc("Mini Desk Vacuum (Keyboard Crumbs)", "Dorm / Office", 82, { status: "new" }),
    candidateDoc("Silicone Air Fryer Liners", "Kitchen", 78, { status: "watch" }),
    candidateDoc("Refillable Travel Perfume Atomizer", "Beauty / Travel", 76, { status: "new" }),
    candidateDoc("Cable Organizer Clips (Pack)", "Tech Accessories", 74, { status: "new" }),
    candidateDoc("Ice Roller Face Massager", "Beauty", 71, { status: "watch" }),
    candidateDoc("Stainless Pocket Multitool Keychain", "Hardware / EDC", 69, { status: "new" }),
    candidateDoc("Car Seat Gap Filler Organizer", "Auto", 84, { status: "new" }),
    candidateDoc("Collapsible Water Bottle (Pocket)", "Travel", 66, { status: "new" }),
    candidateDoc("Snackle Box Container (Portable)", "Food / Novelty", 90, { status: "investigate" }),
  ];

  const batch = db.batch();
  for (const s of samples) {
    const ref = db.collection("aiProductCandidates").doc(s.id);
    batch.set(ref, s.data, { merge: true });
  }

  await batch.commit();
  console.log(`✅ Seeded ${samples.length} aiProductCandidates docs.`);
  console.log(`Collection: aiProductCandidates`);
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});