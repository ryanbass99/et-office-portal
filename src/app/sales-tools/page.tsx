"use client";

import { useEffect, useMemo, useState } from "react";
import NextBestProductCard from "../components/NextBestProductCard";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

type Buyer = {
  customerNo: string;
  name?: string;
  city?: string;
  state?: string;
  salespersonNo?: string;
  sales25?: number;
  tier?: string;
};

export default function SalesToolsPage() {
  const [itemCode, setItemCode] = useState("");
  const [submittedItemCode, setSubmittedItemCode] = useState<string | null>(null);
  const [itemDesc, setItemDesc] = useState<string | null>(null);
  const [repNo, setRepNo] = useState<string | null>(null);

  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [opportunities, setOpportunities] = useState<Buyer[]>([]);

  const [selectedBuyer, setSelectedBuyer] = useState<Buyer | null>(null);

  const [loadingBuyers, setLoadingBuyers] = useState(false);
  const [loadingOpps, setLoadingOpps] = useState(false);

  const [buyersError, setBuyersError] = useState<string | null>(null);

  const canSearch = useMemo(() => itemCode.trim().length > 0, [itemCode]);

  useEffect(() => {
    async function loadRep() {
      const user = auth.currentUser;
      if (!user) return;

      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        const data = snap.data() as any;
        if (data?.salesperson) {
          setRepNo(String(data.salesperson).padStart(4, "0"));
        }
      }
    }

    loadRep();
  }, []);

  async function onSearch() {
    const code = itemCode.trim();
    if (!code) return;

    if (!repNo) {
      setBuyersError("Rep not loaded yet. Please refresh or wait a second and try again.");
      return;
    }

    setSubmittedItemCode(code);
    setItemDesc(null);

    // reset UI state
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
        )}&onePerTier=1&selectedTier=${encodeURIComponent(
          String(b.tier)
        )}&oppCount=4&salespersonNo=${encodeURIComponent(repNo)}`,
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

  function onClear() {
    setItemCode("");
    setSubmittedItemCode(null);
    setItemDesc(null);
    setBuyers([]);
    setOpportunities([]);
    setSelectedBuyer(null);
    setBuyersError(null);
    setLoadingBuyers(false);
    setLoadingOpps(false);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">Sales Tools</h1>

      {/* TOP: Next Best Product */}
      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Next Best Product</h2>
        <NextBestProductCard />
      </div>

      {/* Item Code Opportunity Finder */}
      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Item Code Opportunity Finder</h2>

        {/* Debug line (optional) */}
        

        {/* Input row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Item Code
            </label>
            <input
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSearch();
              }}
              placeholder="e.g. K549"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSearch}
              disabled={!canSearch || loadingBuyers}
              className={`px-4 py-2 rounded border text-sm ${
                !canSearch || loadingBuyers
                  ? "bg-gray-100 text-gray-500 border-gray-200 cursor-not-allowed"
                  : "bg-gray-900 text-white border-gray-900 hover:bg-black"
              }`}
            >
              {loadingBuyers ? "Searching..." : "Search"}
            </button>

            <button
              type="button"
              onClick={onClear}
              className="px-4 py-2 rounded border text-sm bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Two-column results area */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* LEFT */}
          <div className="border border-gray-200 rounded p-3">
            <div className="text-sm font-semibold mb-2">
              Stores that bought{" "}
              <span className="font-mono">
                {submittedItemCode ? submittedItemCode : "—"}
              </span>
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
                      selectedBuyer?.customerNo === b.customerNo
                        ? "ring-2 ring-gray-900"
                        : ""
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
                      {typeof b.sales25 === "number"
                        ? ` • $${b.sales25.toLocaleString()}`
                        : ""}
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

          {/* RIGHT */}
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
                Click a buyer on the left to find 4 similar stores in the same tier that
                haven’t bought it.
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
                            `${submittedItemCode ?? ""} ${itemDesc ?? ""} Opportunity Buy!`.replace(/\s+/g, " ").trim()
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
                      {typeof o.sales25 === "number"
                        ? ` • $${o.sales25.toLocaleString()}`
                        : ""}
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

      {/* (later) more AI tools below */}
      <div className="bg-white rounded-lg shadow p-4 border border-black">
        <h2 className="text-lg font-semibold mb-3">Coming soon</h2>
        <div className="text-sm text-gray-600">
          Call scripts, objection handling, email drafts, reorder nudges, new item pushes…
        </div>
      </div>
    </div>
  );
}
