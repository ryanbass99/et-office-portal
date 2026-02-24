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

function tsToDateMaybe(v: any): Date | null {
  if (!v) return null;
  try {
    if (typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function computeSessionMs(d: any): number {
  // Prefer activeMs if present
  const activeMs =
    Number(
      d.activeMs ??
        d.activeMS ??
        d.activeMillis ??
        d.activeMilliseconds ??
        0
    ) || 0;

  if (activeMs > 0) return activeMs;

  // Fall back to endedAt - startedAt (wall clock)
  const started = tsToDateMaybe(d.startedAt);
  const ended = tsToDateMaybe(d.endedAt ?? d.lastActiveAt);

  if (started && ended) {
    const diff = ended.getTime() - started.getTime();
    if (diff > 0) return diff;
  }

  return 0;
}

export async function GET(req: Request) {
  try {
    ensureAdmin();

    const url = new URL(req.url);
    const start = url.searchParams.get("start"); // YYYY-MM-DD
    const end = url.searchParams.get("end"); // YYYY-MM-DD
    const daysParam = url.searchParams.get("days");

    const authHeader =
      req.headers.get("authorization") ||
      req.headers.get("Authorization") ||
      "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) return json(401, { error: "Missing Authorization Bearer token" });

    const token = m[1];
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const db = getFirestore();

    const userSnap = await db.collection("users").doc(uid).get();
    const role = userSnap.exists ? (userSnap.data() as any)?.role : null;
    if (role !== "admin") return json(403, { error: "Forbidden" });

    let startDate: Date;
    let endDate: Date;

    if (start && end) {
      startDate = startOfDayISO(start);
      endDate = endOfDayISO(end);
    } else {
      const days = Math.max(1, Math.min(365, Number(daysParam) || 30));
      const now = new Date();
      endDate = now;
      startDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    }

    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);

    const sessionsSnap = await db
      .collection("usageSessions")
      .where("endedAt", ">=", startTs)
      .where("endedAt", "<=", endTs)
      .get();

    const exportsSnap = await db
      .collection("usageEvents")
      .where("createdAt", ">=", startTs)
      .where("createdAt", "<=", endTs)
      .where("type", "==", "export")
      .get();

    const repAgg = new Map<string, any>();
    const pageAgg = new Map<string, any>();

    function ensureRep(uidKey: string, base: any) {
      if (!repAgg.has(uidKey)) {
        repAgg.set(uidKey, {
          uid: uidKey,
          name: base?.name || "",
          salesmanId: base?.salesmanId || base?.salesperson || "",
          sessions: 0,
          ms: 0,
          exports: 0,
          pages: new Map<string, any>(),
        });
      } else {
        const r = repAgg.get(uidKey);
        if (!r.name && base?.name) r.name = base.name;
        if (!r.salesmanId && (base?.salesmanId || base?.salesperson)) {
          r.salesmanId = base.salesmanId || base.salesperson;
        }
      }
      return repAgg.get(uidKey);
    }

    function ensurePage(map: Map<string, any>, path: string) {
      if (!map.has(path)) map.set(path, { path, sessions: 0, ms: 0, exports: 0 });
      return map.get(path);
    }

    // Sessions
    for (const doc of sessionsSnap.docs) {
      const d: any = doc.data();
      const uidKey = String(d.uid || "");
      const path = String(d.path || "");
      if (!uidKey) continue;

      const ms = computeSessionMs(d);

      const rep = ensureRep(uidKey, d);
      rep.sessions += 1;
      rep.ms += ms;

      if (path) {
        const p = ensurePage(rep.pages, path);
        p.sessions += 1;
        p.ms += ms;

        const pg = ensurePage(pageAgg, path);
        pg.sessions += 1;
        pg.ms += ms;
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
        ensurePage(rep.pages, path).exports += 1;
        ensurePage(pageAgg, path).exports += 1;
      }
    }

    const totalMs = Array.from(repAgg.values()).reduce(
      (sum: number, r: any) => sum + (r.ms || 0),
      0
    );

    const totals = {
      sessions: sessionsSnap.size,
      activeMsTotal: totalMs,
      activeMinutes: Number((totalMs / 1000 / 60).toFixed(2)),
      activeHours: Number((totalMs / 1000 / 60 / 60).toFixed(4)), // more precision
    };

    const hoursPerRep = Array.from(repAgg.values())
      .map((r: any) => ({
        uid: r.uid,
        name: r.name || "-",
        salesmanId: r.salesmanId || "-",
        minutes: Number(((r.ms || 0) / 1000 / 60).toFixed(2)),
        hours: Number(((r.ms || 0) / 1000 / 60 / 60).toFixed(4)),
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
        minutes: Number(((p.ms || 0) / 1000 / 60).toFixed(2)),
        hours: Number(((p.ms || 0) / 1000 / 60 / 60).toFixed(4)),
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
          minutes: Number(((p.ms || 0) / 1000 / 60).toFixed(2)),
          hours: Number(((p.ms || 0) / 1000 / 60 / 60).toFixed(4)),
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