import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const VERSION = "USAGE_ROUTE_V6_RAW_HOURS+MINUTES_2026-02-23";

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
  // prefer activeMs if present
  const activeMs = Number(d.activeMs ?? d.activeMS ?? 0) || 0;
  if (activeMs > 0) return activeMs;

  // fallback to endedAt - startedAt (or lastActiveAt)
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
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const daysParam = url.searchParams.get("days");

    const authHeader =
      req.headers.get("authorization") ||
      req.headers.get("Authorization") ||
      "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      const res = NextResponse.json({ error: "Missing Authorization Bearer token", version: VERSION }, { status: 401 });
      res.headers.set("X-Usage-Version", VERSION);
      return res;
    }

    const token = m[1];
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const db = getFirestore();

    const userSnap = await db.collection("users").doc(uid).get();
    const role = userSnap.exists ? (userSnap.data() as any)?.role : null;
    if (role !== "admin") {
      const res = NextResponse.json({ error: "Forbidden", version: VERSION }, { status: 403 });
      res.headers.set("X-Usage-Version", VERSION);
      return res;
    }

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

    const totalMs = Array.from(repAgg.values()).reduce((sum, r) => sum + (r.ms || 0), 0);
    const totalHoursRaw = totalMs / 3600000;
    const totalMinutesRaw = totalMs / 60000;

    // ✅ Keep old keys your UI expects, but return RAW values so they don't round to 0
    const totals = {
      sessions: sessionsSnap.size,
      activeHours: totalHoursRaw,     // RAW (not rounded)
      activeMinutes: totalMinutesRaw, // extra
      activeMsTotal: totalMs,         // extra
    };

    const hoursPerRep = Array.from(repAgg.values())
      .map((r) => ({
        uid: r.uid,
        name: r.name || "-",
        salesmanId: r.salesmanId || "-",
        hours: (r.ms || 0) / 3600000,     // RAW
        minutes: (r.ms || 0) / 60000,     // extra
        sessions: r.sessions || 0,
      }))
      .sort((a, b) => b.hours - a.hours);

    const exportsPerRep = Array.from(repAgg.values())
      .map((r) => ({
        uid: r.uid,
        name: r.name || "-",
        salesmanId: r.salesmanId || "-",
        exports: r.exports || 0,
      }))
      .sort((a, b) => b.exports - a.exports);

    const pageUsage = Array.from(pageAgg.values())
      .map((p) => ({
        path: p.path,
        hours: (p.ms || 0) / 3600000,   // RAW
        minutes: (p.ms || 0) / 60000,   // extra
        sessions: p.sessions || 0,
        exports: p.exports || 0,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    const pageUsageByRep = Array.from(repAgg.values()).map((r) => ({
      uid: r.uid,
      name: r.name || "-",
      salesmanId: r.salesmanId || "-",
      pages: Array.from(r.pages.values())
        .map((p: any) => ({
          path: p.path,
          hours: (p.ms || 0) / 3600000,
          minutes: (p.ms || 0) / 60000,
          sessions: p.sessions || 0,
          exports: p.exports || 0,
        }))
        .sort((a: any, b: any) => b.sessions - a.sessions),
    }));

    const body = {
      version: VERSION,
      range: { start: startDate.toISOString(), end: endDate.toISOString() },
      totals,
      hoursPerRep,
      exportsPerRep,
      pageUsage,
      pageUsageByRep,
    };

    const res = NextResponse.json(body, { status: 200 });
    res.headers.set("X-Usage-Version", VERSION);
    return res;
  } catch (e: any) {
    const res = NextResponse.json({ error: e?.message || "Server error", version: VERSION }, { status: 500 });
    res.headers.set("X-Usage-Version", VERSION);
    return res;
  }
}