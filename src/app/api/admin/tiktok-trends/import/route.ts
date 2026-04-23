import { NextRequest, NextResponse } from "next/server";
import { getApps, cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

type TrendCategory =
  | "novelty_gm"
  | "toys"
  | "novelty_food"
  | "tech_accessories";

type NormalizedTrend = {
  title: string;
  keyword: string;
  category: TrendCategory;
  velocity: "Low" | "Medium" | "High";
  source: string;
  fitScore: number;
  notes: string;
};

type WatchlistDoc = {
  title?: string;
  keyword: string;
  category: TrendCategory;
  active?: boolean;
  fitScore?: number;
  notes?: string;
};

function initAdmin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
}

async function getAdminUidFromRequest(req: NextRequest) {
  initAdmin();

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const idToken = authHeader.replace("Bearer ", "").trim();
  const decoded = await getAuth().verifyIdToken(idToken);

  const db = getFirestore();
  const userSnap = await db.collection("users").doc(decoded.uid).get();

  if (!userSnap.exists) {
    throw new Error("User record not found");
  }

  const role = userSnap.data()?.role;
  if (role !== "admin" && role !== "Admin") {
    throw new Error("Not authorized");
  }

  return decoded.uid;
}

function cleanStr(v: unknown) {
  return String(v ?? "").trim();
}

function cleanKeyword(v: unknown) {
  const raw = cleanStr(v).toLowerCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw.replace(/^#+/, "")}`;
}

function titleFromKeyword(keyword: string) {
  return keyword
    .replace(/^#/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function buildTrendFromWatchlistDoc(
  doc: WatchlistDoc,
  index: number
): NormalizedTrend | null {
  const keyword = cleanKeyword(doc.keyword);
  if (!keyword) return null;

  const title = cleanStr(doc.title) || titleFromKeyword(keyword);
  const fitScore = Number(doc.fitScore ?? 70);

  return {
    title,
    keyword,
    category: doc.category,
    velocity: index < 3 ? "High" : index < 6 ? "Medium" : "Low",
    source: "tiktok_watchlist",
    fitScore,
    notes: cleanStr(doc.notes) || "Imported from approved watchlist",
  };
}

async function fetchWatchlist(): Promise<NormalizedTrend[]> {
  initAdmin();
  const db = getFirestore();

  const snap = await db
    .collection("tiktokTrendWatchlist")
    .where("active", "==", true)
    .get();

  if (snap.empty) {
    throw new Error("No active watchlist items found");
  }

  const items = snap.docs
    .map((d) => d.data() as WatchlistDoc)
    .map((item, index) => buildTrendFromWatchlistDoc(item, index))
    .filter(Boolean) as NormalizedTrend[];

  if (!items.length) {
    throw new Error("No valid watchlist items found");
  }

  return items;
}

export async function POST(req: NextRequest) {
  try {
    const importedBy = await getAdminUidFromRequest(req);

    initAdmin();
    const db = getFirestore();

    const incomingTrends = await fetchWatchlist();

    let created = 0;
    let skipped = 0;

    for (const trend of incomingTrends) {
      const keyword = cleanKeyword(trend.keyword);

      const existing = await db
        .collection("tiktokTrendCandidates")
        .where("keyword", "==", keyword)
        .limit(1)
        .get();

      if (!existing.empty) {
        skipped++;
        continue;
      }

      await db.collection("tiktokTrendCandidates").add({
        title: trend.title,
        keyword,
        category: trend.category,
        status: "new",
        velocity: trend.velocity,
        source: trend.source,
        fitScore: trend.fitScore,
        notes: trend.notes,
        importedBy,
        createdAt: Timestamp.now(),
      });

      created++;
    }

    return NextResponse.json({
      ok: true,
      message: "Import complete",
      fetched: incomingTrends.length,
      created,
      skipped,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Import failed",
      },
      { status: 401 }
    );
  }
}