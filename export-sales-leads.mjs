// export-sales-leads.mjs
import fs from "fs";
import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

function csvEscape(value) {
  if (value === null || value === undefined) return "";

  const str = String(value).replace(/"/g, '""');
  return `"${str}"`;
}

function normalizeValue(value) {
  if (value === null || value === undefined) return "";

  // Firestore Timestamp
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  // Arrays / objects
  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

async function exportSalesLeads() {
  const snapshot = await db.collection("salesLeads").get();

  if (snapshot.empty) {
    console.log("No documents found in salesLeads.");
    return;
  }

  const docs = snapshot.docs.map((doc) => ({
    documentId: doc.id,
    ...doc.data(),
  }));

  const fieldSet = new Set();

  for (const doc of docs) {
    Object.keys(doc).forEach((key) => fieldSet.add(key));
  }

  const headers = Array.from(fieldSet);

  const lines = [];
  lines.push(headers.map(csvEscape).join(","));

  for (const doc of docs) {
    const row = headers.map((header) =>
      csvEscape(normalizeValue(doc[header]))
    );
    lines.push(row.join(","));
  }

  fs.writeFileSync("salesLeads_export.csv", lines.join("\n"), "utf8");

  console.log(
    `Exported ${docs.length} documents to salesLeads_export.csv`
  );
}

exportSalesLeads().catch((err) => {
  console.error("Export failed:");
  console.error(err);
});