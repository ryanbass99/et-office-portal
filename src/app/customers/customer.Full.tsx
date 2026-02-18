"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  or,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentSnapshot,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";

type Customer = {
  id: string;
  customerNo: string;
  customerName: string;
  address1?: string;
  city?: string;
  state?: string;
  stateUpper?: string;
  phone?: string;

  dateLastActivity?: string;

  buyerEmail?: string;

  creditHoldBool?: boolean;
  lastActivityBucket?: string;
  status?: "A" | "I" | string;

  currentBalance?: string | number;
  udf250TotalSales?: string | number;

  email?: string;
};

const PAGE_SIZE = 50;
const FETCH_CHUNK = 500;

function toMoney(v: any) {
  if (v === null || v === undefined || v === "") return "";
  const n =
    typeof v === "number"
      ? v
      : Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function normalizeSalespersonNo(v: string) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length >= 4 ? s : s.padStart(4, "0");
}
function normalizeItemCode(v: string) {
  return String(v || "").trim().toUpperCase();
}

function parseCustomerDate(v: any): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;

  // Try ISO first
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;

  // Try MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy >= 1900) {
      const d = new Date(yyyy, mm - 1, dd);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  return null;
}

function daysSince(d: Date): number {
  const now = Date.now();
  const diff = now - d.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export default function CustomersPage() {
  const auth = getAuth();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [allRows, setAllRows] = useState<Customer[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [search, setSearch] = useState("");
  const [salespersonNo, setSalespersonNo] = useState<string>("");

  const [error, setError] = useState<string>("");
  const [totalForRep, setTotalForRep] = useState<number | null>(null);

  // chips
  const [creditHoldOnly, setCreditHoldOnly] = useState(false);
  const [activityBucket, setActivityBucket] = useState<
    "lt60" | "60_120" | "gt120" | "unknown" | ""
  >("");
  const [statusFilter, setStatusFilter] = useState<"" | "A" | "I">("");
  const [top50Only, setTop50Only] = useState(false);
  const [stateFilter, setStateFilter] = useState<string>("");

  // ✅ dashboard quick views
  const [quickView, setQuickView] = useState<"" | "atRisk45" | "inactive60">("");

  // ✅ new preset mode: whitespace list (NOT bought item)
  const [invertItemFilter, setInvertItemFilter] = useState(false);

  // item filter
  const [itemInput, setItemInput] = useState<string>("");
  const [activeItemCode, setActiveItemCode] = useState<string>("");
  const [itemCustomerSet, setItemCustomerSet] = useState<Set<string> | null>(null);
  const [itemLoading, setItemLoading] = useState<boolean>(false);
  const [itemError, setItemError] = useState<string>("");

  // export
  const [exporting, setExporting] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string>("");

  const ITEM_BUTTONS: { label: string; code: string }[] = [
    { label: "2025 Mothers Day", code: "K573" },
    { label: "Wing Rack Topper", code: "K191" },
    { label: "9 Bin", code: "K203" },
    { label: "4-Tier", code: "K233" },
    { label: "PD Bulk", code: "K399" },
    { label: "Cable Wing Rack", code: "K411" },
    { label: "PD Cable Wing Rack", code: "K412" },
    { label: "Wing Rack 99", code: "K414" },
    { label: "8' Cable Wing Topper", code: "K452" },
    { label: "8' PD Wing Topper", code: "K453" },
    { label: "Everyday Sunglasses", code: "K251" },
    { label: "Sunglass Spinner", code: "K494" },
  ];

  const [sortKey, setSortKey] = useState<
    "customer" | "address" | "city" | "phone" | "balance" | "sales"
  >("customer");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const searchTimer = useRef<any>(null);

  function mapSnap(snap: any): Customer[] {
    return snap.docs.map((d: any) => {
      const v = d.data() as any;
      return {
        id: d.id,
        customerNo: String(v.customerNo ?? d.id ?? ""),
        customerName: String(v.customerName ?? ""),
        address1: v.address1 ?? "",
        city: v.city ?? "",
        state: v.state ?? "",
        stateUpper: v.stateUpper ?? (v.state ? String(v.state).toUpperCase() : ""),
        phone: v.phone ?? "",
        dateLastActivity: v.dateLastActivity ?? "",
        creditHoldBool: v.creditHoldBool ?? undefined,
        lastActivityBucket: v.lastActivityBucket ?? "",
        status: v.status ?? "",
        currentBalance: v.currentBalance ?? "",
        udf250TotalSales: v.udf250TotalSales ?? v.udf250Totalsales ?? "",
        buyerEmail: v.buyerEmail ?? "",
        email: v.email ?? "",
      };
    });
  }

  async function fetchAllForRep(sp: string) {
    setError("");

    try {
      const countSnap = await getCountFromServer(
        query(
          collection(db, "customers"),
          or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp))
        )
      );
      setTotalForRep(countSnap.data().count);
    } catch {
      // ignore
    }

    let all: Customer[] = [];
    let last: DocumentSnapshot | null = null;

    while (true) {
      const q = last
        ? query(
            collection(db, "customers"),
            or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp)),
            orderBy("customerName"),
            startAfter(last),
            limit(FETCH_CHUNK)
          )
        : query(
            collection(db, "customers"),
            or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp)),
            orderBy("customerName"),
            limit(FETCH_CHUNK)
          );

      const snap = await getDocs(q);
      all = all.concat(mapSnap(snap));

      if (snap.docs.length < FETCH_CHUNK) break;
      last = snap.docs[snap.docs.length - 1];
    }

    setAllRows(all);
    setVisibleCount(PAGE_SIZE);
  }

  async function fetchCustomersWhoOrderedItem(itemCode: string, sp: string) {
    const code = normalizeItemCode(itemCode);
    if (!code) {
      setActiveItemCode("");
      setItemCustomerSet(null);
      return;
    }

    const rep = normalizeSalespersonNo(sp);
    if (!rep) {
      // ✅ Don't error; just wait until rep is known
      return;
    }

    setItemError("");
    setItemLoading(true);

    try {
      const docId = `${code}__${rep}`;
      const ref = doc(db, "itemCustomerIndex", docId);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        setItemCustomerSet(new Set());
        return;
      }

      const v = snap.data() as any;
      const list: string[] = Array.isArray(v.customerNos) ? v.customerNos : [];
      const set = new Set<string>(list.map((x) => String(x ?? "").trim()).filter(Boolean));
      setItemCustomerSet(set);
    } catch (e: any) {
      console.error(e);
      setItemCustomerSet(null);
      setItemError(
        e?.code
          ? `${e.code}: ${e.message ?? ""}`
          : String(e?.message ?? e ?? "Unknown error")
      );
    } finally {
      setItemLoading(false);
    }
  }

  async function exportCustomersEmail(customerNos: string[]) {
    try {
      setExporting(true);

      const user = auth.currentUser;
      if (!user) {
        setUserEmail("");
        alert("Not signed in.");
        return;
      }

      if (!customerNos.length) {
        alert("No customers match your current filters.");
        return;
      }

      const idToken = await user.getIdToken();

      const res = await fetch("/api/export-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, customerNos }),
      });

      const data = await res.json();

      if (res.ok && data?.ok) {
        alert(`Export emailed to ${data.sentTo}. (${data.count ?? "?"} customers)`);
      } else {
        alert(`Error: ${data?.error ?? "Unknown error"}`);
      }
    } catch (err: any) {
      alert(`Error: ${err?.message ?? String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  // auth + load
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setLoading(true);
      setError("");
      setAllRows([]);
      setVisibleCount(PAGE_SIZE);
      setTotalForRep(null);

      if (!user) {
        setUserEmail("");
        setSalespersonNo("");
        setLoading(false);
        return;
      }

      setUserEmail(user.email ?? "");

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        const sp = normalizeSalespersonNo(String((userSnap.data() as any)?.salesperson ?? ""));
        setSalespersonNo(sp);

        if (!sp) {
          setAllRows([]);
          setLoading(false);
          return;
        }

        await fetchAllForRep(sp);
      } catch (e: any) {
        console.error(e);
        setError(
          e?.code
            ? `${e.code}: ${e.message ?? ""}`
            : String(e?.message ?? e ?? "Unknown error")
        );
        setAllRows([]);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ quick preset from Sales Tools: /customers?quick=whitespace&top50=1&item=K411
  useEffect(() => {
    const quick = (searchParams.get("quick") || "").trim();
    const view = (searchParams.get("view") || "").trim();
    const item = normalizeItemCode(searchParams.get("item") || "");
    const top50Param = (searchParams.get("top50") || "").trim() === "1";

    if (quick === "whitespace" && item) {
      setQuickView("");
      setInvertItemFilter(true);
      setItemInput(item);
      setActiveItemCode(item);

      setSortKey("sales");
      setSortDir("desc");
      setTop50Only(top50Param);
      setVisibleCount(PAGE_SIZE);

      setSearch("");
      setCreditHoldOnly(false);
      setActivityBucket("");
      setStatusFilter("");
      setStateFilter("");
      return;
    }

    // ✅ dashboard views
    if (view === "atRisk45" || view === "inactive60") {
      setQuickView(view);

      // keep layout the same; just apply filters
      setVisibleCount(PAGE_SIZE);
      setSearch("");
      setCreditHoldOnly(false);
      setStatusFilter("");
      setStateFilter("");
      setTop50Only(false);
      setInvertItemFilter(false);
      setActiveItemCode("");
      setItemInput("");
      setActivityBucket("");

      // sensible default sort for these lists
      setSortKey("sales");
      setSortDir("desc");
      return;
    }

    setQuickView("");

    // default
    setInvertItemFilter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setVisibleCount(PAGE_SIZE);
    }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // ✅ Only fetch buyers list once BOTH item + rep are known
  useEffect(() => {
    if (!activeItemCode) {
      setItemCustomerSet(null);
      setItemError("");
      setItemLoading(false);
      return;
    }
    if (!salespersonNo) return;

    fetchCustomersWhoOrderedItem(activeItemCode, salespersonNo);
    setVisibleCount(PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItemCode, salespersonNo]);

  const filteredAll = useMemo(() => {
    const s = search.trim().toLowerCase();

    return allRows.filter((c) => {
      // ✅ dashboard quick filters
      if (quickView) {
        const d = parseCustomerDate(c.dateLastActivity);
        const age = d ? daysSince(d) : null;

        if (quickView === "inactive60") {
          // inactive 60+ days
          if (age === null) return false;
          if (age < 60) return false;
        }

        if (quickView === "atRisk45") {
          // at risk: 45–59 days since last activity
          if (age === null) return false;
          if (age < 45 || age >= 60) return false;
        }
      }

      if (creditHoldOnly && c.creditHoldBool !== true) return false;
      if (activityBucket && (c.lastActivityBucket ?? "") !== activityBucket) return false;
      if (statusFilter && String(c.status ?? "") !== statusFilter) return false;
      if (stateFilter && String(c.stateUpper ?? "") !== stateFilter) return false;

      if (activeItemCode) {
        if (!itemCustomerSet) return false; // wait until index loaded
        const has = itemCustomerSet.has(String(c.customerNo ?? "").trim());
        if (invertItemFilter) {
          if (has) return false; // NOT buyers
        } else {
          if (!has) return false; // buyers only
        }
      }

      if (!s) return true;

      return (
        c.customerNo.toLowerCase().includes(s) ||
        c.customerName.toLowerCase().includes(s) ||
        (c.address1 ?? "").toLowerCase().includes(s) ||
        (c.city ?? "").toLowerCase().includes(s) ||
        (c.state ?? "").toLowerCase().includes(s) ||
        (c.phone ?? "").toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s)
      );
    });
  }, [
    allRows,
    search,
    quickView,
    creditHoldOnly,
    activityBucket,
    statusFilter,
    stateFilter,
    activeItemCode,
    itemCustomerSet,
    invertItemFilter,
  ]);

  const stateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allRows) {
      const st = String(c.stateUpper ?? "").trim();
      if (st) set.add(st);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const sortedAll = useMemo(() => {
    const rows = [...filteredAll];
    const dir = sortDir === "asc" ? 1 : -1;

    const toNum = (v: any) => {
      if (v === null || v === undefined || v === "") return NaN;
      const n = Number(String(v).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : NaN;
    };

    rows.sort((a, b) => {
      switch (sortKey) {
        case "customer":
          return dir * a.customerName.localeCompare(b.customerName);
        case "address":
          return dir * (a.address1 ?? "").localeCompare(b.address1 ?? "");
        case "city":
          return dir * (a.city ?? "").localeCompare(b.city ?? "");
        case "phone":
          return dir * (a.phone ?? "").localeCompare(b.phone ?? "");
        case "balance": {
          const an = toNum(a.currentBalance);
          const bn = toNum(b.currentBalance);
          if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
          if (Number.isNaN(an)) return 1;
          if (Number.isNaN(bn)) return -1;
          return dir * (an - bn);
        }
        case "sales": {
          const an = toNum(a.udf250TotalSales);
          const bn = toNum(b.udf250TotalSales);
          if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
          if (Number.isNaN(an)) return 1;
          if (Number.isNaN(bn)) return -1;
          return dir * (an - bn);
        }
        default:
          return 0;
      }
    });

    return rows;
  }, [filteredAll, sortKey, sortDir]);

  const topRows = useMemo(
    () => (top50Only ? sortedAll.slice(0, 50) : sortedAll),
    [top50Only, sortedAll]
  );

  const visibleRows = useMemo(
    () => topRows.slice(0, visibleCount),
    [topRows, visibleCount]
  );

  const hasMore = !top50Only && visibleCount < topRows.length;

  async function loadMore() {
    if (top50Only) return;
    setLoadingMore(true);
    try {
      setVisibleCount((v) => Math.min(v + PAGE_SIZE, sortedAll.length));
    } finally {
      setLoadingMore(false);
    }
  }

  function resetChips() {
    setCreditHoldOnly(false);
    setActivityBucket("");
    setStatusFilter("");
    setStateFilter("");
    setInvertItemFilter(false);
    setTop50Only(false);
    setVisibleCount(PAGE_SIZE);
  }

  function toggleSort(
    key: "customer" | "address" | "city" | "phone" | "balance" | "sales"
  ) {
    setVisibleCount(PAGE_SIZE);
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortIcon(key: typeof sortKey) {
    if (sortKey !== key) return <span className="ml-1 text-gray-300">▲</span>;
    return <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  const exportCustomerNos = useMemo(() => {
    return topRows
      .map((c) => String(c.customerNo || "").trim())
      .filter(Boolean);
  }, [topRows]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Customers</h1>
          <p className="text-gray-600 text-sm">
            Showing {visibleRows.length} • Total: {topRows.length}
          </p>
          <p className="text-gray-500 text-xs">
            Rep: {salespersonNo || "(none)"}
            {totalForRep !== null ? ` • Total: ${totalForRep}` : ""}
          </p>

          {/* Filter chips */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                !creditHoldOnly && !activityBucket && !statusFilter
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={resetChips}
            >
              All
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                creditHoldOnly
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setCreditHoldOnly((v) => !v);
                setVisibleCount(PAGE_SIZE);
              }}
            >
              Credit Hold
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                activityBucket === "lt60"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setActivityBucket((v) => (v === "lt60" ? "" : "lt60"));
                setVisibleCount(PAGE_SIZE);
              }}
            >
              Activity &lt; 60
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                activityBucket === "60_120"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setActivityBucket((v) => (v === "60_120" ? "" : "60_120"));
                setVisibleCount(PAGE_SIZE);
              }}
            >
              Activity 60–120
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                activityBucket === "gt120"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setActivityBucket((v) => (v === "gt120" ? "" : "gt120"));
                setVisibleCount(PAGE_SIZE);
              }}
            >
              Activity &gt; 120
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                statusFilter === "A"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setStatusFilter((v) => (v === "A" ? "" : "A"));
                setVisibleCount(PAGE_SIZE);
              }}
              title="Active"
            >
              Active
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                statusFilter === "I"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setStatusFilter((v) => (v === "I" ? "" : "I"));
                setVisibleCount(PAGE_SIZE);
              }}
              title="Inactive"
            >
              Inactive
            </button>

            <button
              className={`px-3 py-1 rounded-full border text-xs ${
                top50Only
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-50"
              }`}
              onClick={() => {
                setTop50Only((v) => !v);
                setSortKey("sales");
                setSortDir("desc");
                setVisibleCount(PAGE_SIZE);
                setStatusFilter("");
                setActivityBucket("");
              }}
              title="Top 50 accounts by 2025 sales"
            >
              Top 50
            </button>
          </div>

          {/* State chips */}
          {stateOptions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  !stateFilter
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setStateFilter("");
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                All States
              </button>

              {stateOptions.map((st) => (
                <button
                  key={st}
                  className={`px-3 py-1 rounded-full border text-xs ${
                    stateFilter === st
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white hover:bg-gray-50"
                  }`}
                  onClick={() => {
                    setStateFilter((v) => (v === st ? "" : st));
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  {st}
                </button>
              ))}
            </div>
          ) : null}

          {/* Item filter */}
          <div className="mt-3">
            <div className="text-xs text-gray-600 mb-2">
              {invertItemFilter ? "Show accounts that have NOT ordered item code:" : "Show accounts that ordered item code:"}
              {activeItemCode ? (
                <span className="ml-2 font-semibold text-gray-900">{activeItemCode}</span>
              ) : (
                <span className="ml-2 text-gray-400">(none)</span>
              )}
              {itemLoading ? <span className="ml-2 text-gray-500">Loading…</span> : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {ITEM_BUTTONS.map((b) => {
                const code = normalizeItemCode(b.code);
                const active = !!code && activeItemCode === code && !invertItemFilter;
                return (
                  <button
                    key={b.label}
                    type="button"
                    className={`px-3 py-1 rounded-full border text-xs ${
                      active
                        ? "bg-gray-900 text-white border-gray-900"
                        : "bg-white hover:bg-gray-50"
                    } ${!code ? "opacity-40 cursor-not-allowed" : ""}`}
                    onClick={() => {
                      if (!code) return;
                      setInvertItemFilter(false);
                      setItemInput(code);
                      setActiveItemCode(code);
                      setVisibleCount(PAGE_SIZE);
                    }}
                    disabled={!code}
                    title={code || "Set a code"}
                  >
                    {b.label}
                  </button>
                );
              })}

              <button
                type="button"
                className={`px-3 py-1 rounded-full border text-xs ${
                  !activeItemCode
                    ? "bg-gray-100 text-gray-500 border-gray-200 cursor-not-allowed"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setInvertItemFilter(false);
                  setItemInput("");
                  setActiveItemCode("");
                  setItemCustomerSet(null);
                  setItemError("");
                  setVisibleCount(PAGE_SIZE);
                }}
                disabled={!activeItemCode}
              >
                Clear Item
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="w-full max-w-[240px] border rounded px-3 py-2 text-sm"
                placeholder="Enter item code (e.g., K411)"
                value={itemInput}
                onChange={(e) => setItemInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const code = normalizeItemCode(itemInput);
                    setInvertItemFilter(false);
                    setActiveItemCode(code);
                  }
                }}
              />
              <button
                type="button"
                className="px-4 py-2 rounded border bg-white hover:bg-gray-100 text-sm"
                onClick={() => {
                  const code = normalizeItemCode(itemInput);
                  setInvertItemFilter(false);
                  setActiveItemCode(code);
                }}
              >
                Apply
              </button>
            </div>

            {itemError ? (
              <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                {itemError}
              </div>
            ) : null}
          </div>
        </div>

        {/* TOP RIGHT: Export + Search */}
        <div className="w-full max-w-md flex flex-col gap-2 items-end">
          <button
            type="button"
            className={`px-4 py-2 rounded border text-sm ${
              exporting
                ? "bg-gray-100 text-gray-500 border-gray-200 cursor-not-allowed"
                : "bg-gray-900 text-white border-gray-900 hover:bg-gray-800"
            }`}
            onClick={() => exportCustomersEmail(exportCustomerNos)}
            disabled={exporting}
            title="Email export of current filtered list"
          >
            {exporting ? (
              "Emailing…"
            ) : (
              <span className="flex flex-col leading-tight">
                <span>Email to</span>
                <span className="text-xs opacity-90">{userEmail}</span>
              </span>
            )}
          </button>

          <input
            className="w-full border rounded px-3 py-2"
            placeholder="Search customer #, name, address, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="text-gray-600">Loading customers...</div>
      ) : error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full table-fixed text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-1 w-[44%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("customer")}
                  >
                    Customer{sortIcon("customer")}
                  </button>
                </th>
                <th className="text-left p-1 w-[18%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("address")}
                  >
                    Address{sortIcon("address")}
                  </button>
                </th>
                <th className="text-left p-1 w-[16%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("city")}
                  >
                    City{sortIcon("city")}
                  </button>
                </th>
                <th className="text-left p-1 w-[10%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("phone")}
                  >
                    Phone{sortIcon("phone")}
                  </button>
                </th>
                <th className="text-right p-1 w-[6%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("balance")}
                  >
                    Current Balance{sortIcon("balance")}
                  </button>
                </th>
                <th className="text-right p-1 w-[6%]">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => toggleSort("sales")}
                  >
                    2025 Sales{sortIcon("sales")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="p-1 text-gray-500" colSpan={6}>
                    No customers found.
                  </td>
                </tr>
              ) : (
                visibleRows.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="p-1">
                      <div className="min-w-0">
                        <div className="font-medium leading-4 truncate">{c.customerName}</div>
                        <div className="text-gray-500 leading-4 flex flex-wrap items-center gap-2">
                          <span className="tabular-nums">{c.customerNo}</span>

                          <span className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700">
                            {String(c.status ?? "").toUpperCase() === "I" ? "Inactive" : "Active"}
                          </span>

                          {!!String(c.buyerEmail ?? "").trim() ? (
                            <a
                              href={`mailto:${String(c.buyerEmail ?? "").trim()}`}
                              className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700 hover:bg-gray-50"
                              title={String(c.buyerEmail ?? "").trim()}
                            >
                              Email Buyer
                            </a>
                          ) : null}

                          {c.creditHoldBool ? (
                            <span className="px-1.5 py-0.5 rounded border text-[10px] bg-red-50 border-red-200 text-red-700">
                              CH
                            </span>
                          ) : null}

                          {c.dateLastActivity ? (
                            <span className="text-[10px] text-gray-500">Last: {c.dateLastActivity}</span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="p-1 truncate">{c.address1 ?? ""}</td>
                    <td className="p-1 truncate">
                      {c.city || c.state
                        ? `${c.city ?? ""}${c.city && c.state ? ", " : ""}${c.state ?? ""}`
                        : ""}
                    </td>
                    <td className="p-1 truncate tabular-nums">{c.phone ?? ""}</td>
                    <td className="p-1 text-right tabular-nums">{toMoney(c.currentBalance)}</td>
                    <td className="p-1 text-right tabular-nums">{toMoney(c.udf250TotalSales)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {hasMore ? (
            <div className="p-2 border-t bg-gray-50 flex justify-center">
              <button
                className="px-4 py-2 rounded border bg-white hover:bg-gray-100 disabled:opacity-50 text-sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
