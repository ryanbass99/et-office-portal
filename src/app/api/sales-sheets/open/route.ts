import { NextResponse } from "next/server";
import { initializeApp, cert, getApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

export const runtime = "nodejs"; // force Node runtime

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const STORAGE_APP_NAME = "storage-admin";

function getStorageApp() {
  // Always use a dedicated app instance so we never depend on the default app’s config.
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

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const path = searchParams.get("path") || "";

    // Basic validation: only allow stuff inside sales-sheets/
    const decoded = decodeURIComponent(path);
    if (!decoded.startsWith("sales-sheets/") || decoded.includes("..")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const app = getStorageApp();
    const bucketName = mustEnv("FIREBASE_STORAGE_BUCKET");
    const bucket = getStorage(app).bucket(bucketName);

    const file = bucket.file(decoded);

    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Short-lived signed URL
    const expiresAt = Date.now() + 15 * 60 * 1000;

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt,
    });

    return NextResponse.redirect(signedUrl, { status: 302 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to open sales sheet" },
      { status: 500 }
    );
  }
}
