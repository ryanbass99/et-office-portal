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

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function ensureAdmin() {
  if (getApps().length) return;

  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function startOfDayISO(iso: string) {
  return new Date(iso + "T00:00:00.000");
}
function endOfDayISO(iso: string) {
  return new Date(iso + "T23:59:59.999");
}

export async function GET(req: Request) {
  try {
    ensureAdmin();

    const url = new URL(req.url);
    const start = url.searchParams.get("start"); // YYYY-MM-DD
    const end = url.searchParams.get("end");     // YYYY-MM-DD
    const daysParam = url.searchParams.get("days");

    // Auth: Bearer token
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) return json(401, { error: "Missing Authorization Bearer token" });

    const token = m[1];
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const db = getFirestore();

    // Admin check
    const userSnap = await db.collection("users").doc(uid).get();
    const role = userSnap.exists ? (userSnap.data() as any)?.role : null;
    if (role !== "admin") return json(403, { error: "Forbidden" });

    // Determine date range
    let startDate: Date;
    let endDate: Date;

    if (start && end) {
      startDate = startOfDayISO(start);
      endDate = endOfDayISO(end);
    } else {
      // Backwards compatible: last N days ending today
      const days = Math.max(1, Math.min(365, Number(daysParam) || 30));
      const now = new Date();
      endDate = now;
      startDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    }

    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);

    // ---- Data model assumptions (matches your portal work so far) ----
    // usageSessions: documents with { startedAt, endedAt, durationSec, uid, path, salesmanId?, name? }
    // usageEvents: documents with { createdAt, uid, type: "export", path, salesmanId?, name? }
    //
    // If your field names differ, adjust them here (NOT on the client).

    const sessionsSnap = await db
      .collection("usageSessions")
      .where("startedAt", ">=", startTs)
      .where("startedAt", "<=", endTs)
      .get();

    const exportsSnap = await db
      .collection("usageEvents")
      .where("createdAt", ">=", startTs)
      .where("createdAt", "<=", endTs)
      .where("type", "==", "export")
      .get();

    // Aggregate
    const repAgg = new Map<string, any>(); // uid -> { uid, name, salesmanId, sessions, hours, exports, pages: Map }
    const pageAgg = new Map<string, any>(); // path -> { path, sessions, hours, exports }

    function ensureRep(uidKey: string, base: any) {
      if (!repAgg.has(uidKey)) {
        repAgg.set(uidKey, {
          uid: uidKey,
          name: base?.name || "",
          salesmanId: base?.salesmanId || base?.salesperson || "",
          sessions: 0,
          hours: 0,
          exports: 0,
          pages: new Map<string, any>(),
        });
      } else {
        const r = repAgg.get(uidKey);
        if (!r.name && base?.name) r.name = base.name;
        if (!r.salesmanId && (base?.salesmanId || base?.salesperson)) r.salesmanId = base.salesmanId || base.salesperson;
      }
      return repAgg.get(uidKey);
    }

    function ensurePage(map: Map<string, any>, path: string) {
      if (!map.has(path)) map.set(path, { path, sessions: 0, hours: 0, exports: 0 });
      return map.get(path);
    }

    // Sessions -> sessions + hours
    for (const doc of sessionsSnap.docs) {
      const d: any = doc.data();
      const uidKey = String(d.uid || "");
      const path = String(d.path || "");
      if (!uidKey) continue;

      const durationSec = Number(d.durationSec ?? d.durationSeconds ?? 0) || 0;
      const hours = durationSec / 3600;

      const rep = ensureRep(uidKey, d);
      rep.sessions += 1;
      rep.hours += hours;

      if (path) {
        const p = ensurePage(rep.pages, path);
        p.sessions += 1;
        p.hours += hours;

        const pg = ensurePage(pageAgg, path);
        pg.sessions += 1;
        pg.hours += hours;
      }
    }

    // Exports
    for (const doc of exportsSnap.docs) {
      const d: any = doc.data();
      const uidKey = String(d.uid || "");
      const path = String(d.path || "");
      if (!uidKey) continue;

      const rep = ensureRep(uidKey, d);
      rep.exports += 1;

      if (path) {
        const p = ensurePage(rep.pages, path);
        p.exports += 1;

        const pg = ensurePage(pageAgg, path);
        pg.exports += 1;
      }
    }

    const totals = {
      sessions: sessionsSnap.size,
      activeHours: Number(
        Array.from(repAgg.values()).reduce((sum: number, r: any) => sum + (r.hours || 0), 0).toFixed(2)
      ),
    };

    const hoursPerRep = Array.from(repAgg.values())
      .map((r: any) => ({
        uid: r.uid,
        name: r.name || "-",
        salesmanId: r.salesmanId || "-",
        hours: Number((r.hours || 0).toFixed(2)),
        sessions: r.sessions || 0,
      }))
      .sort((a, b) => b.hours - a.hours);

    const exportsPerRep = Array.from(repAgg.values())
      .map((r: any) => ({
        uid: r.uid,
        name: r.name || "-",
        salesmanId: r.salesmanId || "-",
        exports: r.exports || 0,
      }))
      .sort((a, b) => b.exports - a.exports);

    const pageUsage = Array.from(pageAgg.values())
      .map((p: any) => ({
        path: p.path,
        hours: Number((p.hours || 0).toFixed(2)),
        sessions: p.sessions || 0,
        exports: p.exports || 0,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    const pageUsageByRep = Array.from(repAgg.values()).map((r: any) => ({
      uid: r.uid,
      name: r.name || "-",
      salesmanId: r.salesmanId || "-",
      pages: Array.from(r.pages.values())
        .map((p: any) => ({
          path: p.path,
          hours: Number((p.hours || 0).toFixed(2)),
          sessions: p.sessions || 0,
          exports: p.exports || 0,
        }))
        .sort((a: any, b: any) => b.sessions - a.sessions),
    }));

    return json(200, {
      range: { start: startDate.toISOString(), end: endDate.toISOString() },
      totals,
      hoursPerRep,
      exportsPerRep,
      pageUsage,
      pageUsageByRep,
    });
  } catch (e: any) {
    return json(500, { error: e?.message || "Server error" });
  }
}
