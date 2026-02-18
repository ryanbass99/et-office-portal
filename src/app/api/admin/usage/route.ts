// app/api/admin/usage/route.ts
import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function json(status: number, body: any) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ensureAdminInit() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env vars.");
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function getBearerToken(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] || null;
}

function tsDaysAgo(days: number) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return Timestamp.fromMillis(ms);
}

export async function GET(req: Request) {
  try {
    ensureAdminInit();

    const token = getBearerToken(req);
    if (!token) return json(401, { error: "Missing Authorization: Bearer <idToken>" });

    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const db = getFirestore();

    // Admin gate (reads /users/{uid}.role)
    const meSnap = await db.collection("users").doc(uid).get();
    const role = meSnap.exists ? (meSnap.data() as any)?.role : null;
    if (role !== "admin") return json(403, { error: "Admin only" });

    const url = new URL(req.url);
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || "30")));
    const since = tsDaysAgo(days);

    // Pull sessions in range
    const snap = await db
      .collection("usageSessions")
      .where("lastActiveAt", ">=", since)
      .orderBy("lastActiveAt", "desc")
      .get();

    // --- Aggregations ---
    type RepAgg = {
      uid: string;
      salesmanId: string | null;
      name: string | null;
      activeMs: number;
      exports: number;
      sessions: number;

      // ✅ new: per rep per page breakdown
      pages: Record<
        string,
        { path: string; activeMs: number; sessions: number; exports: number }
      >;
    };

    const reps = new Map<string, RepAgg>(); // key = salesmanId || uid
    const pageAgg: Record<string, { path: string; activeMs: number; sessions: number; exports: number }> =
      {};

    for (const doc of snap.docs) {
      const d = doc.data() as any;

      const repUid = String(d.uid || "");
      if (!repUid) continue;

      const salesmanId = d.salesmanId ? String(d.salesmanId) : null;
      const name = d.name ? String(d.name) : null;

      const key = salesmanId || repUid;

      const activeMs = Number(d.activeMs || 0) || 0;
      const path = String(d.path || "");
      const lastKind = String(d.lastKind || "");
      const isExport = lastKind === "export";

      if (!reps.has(key)) {
        reps.set(key, {
          uid: repUid,
          salesmanId,
          name,
          activeMs: 0,
          exports: 0,
          sessions: 0,
          pages: {},
        });
      }

      const r = reps.get(key)!;
      r.activeMs += activeMs;
      r.sessions += 1;
      if (isExport) r.exports += 1;

      if (path) {
        // overall page totals
        if (!pageAgg[path]) pageAgg[path] = { path, activeMs: 0, sessions: 0, exports: 0 };
        pageAgg[path].activeMs += activeMs;
        pageAgg[path].sessions += 1;
        if (isExport) pageAgg[path].exports += 1;

        // per-rep per-page totals
        if (!r.pages[path]) r.pages[path] = { path, activeMs: 0, sessions: 0, exports: 0 };
        r.pages[path].activeMs += activeMs;
        r.pages[path].sessions += 1;
        if (isExport) r.pages[path].exports += 1;
      }
    }

    const hoursPerRep = Array.from(reps.values())
      .map((r) => ({
        salesmanId: r.salesmanId,
        uid: r.uid,
        name: r.name,
        hours: Math.round((r.activeMs / (1000 * 60 * 60)) * 100) / 100,
        activeMs: r.activeMs,
        sessions: r.sessions,
      }))
      .sort((a, b) => b.activeMs - a.activeMs);

    const exportsPerRep = Array.from(reps.values())
      .map((r) => ({
        salesmanId: r.salesmanId,
        uid: r.uid,
        name: r.name,
        exports: r.exports,
      }))
      .sort((a, b) => b.exports - a.exports);

    const pageUsage = Object.values(pageAgg)
      .map((p) => ({
        path: p.path,
        hours: Math.round((p.activeMs / (1000 * 60 * 60)) * 100) / 100,
        activeMs: p.activeMs,
        sessions: p.sessions,
        exports: p.exports,
      }))
      .sort((a, b) => b.activeMs - a.activeMs);

    // ✅ NEW: page breakdown per rep
    const pageUsageByRep = Array.from(reps.values())
      .map((r) => {
        const pages = Object.values(r.pages)
          .map((p) => ({
            path: p.path,
            hours: Math.round((p.activeMs / (1000 * 60 * 60)) * 100) / 100,
            activeMs: p.activeMs,
            sessions: p.sessions,
            exports: p.exports,
          }))
          .sort((a, b) => b.activeMs - a.activeMs);

        return {
          salesmanId: r.salesmanId,
          uid: r.uid,
          name: r.name,
          hours: Math.round((r.activeMs / (1000 * 60 * 60)) * 100) / 100,
          activeMs: r.activeMs,
          sessions: r.sessions,
          exports: r.exports,
          pages,
        };
      })
      .sort((a, b) => b.activeMs - a.activeMs);

    return json(200, {
      range: { days },
      totals: {
        sessions: snap.size,
        activeHours:
          Math.round(
            (Array.from(reps.values()).reduce((s, r) => s + r.activeMs, 0) /
              (1000 * 60 * 60)) *
              100
          ) / 100,
      },
      hoursPerRep,
      exportsPerRep,
      pageUsage,
      pageUsageByRep, // ✅ added
    });
  } catch (e: any) {
    console.error("admin usage dashboard error:", e);
    return json(500, { error: e?.message ?? String(e) });
  }
}
