'use client';

import React, { useEffect, useMemo, useState } from "react";
import { getApps, FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  Timestamp,
} from "firebase/firestore";

type OpenSalesLine = {
  id: string;
  salesOrderNo: string;
  salespersonNo: string;
  customerNo?: string;
  orderDate?: Timestamp | null;

  shipToName?: string;
  shipToCity?: string;
  shipToState?: string;
  shipToZipCode?: string;

  itemCode?: string;
  itemCodeDesc?: string;
  quantityOrdered?: number;

  importedAt?: Timestamp | null;
};

function padSalesperson(v: string) {
  const s = (v ?? "").trim();
  if (!s) return "";
  // keep leading zeros
  return s.length >= 4 ? s : s.padStart(4, "0");
}

function tsToDateStr(ts?: Timestamp | null) {
  if (!ts) return "";
  const d = ts.toDate();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function initFirebase(): FirebaseApp {
  // AuthGate already initializes Firebase for the app.
  // We just reuse the existing initialized app instance.
  const apps = getApps();
  if (!apps.length) {
    throw new Error(
      "Firebase app is not initialized. Ensure AuthGate initializes Firebase before rendering this page."
    );
  }
  return apps[0]!;
}

export default function SalesOrdersPage() {
  const [user, setUser] = useState<User | null>(null);
  const [salespersonNo, setSalespersonNo] = useState<string>("");
  const [lines, setLines] = useState<OpenSalesLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");

  const [search, setSearch] = useState("");

  useEffect(() => {
    let unsubLines: (() => void) | null = null;

    try {
      const app = initFirebase();
      const auth = getAuth(app);
      const db = getFirestore(app);

      const unsubAuth = onAuthStateChanged(auth, async (u) => {
        setUser(u);
        setErr("");
        setLines([]);
        setSalespersonNo("");
        setLoading(true);

        if (!u) {
          setLoading(false);
          return;
        }

        // Read the logged-in user's profile to determine rep/salesperson id
        const userRef = doc(db, "users", u.uid);
        const snap = await getDoc(userRef);

        if (!snap.exists()) {
          setErr("No user profile found in /users/{uid}.");
          setLoading(false);
          return;
        }

        const data = snap.data() as any;
        const repRaw =
          data.salesmanId ??
          data.salespersonNo ??
          data.salesperson ??
          data.repId ??
          data.rep ??
          data.salesmanNo ??
          "";

        const rep = padSalesperson(String(repRaw ?? ""));
        if (!rep) {
          setErr("User profile is missing salesperson id (salesmanId/salespersonNo/repId).");
          setLoading(false);
          return;
        }

        setSalespersonNo(rep);

        // Listen to open sales order lines for this salesperson
        const q = query(
          collection(db, "openSalesOrderLines"),
          where("salespersonNo", "==", rep),
          orderBy("orderDate", "desc"),
          orderBy("salesOrderNo", "asc"),
          limit(2000)
        );

        unsubLines?.();
        unsubLines = onSnapshot(
          q,
          (qs) => {
            const next: OpenSalesLine[] = [];
            qs.forEach((d) => {
              const v = d.data() as any;
              next.push({
                id: d.id,
                salesOrderNo: String(v.salesOrderNo ?? ""),
                salespersonNo: String(v.salespersonNo ?? ""),
                customerNo: v.customerNo ?? "",
                orderDate: v.orderDate ?? null,

                shipToName: v.shipToName ?? "",
                shipToCity: v.shipToCity ?? "",
                shipToState: v.shipToState ?? "",
                shipToZipCode: v.shipToZipCode ?? "",

                itemCode: v.itemCode ?? "",
                itemCodeDesc: v.itemCodeDesc ?? "",
                quantityOrdered: Number(v.quantityOrdered ?? 0),

                importedAt: v.importedAt ?? null,
              });
            });

            setLines(next);
            setLoading(false);
          },
          (e) => {
            setErr(e?.message || String(e));
            setLoading(false);
          }
        );
      });

      return () => {
        unsubAuth();
        unsubLines?.();
      };
    } catch (e: any) {
      setErr(e?.message || String(e));
      setLoading(false);
      return () => {};
    }
  }, []);

const filtered = useMemo(() => {
  // ✅ Hide "195 Return Processing Fee"
  const withoutFees = lines.filter((l) => {
    const code = String(l.itemCode ?? "").trim();
    const desc = String(l.itemCodeDesc ?? "").toLowerCase();

    // hide exact item code 195 OR anything that contains that phrase
    if (code === "195") return false;
    if (desc.includes("return processing fee")) return false;

    return true;
  });

  const s = search.trim().toLowerCase();
  if (!s) return withoutFees;

  return withoutFees.filter((l) => {
    const hay = [
      l.salesOrderNo,
      l.customerNo,
      l.shipToName,
      l.shipToCity,
      l.shipToState,
      l.itemCode,
      l.itemCodeDesc,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return hay.includes(s);
  });
}, [lines, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, { orderDate: string; customerNo: string; shipTo: string; cityState: string; lines: OpenSalesLine[]; totalQty: number }>();
    for (const l of filtered) {
      const key = l.salesOrderNo || "(no order #)";
      const orderDate = tsToDateStr(l.orderDate);
      const shipTo = (l.shipToName || "").trim();
      const cityState = `${(l.shipToCity || "").trim()} ${(l.shipToState || "").trim()}`.trim();

      const g = map.get(key) ?? {
        orderDate,
        customerNo: l.customerNo || "",
        shipTo,
        cityState,
        lines: [],
        totalQty: 0,
      };
      g.lines.push(l);
      g.totalQty += Number(l.quantityOrdered ?? 0);
      // keep first non-empty values
      if (!g.orderDate && orderDate) g.orderDate = orderDate;
      if (!g.customerNo && l.customerNo) g.customerNo = l.customerNo;
      if (!g.shipTo && shipTo) g.shipTo = shipTo;
      if (!g.cityState && cityState) g.cityState = cityState;

      map.set(key, g);
    }

    // sort by order date desc (string mm/dd/yyyy; fall back to order #)
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      // try to sort by importedAt/orderDate from first line
      const ad = a[1].lines[0]?.orderDate?.toDate?.() ?? null;
      const bd = b[1].lines[0]?.orderDate?.toDate?.() ?? null;
      if (ad && bd) return bd.getTime() - ad.getTime();
      return String(a[0]).localeCompare(String(b[0]));
    });

    return entries;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Open Sales Orders</h1>
          <div className="text-sm text-gray-600">
            {salespersonNo ? (
              <>Salesperson: <span className="font-semibold">{salespersonNo}</span></>
            ) : (
              <>Salesperson: —</>
            )}
          </div>
        </div>

        <div className="w-full max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Search
          </label>
          <input
            className="w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring"
            placeholder="Order #, customer, ship-to, item..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-red-700">
          {err}
        </div>
      ) : null}

      {loading ? (
        <div className="text-gray-600">Loading…</div>
      ) : grouped.length === 0 ? (
        <div className="text-gray-600">
          No open sales orders found{salespersonNo ? ` for ${salespersonNo}` : ""}.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([orderNo, g]) => (
            <div key={orderNo} className="rounded-lg border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-[240px]">
                  <div className="text-lg font-semibold">{orderNo}</div>
                  <div className="text-sm text-gray-600">
                    {g.orderDate ? `Order Date: ${g.orderDate}` : "Order Date: —"}
                    {g.customerNo ? ` • Customer: ${g.customerNo}` : ""}
                  </div>
                  <div className="text-sm text-gray-600">
                    {g.shipTo ? g.shipTo : ""}
                    {g.cityState ? ` • ${g.cityState}` : ""}
                  </div>
                </div>

                <div className="text-sm">
                  <span className="rounded bg-gray-100 px-2 py-1">
                    Lines: <span className="font-semibold">{g.lines.length}</span>
                  </span>{" "}
                  <span className="rounded bg-gray-100 px-2 py-1">
                    Total Qty: <span className="font-semibold">{g.totalQty}</span>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="px-4 py-2 text-left">Item</th>
                      <th className="px-4 py-2 text-left">Description</th>
                      <th className="px-4 py-2 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map((l) => (
                      <tr key={l.id} className="border-t">
                        <td className="px-4 py-2 font-medium">{l.itemCode}</td>
                        <td className="px-4 py-2">{l.itemCodeDesc}</td>
                        <td className="px-4 py-2 text-right">
                          {Number(l.quantityOrdered ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
