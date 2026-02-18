import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

if (!getApps().length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    storageBucket,
  });
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
    const bucket = getStorage().bucket();

    // Pull a small sample of objects so we can detect the real folder
    const [all] = await bucket.getFiles({ maxResults: 200 });

    const names = all.map((f) => f.name);

    // Find which candidate prefix actually exists in the bucket
    const detectedPrefix =
      PREFIX_CANDIDATES.find((p) => names.some((n) => n.startsWith(p))) ?? null;

    // If nothing matched, return diagnostics so we can see what the bucket contains
    if (!detectedPrefix) {
      return NextResponse.json(
        {
          sheets: [],
          diagnostic: {
            bucket: process.env.FIREBASE_STORAGE_BUCKET,
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
        bucket: process.env.FIREBASE_STORAGE_BUCKET,
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
