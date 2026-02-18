import dotenv from "dotenv";
dotenv.config({ path: "C:\\Users\\ryan.bass\\et-office-portal\\.env.local" });
import path from "path";
import fs from "fs";
import admin from "firebase-admin";

const LOCAL_DIR = "C:\\Users\\ryan.bass\\et-office-portal\\salesSheets";
const BUCKET_FOLDER = "sales-sheets";
const BUCKET_NAME = "et-office-portal.firebasestorage.app";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ---- Firebase Admin init (uses env vars, like your SendGrid route) ----
if (!admin.apps.length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    storageBucket: BUCKET_NAME,
  });
}

const bucket = admin.storage().bucket(BUCKET_NAME);

function listPdfFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(dir, f));
}

async function main() {
  const files = listPdfFiles(LOCAL_DIR);
  if (!files.length) {
    console.log("No PDFs found in:", LOCAL_DIR);
    return;
  }

  console.log(
    `Found ${files.length} PDFs. Uploading to gs://${bucket.name}/${BUCKET_FOLDER}/ ...`
  );

  for (const fullPath of files) {
    const filename = path.basename(fullPath);
    const destination = `${BUCKET_FOLDER}/${filename}`;

    await bucket.upload(fullPath, {
      destination,
      metadata: { contentType: "application/pdf" },
    });

    console.log("Uploaded:", destination);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
