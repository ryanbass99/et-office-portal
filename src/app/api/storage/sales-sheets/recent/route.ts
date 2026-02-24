import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const HARD_BUCKET = "et-office-portal.firebasestorage.app"; // ✅ your bucket

if (!getApps().length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || HARD_BUCKET,
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const days = Number(searchParams.get("days") || "7");
    const prefix = searchParams.get("prefix") || "sales-sheets/";

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // ✅ explicitly use the bucket
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || HARD_BUCKET;
    const bucket = getStorage().bucket(bucketName);

    const [files] = await bucket.getFiles({ prefix });

    const recent = files
      .map((f) => {
        const updatedMs = f.metadata?.updated
          ? new Date(f.metadata.updated).getTime()
          : 0;

        return {
          name: f.name,
          fileName: f.name.split("/").pop() || f.name,
          contentType: f.metadata?.contentType || "",
          size: Number(f.metadata?.size || 0),
          updated: f.metadata?.updated || null,
          updatedMs,
        };
      })
      .filter((x) => x.updatedMs >= cutoff)
      .sort((a, b) => b.updatedMs - a.updatedMs)
      .slice(0, 25);

    const withUrls = await Promise.all(
      recent.map(async (r) => {
        const file = bucket.file(r.name);
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000,
        });
        return { ...r, url };
      })
    );

    return NextResponse.json({ prefix, days, count: withUrls.length, files: withUrls });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to list storage files." },
      { status: 500 }
    );
  }
}