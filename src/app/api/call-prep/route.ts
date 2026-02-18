import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  // Firestore Timestamp
  if (typeof v?.toDate === "function") return v.toDate();
  // ISO string or other
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function diffDays(a: Date, b: Date) {
  const ms = a.getTime() - b.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function inc(map: Map<string, number>, key: string, by: number) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function startOfYear(year: number) {
  return new Date(year, 0, 1, 0, 0, 0, 0);
}

function topFromMap(
  map: Map<string, number>,
  n: number,
  descMap: Map<string, string>
) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([itemCode, qty]) => ({
      itemCode,
      itemCodeDesc: descMap.get(itemCode) ?? null,
      qty,
    }));
}

if (!getApps().length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const customerNo = (searchParams.get("customerNo") || "").trim();

    if (!customerNo) {
      return NextResponse.json({ error: "Missing customerNo" }, { status: 400 });
    }

    const db = getFirestore();

    // ---- 1) Load customer ----
    const custRef = db.collection("customers").doc(customerNo);
    const custSnap = await custRef.get();

    if (!custSnap.exists) {
      return NextResponse.json(
        { error: `Customer not found: ${customerNo}` },
        { status: 404 }
      );
    }

    const c = custSnap.data() || {};

    // ---- 2) Load last 20 invoices for this customer (by invoiceDate desc) ----
    const invQ = db
      .collection("invoices")
      .where("customerNo", "==", customerNo)
      .orderBy("invoiceDate", "desc")
      .limit(20);

    const invSnap = await invQ.get();
    const invoices = invSnap.docs.map((d) => {
      const data = d.data();
      const invoiceDate = toDate(data.invoiceDate);
      return {
        id: d.id,
        invoiceNo: data.invoiceNo ?? d.id,
        invoiceDate: invoiceDate ? invoiceDate.toISOString() : null,
        invoiceTotal: Number(data.invoiceTotal ?? 0), // fine (0) for now
        salespersonNo: data.salespersonNo ?? null,
      };
    });

    const now = new Date();
    const lastInv = invoices[0] || null;
    const lastInvDate = lastInv?.invoiceDate
      ? new Date(lastInv.invoiceDate)
      : null;

    const daysSinceLastInvoice = lastInvDate ? diffDays(now, lastInvDate) : null;

    // Avg days between last 5 invoices
    const last5Dates = invoices
      .slice(0, 5)
      .map((x) => (x.invoiceDate ? new Date(x.invoiceDate) : null))
      .filter(Boolean) as Date[];

    let avgDaysBetweenLast5: number | null = null;
    if (last5Dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 0; i < last5Dates.length - 1; i++) {
        gaps.push(diffDays(last5Dates[i], last5Dates[i + 1]));
      }
      avgDaysBetweenLast5 = Math.round(
        gaps.reduce((a, b) => a + b, 0) / gaps.length
      );
    }

    // ---- 3) YTD placeholders (invoiceTotal currently 0) ----
    const y2025Start = startOfYear(2025).getTime();
    const y2026Start = startOfYear(2026).getTime();
    const nowMs = now.getTime();

    let ytd2025 = 0;
    let ytd2026 = 0;

    for (const inv of invoices) {
      if (!inv.invoiceDate) continue;
      const t = new Date(inv.invoiceDate).getTime();
      if (t >= y2025Start && t <= nowMs) ytd2025 += inv.invoiceTotal;
      if (t >= y2026Start && t <= nowMs) ytd2026 += inv.invoiceTotal;
    }

    // ---- 4) Item intelligence by QTY + itemCodeDesc ----
    const cut90 = daysAgo(90);
    const cut365 = daysAgo(365);

    const invForItemsQ = db
      .collection("invoices")
      .where("customerNo", "==", customerNo)
      .orderBy("invoiceDate", "desc")
      .limit(60);

    const invForItemsSnap = await invForItemsQ.get();

    type InvLite = { invoiceNo: string; invoiceDate: Date | null };
    const invForItems: InvLite[] = invForItemsSnap.docs.map((d) => {
      const data = d.data();
      return {
        invoiceNo: String(data.invoiceNo ?? d.id),
        invoiceDate: toDate(data.invoiceDate),
      };
    });

    const qty365 = new Map<string, number>();
    const qtyAll = new Map<string, number>();
    const last90Set = new Set<string>();
    const priorQty = new Map<string, number>();
    const descByItem = new Map<string, string>();

    for (const inv of invForItems) {
      const invDate = inv.invoiceDate;

      const isLast90 = invDate ? invDate >= cut90 : false;
      const isLast365 = invDate ? invDate >= cut365 : false;
      const isPriorWindow =
        invDate ? invDate < cut90 && invDate >= cut365 : false;

      const linesSnap = await db
        .collection("invoices")
        .doc(inv.invoiceNo)
        .collection("lines")
        .get();

      for (const ld of linesSnap.docs) {
        const line = ld.data() || {};
        const itemCode = String(line.itemCode ?? "").trim();
        if (!itemCode) continue;

        // capture description once (first non-empty wins)
        const itemCodeDesc = String(line.itemCodeDesc ?? "").trim();
        if (itemCodeDesc && !descByItem.has(itemCode)) {
          descByItem.set(itemCode, itemCodeDesc);
        }

        // qty-only signals (use absolute because you have negatives)
        const rawQty = Number(line.quantityShipped ?? 0);
        const qty = Math.abs(rawQty);
        if (!qty) continue;

        inc(qtyAll, itemCode, qty);
        if (isLast365) inc(qty365, itemCode, qty);

        if (isLast90) last90Set.add(itemCode);
        if (isPriorWindow) inc(priorQty, itemCode, qty);
      }
    }

    const topItemsLast365 = topFromMap(qty365, 10, descByItem);
    const topItemsAllTime = topFromMap(qtyAll, 10, descByItem);

    const stoppedBuying = [...priorQty.entries()]
      .filter(([itemCode]) => !last90Set.has(itemCode))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([itemCode, qty]) => ({
        itemCode,
        itemCodeDesc: descByItem.get(itemCode) ?? null,
        qty,
      }));

    // ✅ NEW: Pitch Next (data-driven, qty-only)
    // Priority:
    // 1) stoppedBuying
    // 2) all-time top items that are not in last 90 days
    const pitchNext: Array<{
      itemCode: string;
      itemCodeDesc: string | null;
      qty: number;
      reason: "Stopped buying" | "All-time mover (not recent)";
    }> = [];

    const seen = new Set<string>();

    for (const s of stoppedBuying) {
      if (pitchNext.length >= 10) break;
      if (!s.itemCode || seen.has(s.itemCode)) continue;
      seen.add(s.itemCode);
      pitchNext.push({
        itemCode: s.itemCode,
        itemCodeDesc: s.itemCodeDesc ?? null,
        qty: s.qty,
        reason: "Stopped buying",
      });
    }

    // Add gap items from all-time movers (not in last 90 days)
    for (const a of topItemsAllTime) {
      if (pitchNext.length >= 10) break;
      if (!a.itemCode || seen.has(a.itemCode)) continue;
      if (last90Set.has(a.itemCode)) continue;

      seen.add(a.itemCode);
      pitchNext.push({
        itemCode: a.itemCode,
        itemCodeDesc: a.itemCodeDesc ?? null,
        qty: a.qty,
        reason: "All-time mover (not recent)",
      });
    }

    const itemIntel = {
      topItemsLast365,
      topItemsAllTime,
      stoppedBuying,
      pitchNext, // ✅ NEW
      last90UniqueItemCount: last90Set.size,
      invoicesScannedForItems: invForItems.length,
    };

    return NextResponse.json({
      customerNo,
      customer: {
        customerName: c.customerName ?? null,
        address1: c.address1 ?? c.addressLine1 ?? null,
        city: c.city ?? null,
        state: c.state ?? null,
        phone: c.phone ?? null,
        buyerEmail: c.buyerEmail ?? null,
        creditHold: c.creditHold ?? null,
        creditHoldBool: c.creditHoldBool ?? false,
        status: c.status ?? c.customerStatus ?? null,
        salespersonNo: c.salespersonNo ?? null,
      },
      stats: {
        lastInvoice: lastInv,
        daysSinceLastInvoice,
        avgDaysBetweenLast5,
        ytdSales2025: Math.round(ytd2025 * 100) / 100,
        ytdSales2026: Math.round(ytd2026 * 100) / 100,
        invoicesReturned: invoices.length,
      },
      invoices,
      itemIntel,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to build call prep data" },
      { status: 500 }
    );
  }
}
