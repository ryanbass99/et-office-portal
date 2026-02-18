"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, query, Timestamp, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useRouter } from "next/navigation";

/**
 * Company-wide: Top 5 items by sales in last 60 days.
 *
 * IMPORTANT:
 * - This component assumes you have a flat collection named "invoiceLines"
 * - Each doc should contain:
 *    - itemCode (string)  [or configure ITEM_FIELD]
 *    - invoiceDateTs (Timestamp)  [or configure DATE_FIELD]
 *    - extSales (number|string)   [or configure SALES_FIELD]
 *
 * If your fields/collection differ, change the CONFIG block below.
 */

// -----------------------------
// CONFIG (change these if your schema differs)
// -----------------------------
const CONFIG = {
  LINES_COLLECTION: "invoiceLines", // <-- if you store lines elsewhere, change this
  ITEM_FIELD: "itemCode",          // e.g. "itemCode" or "item"
  DATE_FIELD: "invoiceDateTs",     // Timestamp field
  SALES_FIELD: "extSales",         // e.g. "extSales" or "extendedAmount" or "sales"
};

const DAYS_BACK = 60;
const TOP_N = 5;

// Safety: we cap the scan. If you have more than this many lines in 60 days,
// we can paginate later.
const FETCH_LIMIT = 20000;

function toNumber(v: any) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/[$,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItem(v: any) {
  return String(v ?? "").trim().toUpperCase();
}

function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function TopItemsLast60DaysCard() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<
    { itemCode: string; sales: number; lines: number }[]
  >([]);

  const cutoffTs = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS_BACK);
    return Timestamp.fromDate(d);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setErr(null);
      setItems([]);

      try {
        const qy = query(
          collection(db, CONFIG.LINES_COLLECTION),
          where(CONFIG.DATE_FIELD, ">=", cutoffTs),
          limit(FETCH_LIMIT)
        );

        const snap = await getDocs(qy);

        const map = new Map<string, { sales: number; lines: number }>();

        for (const d of snap.docs) {
          const x = d.data() as any;
          const code = normalizeItem(x?.[CONFIG.ITEM_FIELD]);
          if (!code) continue;

          const sales = toNumber(x?.[CONFIG.SALES_FIELD]);
          const prev = map.get(code) ?? { sales: 0, lines: 0 };
          map.set(code, { sales: prev.sales + sales, lines: prev.lines + 1 });
        }

        const ranked = Array.from(map.entries())
          .map(([itemCode, v]) => ({ itemCode, sales: v.sales, lines: v.lines }))
          .sort((a, b) => b.sales - a.sales)
          .slice(0, TOP_N);

        if (!cancelled) setItems(ranked);
      } catch (e: any) {
        console.error("TopItemsLast60DaysCard error:", e);
        const hint =
          `Could not load "${CONFIG.LINES_COLLECTION}". ` +
          `If your sales lines live in a different collection or fields, update CONFIG in this component.`;
        if (!cancelled) setErr((e?.message ? `${e.message} — ` : "") + hint);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [cutoffTs]);

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;
  if (err) return <div className="text-sm text-red-600">{err}</div>;

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <div className="text-sm text-gray-600">No sales lines found in last {DAYS_BACK} days.</div>
      ) : (
        <div className="divide-y rounded border">
          {items.map((it) => (
            <button
              key={it.itemCode}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-blue-50 hover:border-blue-400 transition"
              onClick={() =>
                router.push(
                  `/customers?quick=whitespace&top50=1&item=${encodeURIComponent(
                    it.itemCode
                  )}`
                )
              }
              title="Click to see Top 50 accounts that have NOT bought this item (sorted by 2025 sales)"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-semibold text-blue-700 hover:underline">
                  {it.itemCode}
                </div>
                <div className="text-xs text-gray-500">
                  last {DAYS_BACK}d sales: <span className="font-medium text-gray-800">{money(it.sales)}</span>
                </div>
              </div>
              <div className="text-xs text-gray-500">
                lines: {it.lines} • click to view Top 50 non-buyers
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
