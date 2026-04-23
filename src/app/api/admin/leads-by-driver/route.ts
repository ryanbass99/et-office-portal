import { NextRequest, NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

type LeadDoc = {
  salesmanId?: string;
  createdAt?: any;
  status?: string;
};

type UserDoc = {
  name?: string;
  displayName?: string;
  email?: string;
  salesperson?: string;
  role?: string;
};

const adminApp =
  getApps()[0] ||
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

function toMillis(value: any): number | null {
  if (!value) return null;

  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();

  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof value?._seconds === "number") {
    return value._seconds * 1000;
  }

  if (typeof value?.seconds === "number") {
    return value.seconds * 1000;
  }

  return null;
}

async function getUserFromBearer(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  try {
    const decoded = await adminAuth.verifyIdToken(match[1]);
    return decoded;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const decoded = await getUserFromBearer(req);
    if (!decoded?.uid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requesterSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const requesterRole = String(requesterSnap.data()?.role || "").toLowerCase();

    if (requesterRole !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    if (!start || !end) {
      return NextResponse.json(
        { error: "start and end are required in YYYY-MM-DD format" },
        { status: 400 }
      );
    }

    const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
    const endMs = new Date(`${end}T23:59:59.999Z`).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    const leadsSnap = await adminDb.collection("salesLeads").get();

    const totals = new Map<
      string,
      {
        salesmanId: string;
        entered: number;
        open: number;
        closed_no_lead: number;
        closed_account: number;
      }
    >();

    for (const doc of leadsSnap.docs) {
      const data = doc.data() as LeadDoc;
      const createdMs = toMillis(data.createdAt);

      if (createdMs == null) continue;
      if (createdMs < startMs || createdMs > endMs) continue;

      const salesmanId = String(data.salesmanId || "").trim();
      if (!salesmanId) continue;

      if (!totals.has(salesmanId)) {
        totals.set(salesmanId, {
          salesmanId,
          entered: 0,
          open: 0,
          closed_no_lead: 0,
          closed_account: 0,
        });
      }

      const row = totals.get(salesmanId)!;
      row.entered += 1;

      const status = String(data.status || "open").toLowerCase();
      if (status === "closed_no_lead") row.closed_no_lead += 1;
      else if (status === "closed_account") row.closed_account += 1;
      else row.open += 1;
    }

    const userIds = [...totals.keys()];
    const userDocs = await Promise.all(
      userIds.map((uid) => adminDb.collection("users").doc(uid).get())
    );

    const usersMap = new Map<string, UserDoc>();
    userDocs.forEach((snap) => {
      if (snap.exists) usersMap.set(snap.id, snap.data() as UserDoc);
    });

    const rows = [...totals.values()]
      .map((row) => {
        const user = usersMap.get(row.salesmanId);
        return {
          salesmanId: row.salesmanId,
          name: user?.name || user?.displayName || user?.email || row.salesmanId,
          email: user?.email || "",
          salesperson: user?.salesperson || "",
          entered: row.entered,
          open: row.open,
          closed_no_lead: row.closed_no_lead,
          closed_account: row.closed_account,
        };
      })
      .sort((a, b) => b.entered - a.entered || a.name.localeCompare(b.name));

    return NextResponse.json({
      start,
      end,
      totalLeads: rows.reduce((sum, r) => sum + r.entered, 0),
      rows,
    });
  } catch (error: any) {
    console.error("GET /api/admin/leads-by-driver error:", error);
    return NextResponse.json(
      { error: error?.message || "Server error" },
      { status: 500 }
    );
  }
}