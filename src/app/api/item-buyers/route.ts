import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin env vars. Need FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY."
    );
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function toNumber(v: any): number {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/[$,]/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function tierFromSales25(sales25: number): "A" | "B" | "C" | "D" {
  if (sales25 >= 10000) return "A";
  if (sales25 >= 5000) return "B";
  if (sales25 >= 2000) return "C";
  return "D";
}

type Buyer = {
  customerNo: string;
  name?: string;
  city?: string;
  state?: string;
  tier?: "A" | "B" | "C" | "D";
  sales25?: number;
  salespersonNo?: string;

  // Optional: populated when available on the account
  buyerEmail?: string | null;
  buyerName?: string | null;
};

function normRep(v: any): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  return (digits || s).padStart(4, "0");
}

function pickBuyerEmail(d: any): string | null {
  const raw =
    d?.buyerEmail ??
    d?.buyersEmail ??
    d?.buyer_email ??
    d?.buyerEmailAddress ??
    d?.buyeremail ??
    null;

  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length ? v : null;
}

function pickBuyerName(d: any): string | null {
  const raw = d?.buyerName ?? d?.buyersName ?? d?.buyer_name ?? null;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length ? v : null;
}

function pickItemCodeDesc(d: any): string | null {
  const raw =
    d?.itemCodeDesc ??
    d?.ItemCodeDesc ??
    d?.item_code_desc ??
    d?.description ??
    d?.itemDescription ??
    d?.desc ??
    null;

  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length ? v : null;
}

async function lookupItemDescription(
  db: FirebaseFirestore.Firestore,
  itemCode: string,
  linesSnap?: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>
): Promise<string | null> {
  const code = String(itemCode || "").trim();
  if (!code) return null;

  // ✅ Fast path: many Sage exports include itemCodeDesc directly on the invoice line
  // If it's present, use it (no extra reads).
  if (linesSnap && !linesSnap.empty) {
    for (const doc of linesSnap.docs.slice(0, 25)) {
      const desc = pickItemCodeDesc(doc.data());
      if (desc) return desc;
    }
  }

  // Try doc id match first
  const byId = await db.collection("items").doc(code).get();
  if (byId.exists) {
    const desc = pickItemCodeDesc(byId.data());
    if (desc) return desc;
  }

  // Fallback: query field match
  const q = await db.collection("items").where("itemCode", "==", code).limit(1).get();
  if (!q.empty) {
    const desc = pickItemCodeDesc(q.docs[0].data());
    if (desc) return desc;
  }

  // Fallback: your item docs are often stored as "K604__0010" etc.
  // Try prefix match on documentId()
  const start = code + "__";
  const byIdPrefix = await db
    .collection("items")
    .where(FieldPath.documentId(), ">=", start)
    .where(FieldPath.documentId(), "<", start + "\uf8ff")
    .limit(1)
    .get();
  if (!byIdPrefix.empty) {
    const desc = pickItemCodeDesc(byIdPrefix.docs[0].data());
    if (desc) return desc;
  }

  // Fallback: prefix match on itemCode field
  const byFieldPrefix = await db
    .collection("items")
    .where("itemCode", ">=", start)
    .where("itemCode", "<", start + "\uf8ff")
    .limit(1)
    .get();
  if (!byFieldPrefix.empty) {
    const desc = pickItemCodeDesc(byFieldPrefix.docs[0].data());
    if (desc) return desc;
  }

  return null;
}

export async function GET(req: Request) {
  try {
    initAdmin();
    const db = getFirestore();

    const { searchParams } = new URL(req.url);

    const itemCode = (searchParams.get("itemCode") || "").trim();
    const onePerTier = (searchParams.get("onePerTier") || "") === "1";

    const selectedTierParam = (searchParams.get("selectedTier") || "")
      .trim()
      .toUpperCase();
    const selectedTier =
      selectedTierParam === "A" ||
      selectedTierParam === "B" ||
      selectedTierParam === "C" ||
      selectedTierParam === "D"
        ? (selectedTierParam as "A" | "B" | "C" | "D")
        : null;

    const oppCount = Math.min(Number(searchParams.get("oppCount") || "4"), 25);

    // rep filter
    const repNo = normRep(searchParams.get("salespersonNo"));

    if (!itemCode) {
      return NextResponse.json({ buyers: [], opportunities: [] });
    }

    // -------------------------------
    // 1) Find line-items for this itemCode
    // IMPORTANT: your line docs do NOT have customerNo,
    // so we must go line -> invoice -> customerNo.
    // -------------------------------

    // Try exact match first, then prefix match if needed
    let linesSnap = await db
      .collectionGroup("lines")
      .where("itemCode", "==", itemCode)
      .limit(1000)
      .get();

    if (linesSnap.empty && !itemCode.includes("__")) {
      // prefix match: itemCode starts with "K233"
      linesSnap = await db
        .collectionGroup("lines")
        .where("itemCode", ">=", itemCode)
        .where("itemCode", "<", itemCode + "\uf8ff")
        .limit(1000)
        .get();
    }

    if (linesSnap.empty) {
      return NextResponse.json({ buyers: [], opportunities: [] });
    }

    // collect invoice ids
    const invoiceIds = new Set<string>();
    for (const doc of linesSnap.docs) {
      const d = doc.data() as any;

      // Prefer stored invoiceNo if present
      const inv = String(d?.invoiceNo ?? "").trim();

      if (inv) {
        invoiceIds.add(inv);
      } else {
        // fallback: parent path /invoices/{invoiceId}/lines/{lineId}
        const invId = doc.ref.parent.parent?.id;
        if (invId) invoiceIds.add(String(invId));
      }
    }

    const invoiceIdList = Array.from(invoiceIds);
    if (invoiceIdList.length === 0) {
      return NextResponse.json({ buyers: [], opportunities: [] });
    }

    // 2) Pull invoice headers to get customerNo
    const invoiceRefs = invoiceIdList.slice(0, 500).map((id) =>
      db.collection("invoices").doc(id)
    );
    const invoiceSnaps = await db.getAll(...invoiceRefs);

    const buyerIds = new Set<string>();
    for (const s of invoiceSnaps) {
      if (!s.exists) continue;
      const inv = s.data() as any;
      if (inv?.customerNo) buyerIds.add(String(inv.customerNo));
    }

    const buyerIdList = Array.from(buyerIds);
    if (buyerIdList.length === 0) {
      return NextResponse.json({ buyers: [], opportunities: [] });
    }

    // 3) Pull buyer customer docs
    const buyerRefs = buyerIdList.slice(0, 250).map((id) =>
      db.collection("customers").doc(id)
    );
    const buyerSnaps = await db.getAll(...buyerRefs);

    const buyersRawAll: Buyer[] = buyerSnaps
      .filter((s) => s.exists)
      .map((s) => {
        const data = s.data() as any;
        const sales25 = toNumber(data?.udf_25TotalSales);
        const state = (data?.stateUpper ?? data?.state ?? "").toString().trim();
        const salespersonNo = data?.salespersonNo ?? data?.salesperson ?? "";

        return {
          customerNo: s.id,
          name: data?.name ?? data?.customerName ?? data?.customer ?? "",
          city: data?.city ?? "",
          state,
          salespersonNo,
          sales25,
          tier: tierFromSales25(sales25),
          buyerEmail: pickBuyerEmail(data),
          buyerName: pickBuyerName(data),
        };
      });

    // ✅ filter buyers to rep (matches Customers page behavior)
    const buyersRaw = repNo
      ? buyersRawAll.filter((b) => normRep(b.salespersonNo) === repNo)
      : buyersRawAll;

    // one buyer per tier (highest sales25)
    let buyers: Buyer[] = buyersRaw;
    if (onePerTier) {
      const bestByTier = new Map<"A" | "B" | "C" | "D", Buyer>();
      for (const b of buyersRaw) {
        const t = b.tier ?? "D";
        const curr = bestByTier.get(t);
        const bSales = b.sales25 ?? 0;
        const cSales = curr?.sales25 ?? 0;
        if (!curr || bSales > cSales) bestByTier.set(t, b);
      }
      const order: Array<"A" | "B" | "C" | "D"> = ["A", "B", "C", "D"];
      buyers = order.map((t) => bestByTier.get(t)).filter(Boolean) as Buyer[];
    }

    // 4) Opportunities for selected tier
    let opportunities: Buyer[] = [];

    if (selectedTier) {
      // ✅ IMPORTANT: only scan THIS REP'S customers (not global first 1500)
      // Also check salespersonNo2 because you have that field in customers.
      let repCustomers: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData> | null =
        null;

      if (repNo) {
        // Firestore doesn't allow OR without a special query, so do two queries and merge.
        const q1 = db.collection("customers").where("salespersonNo", "==", repNo).limit(2500);
        const q2 = db.collection("customers").where("salespersonNo2", "==", repNo).limit(2500);

        const [s1, s2] = await Promise.all([q1.get(), q2.get()]);

        const seen = new Set<string>();
        const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];

        for (const d of s1.docs) {
          if (!seen.has(d.id)) {
            seen.add(d.id);
            docs.push(d);
          }
        }
        for (const d of s2.docs) {
          if (!seen.has(d.id)) {
            seen.add(d.id);
            docs.push(d);
          }
        }

        // fake a "snap" list we can iterate
        const list: Buyer[] = [];
        for (const doc of docs) {
          const id = doc.id;
          if (buyerIds.has(id)) continue;

          const data = doc.data() as any;
          const sales25 = toNumber(data?.udf_25TotalSales);
          const computedTier = tierFromSales25(sales25);
          if (computedTier !== selectedTier) continue;

          list.push({
            customerNo: id,
            name: data?.name ?? data?.customerName ?? data?.customer ?? "",
            city: data?.city ?? "",
            state: (data?.stateUpper ?? data?.state ?? "").toString().trim(),
            salespersonNo: data?.salespersonNo ?? data?.salesperson ?? "",
            sales25,
            tier: computedTier,
            buyerEmail: pickBuyerEmail(data),
            buyerName: pickBuyerName(data),
          });
        }

        opportunities = list
          .sort((a, b) => (b.sales25 ?? 0) - (a.sales25 ?? 0))
          .slice(0, oppCount);
      } else {
        // no rep filter: fallback to global sample (original behavior)
        const snap = await db.collection("customers").limit(2500).get();
        const list: Buyer[] = [];

        for (const doc of snap.docs) {
          const id = doc.id;
          if (buyerIds.has(id)) continue;

          const data = doc.data() as any;
          const sales25 = toNumber(data?.udf_25TotalSales);
          const computedTier = tierFromSales25(sales25);
          if (computedTier !== selectedTier) continue;

          list.push({
            customerNo: id,
            name: data?.name ?? data?.customerName ?? data?.customer ?? "",
            city: data?.city ?? "",
            state: (data?.stateUpper ?? data?.state ?? "").toString().trim(),
            salespersonNo: data?.salespersonNo ?? data?.salesperson ?? "",
            sales25,
            tier: computedTier,
            buyerEmail: pickBuyerEmail(data),
            buyerName: pickBuyerName(data),
          });
        }

        opportunities = list
          .sort((a, b) => (b.sales25 ?? 0) - (a.sales25 ?? 0))
          .slice(0, oppCount);
      }
    }

    const itemDescription = await lookupItemDescription(db, itemCode, linesSnap);

    return NextResponse.json({
      buyers,
      opportunities,
      itemDescription,
      meta: {
        buyerCount: buyers.length,
        opportunityCount: opportunities.length,
        onePerTier,
        selectedTier,
        salespersonNo: repNo || null,
        lineCount: linesSnap.size,
        invoiceCount: invoiceIdList.length,
      },
    });
  } catch (e: any) {
    console.error("item-buyers error:", e);
    return NextResponse.json(
      { error: e?.message || String(e), code: e?.code, details: e?.details },
      { status: 500 }
    );
  }
}
