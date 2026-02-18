import fs from "fs";
import admin from "firebase-admin";

const SERVICE_ACCOUNT_PATH = "C:\\sageexports\\serviceAccountKey.json";
const INVOICES_COLLECTION = "invoices";
const BULK_FLUSH_EVERY = 5000;

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function run() {
  const writer = db.bulkWriter();
  let ops = 0;

  writer.onWriteError((err) => {
    if (err.failedAttempts < 5) return true;
    console.error("Write failed permanently:", err);
    return false;
  });

  console.log("Scanning invoices...");

  let lastDoc = null;
  let invoiceCount = 0;
  let lineCount = 0;

  while (true) {
    let q = db.collection(INVOICES_COLLECTION).orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const inv of snap.docs) {
      invoiceCount++;

      const invData = inv.data() || {};
      const invoiceDate = invData.invoiceDate ?? null;
      const customerNo = invData.customerNo ?? "";
      const salespersonNo = invData.salespersonNo ?? "";
      const invoiceNo = invData.invoiceNo ?? inv.id;

      // Page through lines subcollection
      let lastLine = null;
      while (true) {
        let lq = inv.ref.collection("lines").orderBy(admin.firestore.FieldPath.documentId()).limit(500);
        if (lastLine) lq = lq.startAfter(lastLine);

        const lsnap = await lq.get();
        if (lsnap.empty) break;

        for (const line of lsnap.docs) {
          lineCount++;
          writer.set(
            line.ref,
            {
              invoiceNo,
              invoiceDate,
              customerNo,
              salespersonNo,
              headerAttachedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          ops++;
          if (ops >= BULK_FLUSH_EVERY) {
            await writer.flush();
            ops = 0;
            console.log(`Progress: invoices=${invoiceCount}, linesUpdated=${lineCount}`);
          }
        }

        lastLine = lsnap.docs[lsnap.docs.length - 1];
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  await writer.flush();
  await writer.close();

  console.log(`✅ Backfill complete. invoices=${invoiceCount}, linesUpdated=${lineCount}`);
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
