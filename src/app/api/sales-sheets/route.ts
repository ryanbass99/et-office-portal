// src/app/api/sales-sheets/route.ts
import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function initAdmin() {
  // In Next.js dev (Turbopack/HMR), route modules can be reloaded in different orders.
  // Another module may initialize firebase-admin without a storageBucket.
  // We still initialize here if needed, but we will ALWAYS pass the bucket name
  // explicitly when calling getStorage().bucket(bucketName) below to avoid
  // "Bucket name not specified or invalid" ever happening.
  if (getApps().length) return;

  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    // Keep this for completeness, but do not rely on it.
    storageBucket: mustEnv("FIREBASE_STORAGE_BUCKET"),
  });
}

export async function GET() {
  try {
    // Always require bucket env, even if another module initialized admin first.
    const bucketName = mustEnv("FIREBASE_STORAGE_BUCKET");

    initAdmin();

    // ✅ Always specify the bucket explicitly to avoid intermittent default-bucket issues.
    const bucket = getStorage().bucket(bucketName);

    const prefix = "sales-sheets/";
    const [files] = await bucket.getFiles({ prefix });

    const sheets = await Promise.all(
      files
        .filter((f) => f.name && !f.name.endsWith("/"))
        .map(async (f) => {
          const [meta] = await f.getMetadata();
          const name = f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;

          return {
            name,
            path: f.name,
            updated: meta?.updated ?? null, // last modified (string)
            timeCreated: meta?.timeCreated ?? null, // created (string)
            size: meta?.size ?? null,
            contentType: meta?.contentType ?? null,
          };
        })
    );

    return NextResponse.json({ sheets });
  } catch (e: any) {
    return new NextResponse(e?.message ?? "Failed to list sales sheets", {
      status: 500,
    });
  }
}
