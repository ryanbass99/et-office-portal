"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NextBestProductCard from "../components/NextBestProductCard";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { db } from "@/lib/firebase";

type Buyer = {
  customerNo: string;
  name?: string;
  city?: string;
  state?: string;
  salespersonNo?: string;
  sales25?: number;
  tier?: string;
  buyerEmail?: string;
};

type ItemSuggestion = {
  itemCode: string;
  itemCodeDesc?: string;
};

type PurchaseLookupRow = {
  key: string;
  customerNo: string;
  customerName: string;
  invoiceNo: string;
  invoiceDateRaw: any;
  invoiceDateText: string;
  quantityShipped: number;
};

function toSearchToken(input: string) {
  const raw = (input || "").trim();
  if (!raw) return "";

  const parts = raw.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || "";

  const tokenUpper = last.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return tokenUpper.slice(0, 24);
}

function normalizeCode(input: string) {
  return String(input || "").trim().toUpperCase();
}

function normalizeRep(input: any) {
  return String(input ?? "")
    .trim()
    .replace(/\D/g, "")
    .padStart(4, "0");
}

function toJsDate(value: any): Date | null {
  if (!value) return null;

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  }

  if (value instanceof Date) {
    return !isNaN(value.getTime()) ? value : null;
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;

    const direct = new Date(s);
    if (!isNaN(direct.getTime())) return direct;

    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const mm = Number(m[1]);
      const dd = Number(m[2]);
      const yyyy = Number(m[3]);
      const d = new Date(yyyy, mm - 1, dd);
      if (!isNaN(d.getTime())) return d;
    }
  }

  if (
    typeof value === "object" &&
    typeof value.seconds === "number" &&
    typeof value.nanoseconds === "number"
  ) {
    const d = new Date(value.seconds * 1000);
    return !isNaN(d.getTime()) ? d : null;
  }

  return null;
}

function formatDateMMDDYYYY(value: any) {
  const d = toJsDate(value);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function getCustomerReps(data: any) {
  const rawValues = [
    data?.salespersonNo,
    data?.salesmanNo,
    data?.salesperson,
    data?.salesman,
    data?.repNo,
    data?.rep,
    data?.salespersonNo2,
    data?.salesmanNo2,
    data?.salesperson2,
    data?.salesman2,
    data?.repNo2,
    data?.rep2,
    data?.secondarySalespersonNo,
    data?.secondarySalesmanNo,
    data?.secondarySalesperson,
    data?.secondarySalesman,
    data?.secondaryRepNo,
    data?.secondaryRep,
  ];

  const reps = rawValues
    .map((value) => normalizeRep(value))
    .filter(Boolean);

  return Array.from(new Set(reps));
}

export default function SalesToolsPage() {
  const [itemCode, setItemCode] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [itemSuggestions, setItemSuggestions] = useState<ItemSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const [submittedItemCode, setSubmittedItemCode] = useState<string | null>(null);
  const [itemDesc, setItemDesc] = useState<string | null>(null);
  const [repNo, setRepNo] = useState<string | null>(null);

  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [opportunities, setOpportunities] = useState<Buyer[]>([]);
  const [selectedBuyer, setSelectedBuyer] = useState<Buyer | null>(null);

  const [loadingBuyers, setLoadingBuyers] = useState(false);
  const [loadingOpps, setLoadingOpps] = useState(false);
  const [buyersError, setBuyersError] = useState<string | null>(null);

  const [purchaseItemCode, setPurchaseItemCode] = useState("");
  const [purchaseRows, setPurchaseRows] = useState<PurchaseLookupRow[]>([]);
  const [loadingPurchases, setLoadingPurchases] = useState(false);
  const [purchasesError, setPurchasesError] = useState<string | null>(null);
  const [purchaseSearchRan, setPurchaseSearchRan] = useState(false);

  const canSearch = useMemo(() => itemCode.trim().length > 0, [itemCode]);
  const tokenUpper = useMemo(() => toSearchToken(itemSearch), [itemSearch]);
  const canSearchByName = useMemo(() => tokenUpper.length > 1, [tokenUpper]);
  const canSearchPurchases = useMemo(
    () => normalizeCode(purchaseItemCode).length > 0,
    [purchaseItemCode]
  );

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!mountedRef.current) return;
        setRepNo(null);
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!mountedRef.current) return;

        if (snap.exists()) {
          const data = snap.data() as any;
          if (data?.salesperson) {
            setRepNo(normalizeRep(data.salesperson));
          } else {
            setRepNo(null);
          }
        }
      } catch {
        // ignore
      }
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!canSearchByName) {
      setItemSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }

    let cancelled = false;

    const handle = setTimeout(async () => {
      setLoadingSuggestions(true);

      try {
        const itemsRef = collection(db, "itemsMaster");
        const q = query(
          itemsRef,
          where("searchPrefixes", "array-contains", tokenUpper),
          limit(25)
        );

        const snap = await getDocs(q);

        const rows: ItemSuggestion[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          const code = String(data.itemCode || data.ItemCode || d.id || "").trim();
          if (!code) return;

          const desc =
            String(
              data.itemCodeDesc ||
                data.ItemCodeDesc ||
                data.description ||
                data.desc ||
                ""
            ).trim() || undefined;

          rows.push({ itemCode: code, itemCodeDesc: desc });
        });

        rows.sort((a, b) => a.itemCode.localeCompare(b.itemCode));

        if (!cancelled && mountedRef.current) setItemSuggestions(rows);
      } catch {
        if (!cancelled && mountedRef.current) setItemSuggestions([]);
      } finally {
        if (!cancelled && mountedRef.current) setLoadingSuggestions(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [canSearchByName, tokenUpper]);

  async function onSearch(forcedCode?: string) {
    const code = normalizeCode(forcedCode ?? itemCode);
    if (!code) return;

    if (!repNo) {
      setBuyersError("Rep not loaded yet. Please refresh or wait a second and try again.");
      return;
    }

    setSubmittedItemCode(code);
    setItemDesc(null);
    setItemSuggestions([]);
    setLoadingSuggestions(false);
    setBuyers([]);
    setOpportunities([]);
    setSelectedBuyer(null);
    setBuyersError(null);
    setLoadingBuyers(true);
    setLoadingOpps(false);

    try {
      const res = await fetch(
        `/api/item-buyers?itemCode=${encodeURIComponent(code)}&onePerTier=1&salespersonNo=${encodeURIComponent(
          repNo
        )}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load buyers.");

      if (typeof data?.itemDescription === "string" && data.itemDescription.trim()) {
        setItemDesc(data.itemDescription.trim());
      }

      setBuyers(Array.isArray(data?.buyers) ? data.buyers : []);
    } catch (e: any) {
      setBuyersError(e?.message || "Unknown error.");
    } finally {
      setLoadingBuyers(false);
    }
  }

  async function loadOppsForBuyer(b: Buyer) {
    if (!submittedItemCode || !b?.tier) return;

    if (!repNo) {
      setBuyersError("Rep not loaded yet. Please refresh or wait a second and try again.");
      return;
    }

    setSelectedBuyer(b);
    setOpportunities([]);
    setBuyersError(null);
    setLoadingOpps(true);

    try {
      const res = await fetch(
        `/api/item-buyers?itemCode=${encodeURIComponent(
          submittedItemCode
        )}&onePerTier=1&selectedTier=${encodeURIComponent(String(b.tier))}&oppCount=4&salespersonNo=${encodeURIComponent(
          repNo
        )}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load opportunities.");

      if (typeof data?.itemDescription === "string" && data.itemDescription.trim()) {
        setItemDesc(data.itemDescription.trim());
      }

      setOpportunities(Array.isArray(data?.opportunities) ? data.opportunities : []);
    } catch (e: any) {
      setBuyersError(e?.message || "Unknown error.");
    } finally {
      setLoadingOpps(false);
    }
  }

  async function onPurchaseLookupSearch() {
    const code = normalizeCode(purchaseItemCode);
    if (!code) return;

    if (!repNo) {
      setPurchasesError("Rep not loaded yet. Please refresh or wait a second and try again.");
      return;
    }

    setPurchaseSearchRan(true);
    setLoadingPurchases(true);
    setPurchasesError(null);
    setPurchaseRows([]);

    try {
      const linesRef = collectionGroup(db, "lines");
      const q = query(
        linesRef,
        where("itemCode", "==", code),
        orderBy("invoiceDate", "desc"),
        limit(1000)
      );
      const snap = await getDocs(q);

      const customerCache = new Map<string, { name: string; reps: string[] }>();
      const invoiceMap = new Map<string, PurchaseLookupRow>();

      for (const lineDoc of snap.docs) {
        const data = lineDoc.data() as any;

        const customerNo = String(data.customerNo || "").trim();
        if (!customerNo) continue;

        let cached = customerCache.get(customerNo);
        if (!cached) {
          let name = "";
          let reps: string[] = [];
          try {
            const customerSnap = await getDoc(doc(db, "customers", customerNo));
            if (customerSnap.exists()) {
              const c = customerSnap.data() as any;
              name = String(c.customerName || "").trim();
              reps = getCustomerReps(c);
            }
          } catch {
            // ignore per-customer read failure
          }

          cached = { name, reps };
          customerCache.set(customerNo, cached);
        }

        if (!cached.reps.includes(repNo)) continue;

        const invoiceNo = String(data.invoiceNo || "").trim();
        const invoiceDateRaw = data.invoiceDate ?? null;
        const invoiceDateText = formatDateMMDDYYYY(invoiceDateRaw);
        const qty = Number(data.quantityShipped ?? 0);

        const dedupeKey = `${customerNo}__${invoiceNo}__${invoiceDateText}__${code}`;
        const existing = invoiceMap.get(dedupeKey);

        if (!existing) {
          invoiceMap.set(dedupeKey, {
            key: dedupeKey,
            customerNo,
            customerName: cached.name || `Customer ${customerNo}`,
            invoiceNo,
            invoiceDateRaw,
            invoiceDateText,
            quantityShipped: qty,
          });
        } else {
          existing.quantityShipped = Math.max(existing.quantityShipped, qty);
        }
      }

      const rows = Array.from(invoiceMap.values());

      rows.sort((a, b) => {
        const aTime = toJsDate(a.invoiceDateRaw)?.getTime() ?? -1;
        const bTime = toJsDate(b.invoiceDateRaw)?.getTime() ?? -1;
        return bTime - aTime;
      });

      if (!mountedRef.current) return;
      setPurchaseRows(rows);
    } catch (e: any) {
      if (!mountedRef.current) return;
      console.error("Item Purchase Lookup error:", e);
      setPurchasesError(e?.message || "Failed to load purchase history.");
    } finally {
      if (mountedRef.current) setLoadingPurchases(false);
    }
  }

  function onClear() {
    setItemCode("");
    setItemSearch("");
    setItemSuggestions([]);
    setLoadingSuggestions(false);
    setSubmittedItemCode(null);
    setItemDesc(null);
    setBuyers([]);
    setOpportunities([]);
    setSelectedBuyer(null);
    setBuyersError(null);
    setLoadingBuyers(false);
    setLoadingOpps(false);
  }

  function onClearPurchaseLookup() {
    setPurchaseItemCode("");
    setPurchaseRows([]);
    setPurchasesError(null);
    setLoadingPurchases(false);
    setPurchaseSearchRan(false);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">Sales Tools</h1>

      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Next Best Product</h2>
        <NextBestProductCard />
      </div>

      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Item Code Opportunity Finder</h2>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Item Code
            </label>
            <input
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSearch();
              }}
              placeholder="e.g. K549"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Or search by name
            </label>

            <div className="relative">
              <input
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSearchByName && itemSuggestions.length > 0) {
                    const first = itemSuggestions[0];
                    const code = String(first.itemCode || "").toUpperCase().trim();
                    if (!code) return;

                    setItemCode(code);
                    setItemSearch("");
                    setItemSuggestions([]);
                    setLoadingSuggestions(false);

                    setTimeout(() => onSearch(code), 0);
                  }
                }}
                placeholder='e.g. "pokemon"'
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />

              {itemSearch.trim().length > 1 ? (
                <div className="absolute z-20 mt-1 w-full rounded border border-gray-200 bg-white shadow">
                  {loadingSuggestions ? (
                    <div className="px-3 py-2 text-sm text-gray-600">
                      Searching for{" "}
                      <span className="font-mono font-semibold">{tokenUpper}</span>…
                    </div>
                  ) : itemSuggestions.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-600">
                      No matches for{" "}
                      <span className="font-mono font-semibold">{tokenUpper}</span>.
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-auto">
                      {itemSuggestions.map((it) => (
                        <button
                          key={it.itemCode}
                          type="button"
                          onClick={() => {
                            const code = String(it.itemCode || "").toUpperCase().trim();
                            if (!code) return;

                            setItemCode(code);
                            setItemSearch("");
                            setItemSuggestions([]);
                            setLoadingSuggestions(false);

                            setTimeout(() => onSearch(code), 0);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50"
                        >
                          <div className="text-sm font-semibold font-mono">
                            {it.itemCode}
                          </div>
                          {it.itemCodeDesc ? (
                            <div className="text-xs text-gray-600">{it.itemCodeDesc}</div>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSearch()}
              disabled={!canSearch || loadingBuyers}
              className={`px-4 py-2 rounded border text-sm ${
                !canSearch || loadingBuyers
                  ? "bg-gray-100 text-gray-400 border-gray-200"
                  : "bg-gray-900 text-white border-gray-900 hover:bg-black"
              }`}
            >
              Search
            </button>

            <button
              type="button"
              onClick={onClear}
              className="px-4 py-2 rounded border text-sm bg-white border-gray-300 hover:bg-gray-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 rounded p-3">
            <div className="text-sm font-semibold mb-2">
              Stores that bought {submittedItemCode ? submittedItemCode : "—"}
            </div>

            {buyersError ? (
              <div className="text-sm text-red-600">{buyersError}</div>
            ) : loadingBuyers ? (
              <div className="text-sm text-gray-600">Loading…</div>
            ) : !submittedItemCode ? (
              <div className="text-sm text-gray-600">
                Enter an item code and click Search.
              </div>
            ) : buyers.length === 0 ? (
              <div className="text-sm text-gray-600">No buyers found.</div>
            ) : (
              <div className="space-y-2">
                {buyers.map((b) => (
                  <div
                    key={b.customerNo}
                    onClick={() => loadOppsForBuyer(b)}
                    className={`rounded border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 ${
                      selectedBuyer?.customerNo === b.customerNo ? "ring-2 ring-gray-900" : ""
                    }`}
                    title="Click to find 4 similar stores in the same tier that haven’t bought it"
                  >
                    <div className="text-sm font-semibold">
                      {b.name?.trim() ? b.name : `Customer ${b.customerNo}`}
                    </div>
                    <div className="text-xs text-gray-600">
                      {b.city ? `${b.city}, ` : ""}
                      {b.state || ""}
                      {b.tier ? ` • Tier: ${b.tier}` : ""}
                      {typeof b.sales25 === "number" ? ` • $${b.sales25.toLocaleString()}` : ""}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">
                      {b.customerNo}
                      {b.salespersonNo ? ` • Rep: ${b.salespersonNo}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border border-gray-200 rounded p-3">
            <div className="text-sm font-semibold mb-2">
              Similar stores (same tier
              {selectedBuyer?.tier ? `: ${selectedBuyer.tier}` : ""})
            </div>

            {buyersError ? (
              <div className="text-sm text-red-600">{buyersError}</div>
            ) : !submittedItemCode ? (
              <div className="text-sm text-gray-600">
                We’ll populate this after you search.
              </div>
            ) : !selectedBuyer ? (
              <div className="text-sm text-gray-600">
                Click a buyer on the left to find 4 similar stores in the same tier
                that haven’t bought it.
              </div>
            ) : loadingOpps ? (
              <div className="text-sm text-gray-600">Loading…</div>
            ) : opportunities.length === 0 ? (
              <div className="text-sm text-gray-600">
                No opportunity stores found for Tier {selectedBuyer.tier}.
              </div>
            ) : (
              <div className="space-y-2">
                {opportunities.map((o) => (
                  <div
                    key={o.customerNo}
                    className="rounded border border-gray-200 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-semibold">
                        {o.name?.trim() ? o.name : `Customer ${o.customerNo}`}
                      </div>

                      {o.buyerEmail ? (
                        <a
                          href={`mailto:${o.buyerEmail}?subject=${encodeURIComponent(
                            `${submittedItemCode ?? ""} ${itemDesc ?? ""} Opportunity Buy!`
                              .replace(/\s+/g, " ")
                              .trim()
                          )}`}
                          className="shrink-0 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-900 hover:bg-gray-50"
                          title={o.buyerEmail}
                        >
                          Email Buyer
                        </a>
                      ) : null}
                    </div>

                    <div className="text-xs text-gray-600">
                      {o.city ? `${o.city}, ` : ""}
                      {o.state || ""}
                      {o.tier ? ` • Tier: ${o.tier}` : ""}
                      {typeof o.sales25 === "number" ? ` • $${o.sales25.toLocaleString()}` : ""}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">
                      {o.customerNo}
                      {o.salespersonNo ? ` • Rep: ${o.salespersonNo}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Item Purchase Lookup</h2>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Item Code
            </label>
            <input
              value={purchaseItemCode}
              onChange={(e) => setPurchaseItemCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") onPurchaseLookupSearch();
              }}
              placeholder="e.g. K160"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPurchaseLookupSearch}
              disabled={!canSearchPurchases || loadingPurchases}
              className={`px-4 py-2 rounded border text-sm ${
                !canSearchPurchases || loadingPurchases
                  ? "bg-gray-100 text-gray-400 border-gray-200"
                  : "bg-gray-900 text-white border-gray-900 hover:bg-black"
              }`}
            >
              Search
            </button>

            <button
              type="button"
              onClick={onClearPurchaseLookup}
              className="px-4 py-2 rounded border text-sm bg-white border-gray-300 hover:bg-gray-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-4 border border-gray-200 rounded overflow-hidden">
          {purchasesError ? (
            <div className="p-3 text-sm text-red-600">{purchasesError}</div>
          ) : loadingPurchases ? (
            <div className="p-3 text-sm text-gray-600">Loading…</div>
          ) : !purchaseSearchRan ? (
            <div className="p-3 text-sm text-gray-600">
              Enter an item code and click Search.
            </div>
          ) : purchaseRows.length === 0 ? (
            <div className="p-3 text-sm text-gray-600">No purchase history found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Account #</th>
                    <th className="text-left px-3 py-2 font-semibold">Customer Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Invoice Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Invoice #</th>
                    <th className="text-right px-3 py-2 font-semibold">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseRows.map((row) => (
                    <tr key={row.key} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono">{row.customerNo}</td>
                      <td className="px-3 py-2">{row.customerName}</td>
                      <td className="px-3 py-2">{row.invoiceDateText || "—"}</td>
                      <td className="px-3 py-2 font-mono">{row.invoiceNo || "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {Number.isFinite(row.quantityShipped)
                          ? row.quantityShipped.toLocaleString()
                          : "0"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {purchaseRows.length > 0 ? (
          <div className="mt-2 text-xs text-gray-500">
            Showing one row per invoice for the logged-in rep, newest first.
          </div>
        ) : null}
      </div>

      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Coming soon</h2>
        <div className="text-sm text-gray-600">
          Call scripts, objection handling, email drafts, reorder nudges, new item pushes…
        </div>
      </div>
    </div>
  );
}