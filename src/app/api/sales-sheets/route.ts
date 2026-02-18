import { NextResponse } from "next/server";
import { getApps, initializeApp, cert, getApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

export const runtime = "nodejs"; // force Node runtime on Netlify/Next

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const STORAGE_APP_NAME = "storage-admin";

function getStorageApp() {
  // ✅ Always use a dedicated app instance so we never depend on the default app’s config.
  try {
    return getApp(STORAGE_APP_NAME);
  } catch {
    const projectId = mustEnv("FIREBASE_PROJECT_ID");
    const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
    const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

    const storageBucket = mustEnv("FIREBASE_STORAGE_BUCKET"); // e.g. et-office-portal.firebasestorage.app

    return initializeApp(
      {
        credential: cert({ projectId, clientEmail, privateKey }),
        storageBucket,
      },
      STORAGE_APP_NAME
    );
  }
}

const PREFIX_CANDIDATES = [
  "sales-sheets/",
  "salesSheets/",
  "sales_sheets/",
  "Sales Sheets/",
  "Sales-Sheets/",
];

export async function GET() {
  try {
    const app = getStorageApp();

    const bucketName = mustEnv("FIREBASE_STORAGE_BUCKET");
    const bucket = getStorage(app).bucket(bucketName);

    const [all] = await bucket.getFiles({ maxResults: 200 });
    const names = all.map((f) => f.name);

    const detectedPrefix =
      PREFIX_CANDIDATES.find((p) => names.some((n) => n.startsWith(p))) ?? null;

    if (!detectedPrefix) {
      return NextResponse.json(
        {
          sheets: [],
          diagnostic: {
            bucket: bucketName,
            sampleObjects: names.slice(0, 50),
            note:
              "No known sales-sheets folder found. Look at sampleObjects to see actual folder names.",
          },
        },
        { status: 200 }
      );
    }

    const pdfs = names
      .filter((n) => n.startsWith(detectedPrefix))
      .filter((n) => n.toLowerCase().endsWith(".pdf"))
      .map((n) => {
        const parts = n.split("/");
        const filename = parts[parts.length - 1] || n;
        return { name: filename, path: n };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      sheets: pdfs,
      diagnostic: {
        bucket: bucketName,
        detectedPrefix,
        totalObjectsScanned: names.length,
        pdfCount: pdfs.length,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to load sales sheets" },
      { status: 500 }
    );
  }
}
