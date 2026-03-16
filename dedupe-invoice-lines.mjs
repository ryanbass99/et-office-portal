import fs from "fs";
import admin from "firebase-admin";

const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const INVOICES_COLLECTION = "invoices";

const DRY_RUN = process.env.DRY_RUN !== "0";

const serviceAccount = JSON.parse(
  fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function buildSignature(d) {
  return [
    clean(d.invoiceNo),
    clean(d.itemCode),
    clean(d.itemCodeDesc),
    clean(d.quantityShipped),
    clean(d.extensionAmt),
    clean(d.unitPrice),
    clean(d.warehouseCode),
  ].join("|");
}

async function run() {
  console.log("Starting invoice line dedupe...");
  console.log("Dry run:", DRY_RUN);

  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    if (err.failedAttempts < 5) return true;
    console.error("Write failed permanently:", err);
    return false;
  });

  let lastDoc = null;
  let invoicesScanned = 0;
  let linesScanned = 0;
  let duplicatesFound = 0;
  let deleted = 0;

  while (true) {
    let q = db
      .collection(INVOICES_COLLECTION)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(500);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const inv of snap.docs) {
      invoicesScanned++;

      const linesSnap = await inv.ref.collection("lines").get();

      const seen = new Map();

      for (const line of linesSnap.docs) {
        linesScanned++;

        const data = line.data();
        const sig = buildSignature(data);

        if (!seen.has(sig)) {
          seen.set(sig, line);
          continue;
        }

        duplicatesFound++;

        if (!DRY_RUN) {
          writer.delete(line.ref);
          deleted++;
        }
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];

    console.log(
      `Progress: invoices=${invoicesScanned} lines=${linesScanned} duplicates=${duplicatesFound}`
    );
  }

  await writer.close();

  console.log("\n==== COMPLETE ====");
  console.log("Invoices scanned:", invoicesScanned);
  console.log("Lines scanned:", linesScanned);
  console.log("Duplicates found:", duplicatesFound);
  console.log("Deleted:", deleted);
}

run().catch((err) => {
  console.error("Dedupe failed:", err);
  process.exit(1);
});