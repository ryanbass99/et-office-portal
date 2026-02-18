import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function json(status: number, body: any) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ensureAdmin() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env vars for usage tracking.");
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export async function POST(req: Request) {
  try {
    ensureAdmin();

    let payload: any = null;
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON" });
    }

    const { idToken, kind, sessionId, path, activeMs } = payload || {};
    if (!idToken || !kind || !sessionId) {
      return json(400, { error: "Missing idToken/kind/sessionId" });
    }

    const decoded = await getAuth().verifyIdToken(String(idToken));
    const uid = decoded.uid;

    const db = getFirestore();

    // Pull extra rep info from /users/{uid} (safe if doc missing)
    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.exists ? (userSnap.data() as any) : {};
    const salesmanId = userData?.salesperson ?? null;
    const name = userData?.name ?? userData?.displayName ?? decoded.email ?? null;

    const ref = db.collection("usageSessions").doc(String(sessionId));

    const patch: any = {
      uid,
      salesmanId,
      name,
      path: String(path || ""),
      lastActiveAt: FieldValue.serverTimestamp(),
      activeMs: Number(activeMs || 0),
      lastKind: String(kind),
    };

    if (kind === "start") patch.startedAt = FieldValue.serverTimestamp();
    if (kind === "end") patch.endedAt = FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });

    return json(200, { ok: true });
  } catch (e: any) {
    console.error("usage ping error:", e);
    return json(500, { error: e?.message ?? String(e) });
  }
}
