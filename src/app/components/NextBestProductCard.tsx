"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useRouter } from "next/navigation";

type TopItem = {
  itemCode: string;
  description?: string;
  sales?: number;
  qty?: number;
  lines?: number;
};

function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

// Always exclude these codes in UI too (defensive)
const EXCLUDE_CODES = new Set(["170"]);

// Optional item master lookup for description if not already stored in stats doc
const ITEMS_COLLECTION = "items"; // <-- change if your item master collection is different
const ITEM_DESC_FIELD = "description"; // <-- change if field differs

async function fetchDescriptions(codes: string[]) {
  const out = new Map<string, string>();
  for (const code of codes) {
    try {
      const snap = await getDoc(doc(db, ITEMS_COLLECTION, code));
      if (!snap.exists()) continue;
      const v = snap.data() as any;
      const d = v?.[ITEM_DESC_FIELD];
      if (d && String(d).trim()) out.set(code, String(d).trim());
    } catch {
      // ignore
    }
  }
  return out;
}

export default function NextBestProductCard() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [metric, setMetric] = useState<"sales" | "qty" | "lines">("sales");
  const [daysBack, setDaysBack] = useState<number>(60);
  const [items, setItems] = useState<TopItem[]>([]);

  useEffect(() => {
    const ref = doc(db, "companyStats", "topItems_60d");

    const unsub = onSnapshot(
      ref,
      async (snap) => {
        setLoading(false);

        if (!snap.exists()) {
          setErr(
            "No weekly stats found yet. Run the weekly job to generate companyStats/topItems_60d."
          );
          setItems([]);
          return;
        }

        const v = snap.data() as any;

        const rawItems: TopItem[] = Array.isArray(v.items) ? v.items : [];
        const filtered = rawItems.filter(
          (x) => x?.itemCode && !EXCLUDE_CODES.has(String(x.itemCode))
        );

        setErr(null);
        setMetric((v.metric as any) || "sales");
        setDaysBack(Number(v.daysBack ?? 60));

        // Ensure descriptions exist (either from stats doc, or lookup from items collection)
        const need = filtered
          .filter((x) => !String(x.description ?? "").trim())
          .map((x) => String(x.itemCode));

        if (need.length) {
          const m = await fetchDescriptions(need.slice(0, 10)); // only a few
          setItems(
            filtered.slice(0, 5).map((x) => ({
              ...x,
              description:
                String(x.description ?? "").trim() ||
                m.get(String(x.itemCode)) ||
                "",
            }))
          );
        } else {
          setItems(filtered.slice(0, 5));
        }
      },
      (e) => {
        setLoading(false);
        setErr(e?.message ?? "Failed to load weekly stats");
        setItems([]);
      }
    );

    return () => unsub();
  }, []);

  const displayItems = useMemo(
    () => items.filter((x) => !EXCLUDE_CODES.has(String(x.itemCode))).slice(0, 5),
    [items]
  );

  return (
    <div className="bg-white rounded-lg shadow p-4 border border-black">
      <div className="font-semibold mb-1">
        Top 5 company items (last {daysBack} days)
      </div>

      {loading ? <div className="text-sm text-gray-500">Loading…</div> : null}
      {err ? <div className="mt-2 text-xs text-red-600">{err}</div> : null}

      {!loading && !err && displayItems.length === 0 ? (
        <div className="text-sm text-gray-600">No items found.</div>
      ) : null}

      {!loading && !err && displayItems.length > 0 ? (
        <div className="mt-2 divide-y rounded border">
          {displayItems.map((it) => {
            const val =
              metric === "sales"
                ? money(Number(it.sales ?? 0))
                : metric === "qty"
                ? Number(it.qty ?? 0).toLocaleString()
                : Number(it.lines ?? 0).toLocaleString();

            const label =
              metric === "sales" ? "sales" : metric === "qty" ? "qty" : "lines";

            const title = String(it.description ?? "").trim()
              ? `${it.itemCode} — ${String(it.description).trim()}`
              : String(it.itemCode);

            return (
              <button
                key={it.itemCode}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-gray-50"
                onClick={() =>
                  router.push(
                    `/customers?quick=whitespace&top50=1&item=${encodeURIComponent(
                      it.itemCode
                    )}`
                  )
                }
                title="Click to see Top 50 accounts that have NOT bought this item (your territory)"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-semibold text-blue-700 hover:underline truncate">
                    {title}
                  </div>
                  <div className="text-xs text-gray-600 whitespace-nowrap">
                    {label}:{" "}
                    <span className="font-medium text-gray-900">{val}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
