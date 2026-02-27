// tools/delete_aiProductCandidates.mjs
// Deletes *all* docs in the Firestore collection: aiProductCandidates
// Safety: requires CONFIRM_DELETE=YES

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const COLLECTION = "aiProductCandidates";
const BATCH_SIZE = 450; // keep under 500 for safety

function mustConfirm() {
  if (process.env.CONFIRM_DELETE !== "YES") {
    console.error(
      `\n❌ Refusing to delete.\nSet CONFIRM_DELETE=YES to proceed.\n`
    );
    process.exit(1);
  }
}

function initAdmin() {
  if (!getApps().length) {
    // Uses GOOGLE_APPLICATION_CREDENTIALS (service account json path) if set.
    // Otherwise will attempt Application Default Credentials (may fail locally).
    initializeApp({ credential: applicationDefault() });
  }
  return getFirestore();
}

async function deleteCollection(db) {
  const colRef = db.collection(COLLECTION);
  let totalDeleted = 0;
  const started = Date.now();

  while (true) {
    const snap = await colRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    totalDeleted += snap.size;
    console.log(`🧹 Deleted ${snap.size} docs (total: ${totalDeleted})...`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n✅ Done. Deleted ${totalDeleted} docs from "${COLLECTION}" in ${secs}s.`);
}

async function main() {
  mustConfirm();

  const db = initAdmin();
  console.log(`\n⚠️  Deleting ALL documents in collection: "${COLLECTION}"`);
  console.log(`Project (from credentials): ${process.env.GCLOUD_PROJECT || "(auto)"}\n`);

  await deleteCollection(db);
}

main().catch((err) => {
  console.error("\n❌ Delete failed:", err);
  process.exit(1);
});