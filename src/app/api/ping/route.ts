import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env vars.");
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export async function POST(req: Request) {
  initAdmin();

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return NextResponse.json({ ok: false, error: "Missing token" }, { status: 401 });
  }

  let uid: string;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid token" }, { status: 401 });
  }

  const body = await req.json();

  const { kind, sessionId, path, activeMs } = body ?? {};
  if (!kind || !sessionId) {
    return NextResponse.json({ ok: false, error: "Missing kind/sessionId" }, { status: 400 });
  }

  const db = getFirestore();

  // Session doc
  const sessionRef = db.collection("usageSessions").doc(sessionId);

  // Create/update session
  const sessionPatch: any = {
    uid,
    path: path ?? "",
    lastActiveAt: FieldValue.serverTimestamp(),
    activeMs: typeof activeMs === "number" ? activeMs : 0,
  };

  if (kind === "session_start") {
    sessionPatch.startedAt = FieldValue.serverTimestamp();
  }
  if (kind === "session_end") {
    sessionPatch.endedAt = FieldValue.serverTimestamp();
  }

  await sessionRef.set(sessionPatch, { merge: true });

  return NextResponse.json({ ok: true });
}
