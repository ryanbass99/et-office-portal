import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Firebase Admin init (server-side)
if (!getApps().length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    // IMPORTANT: bucket name like: et-office-portal.appspot.com
    storageBucket: mustEnv("FIREBASE_STORAGE_BUCKET"),
  });
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

    const bucket = getStorage().bucket(); // uses storageBucket from init above
    const file = bucket.file(decoded);

    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Short-lived signed URL (you can change to 1 hour if you want)
    const expiresAt = Date.now() + 15 * 60 * 1000;

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt,
    });

    // Redirect user to the signed URL
    return NextResponse.redirect(signedUrl, { status: 302 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to open sales sheet" },
      { status: 500 }
    );
  }
}
