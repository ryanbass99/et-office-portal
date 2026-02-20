"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  limit,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { db } from "@/lib/firebase"; // adjust if needed

type Salesperson = {
  code: string; // e.g. "0001"
  label: string; // e.g. "In House" or "Chris B"
};

type Line = {
  id: string;

  // common fields (your export may vary)
  salespersonNo?: string;

  orderNo?: string;
  salesOrderNo?: string;
  orderNumber?: string;

  orderDate?: any;

  customerNo?: string;
  customerName?: string;

  shipToNo?: string;
  shipToName?: string;
  shipToCity?: string;
  shipToState?: string;

  item?: string;
  itemCode?: string;
  description?: string;

  qty?: number;
  quantity?: number;
};

type OrderGroup = {
  orderKey: string;

  orderDate?: any;

  customerNo?: string;
  customerName?: string;

  shipToNo?: string;
  shipToName?: string;
  shipToCity?: string;
  shipToState?: string;

  lines: Line[];
  totalQty: number;
};

function getOrderKey(l: Line) {
  return (
    l.orderNo ||
    l.salesOrderNo ||
    l.orderNumber ||
    "" // fallback
  );
}

function getItemLabel(ln: any) {
  return (
    ln.itemCode ??
    ln.item ??
    ln.itemNo ??
    ln.itemNumber ??
    ln.Item ??
    ln.ItemCode ??
    ""
  );
}

function getDescLabel(ln: any) {
  return (
    ln.itemCodeDesc ?? // ✅ your Firestore field name
    ln.description ??
    ln.desc ??
    ln.itemDescription ??
    ln.itemDesc ??
    ln.Description ??
    ln.ItemDescription ??
    ""
  );
}

function getQty(ln: any) {
  const v =
    ln.qty ??
    ln.quantity ??
    ln.orderQty ??
    ln.qtyOrdered ??
    ln.quantityOrdered ??
    ln.Qty ??
    ln.Quantity ??
    0;

  return typeof v === "number" ? v : Number(v) || 0;
}

function safeDateLabel(v: any) {
  try {
    if (!v) return "";
    if (v?.toDate) return v.toDate().toLocaleDateString();
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
    return String(v);
  } catch {
    return String(v ?? "");
  }
}

export default function AdminOpenSalesOrdersPage() {
  const [role, setRole] = useState<string | null>(null);
  const isAdmin = role === "admin";

  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [selectedCode, setSelectedCode] = useState<string>("0001"); // default In House

  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [orders, setOrders] = useState<OrderGroup[]>([]);

  // auth role
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRole(null);
        return;
      }
      const snap = await getDoc(doc(db, "users", user.uid));
      setRole((snap.exists() ? (snap.data().role as string) : null) ?? null);
    });
    return () => unsub();
  }, []);

  // load pill list from users (DEDUPED by salesperson code)
  useEffect(() => {
    if (!isAdmin) return;

    (async () => {
      const snap = await getDocs(collection(db, "users"));

      const map = new Map<string, string>(); // code -> label
      for (const d of snap.docs) {
        const data: any = d.data();
        const code = (data.salesperson || data.salespersonNo || "").toString().trim();
        if (!code) continue;

        // label "0001" as In House always
        if (code === "0001") {
          map.set(code, "In House");
          continue;
        }

        // otherwise best-available name
        const name = (data.name || data.displayName || data.email || code).toString().trim();
        // only set if not already present (first wins)
        if (!map.has(code)) map.set(code, name);
      }

      // Ensure 0001 exists as a pill even if missing from users
      if (!map.has("0001")) map.set("0001", "In House");

      const rows: Salesperson[] = Array.from(map.entries())
        .map(([code, label]) => ({ code, label }))
        .sort((a, b) => {
          if (a.code === "0001" && b.code !== "0001") return -1;
          if (a.code !== "0001" && b.code === "0001") return 1;
          return a.label.localeCompare(b.label);
        });

      setSalespeople(rows);
    })();
  }, [isAdmin]);

  // load orders for selected rep by querying LINES and grouping by orderNo
  useEffect(() => {
    if (!isAdmin) return;

    (async () => {
      setLoading(true);
      try {
        // NOTE: your screenshot shows salespersonNo in openSalesOrderStats.
        // Your lines almost certainly use salespersonNo too.
        const qLines = query(
          collection(db, "openSalesOrderLines"),
          where("salespersonNo", "==", selectedCode),
          limit(2500) // adjust if needed; admin view can be heavy
        );

        const snap = await getDocs(qLines);
        const lines: Line[] = snap.docs
  .map((d) => ({ id: d.id, ...(d.data() as any) }))
  .filter((ln: any) => String(ln.itemCode ?? ln.item ?? "").trim() !== "195");


        const byOrder = new Map<string, OrderGroup>();

        for (const ln of lines) {
          const orderKey = getOrderKey(ln);
          if (!orderKey) continue;

          const existing = byOrder.get(orderKey);
          if (!existing) {
            byOrder.set(orderKey, {
              orderKey,
              orderDate: ln.orderDate,
              customerNo: ln.customerNo,
              customerName: ln.customerName,
              shipToNo: ln.shipToNo,
              shipToName: ln.shipToName,
              shipToCity: ln.shipToCity,
              shipToState: ln.shipToState,
              lines: [ln],
              totalQty: getQty(ln),
            });
          } else {
            existing.lines.push(ln);
            existing.totalQty += getQty(ln);

            // fill missing header fields if later lines have them
            existing.orderDate ??= ln.orderDate;
            existing.customerNo ??= ln.customerNo;
            existing.customerName ??= ln.customerName;
            existing.shipToNo ??= ln.shipToNo;
            existing.shipToName ??= ln.shipToName;
            existing.shipToCity ??= ln.shipToCity;
            existing.shipToState ??= ln.shipToState;
          }
        }

        // sort newest first (best-effort)
        const rows = Array.from(byOrder.values()).sort((a, b) => {
          const ad = a.orderDate?.toDate ? a.orderDate.toDate().getTime() : new Date(a.orderDate || 0).getTime();
          const bd = b.orderDate?.toDate ? b.orderDate.toDate().getTime() : new Date(b.orderDate || 0).getTime();
          return (bd || 0) - (ad || 0);
        });

        setOrders(rows);
      } finally {
        setLoading(false);
      }
    })();
  }, [isAdmin, selectedCode]);

  const filteredOrders = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return orders;

    return orders.filter((o) => {
      const hay = [
        o.orderKey,
        o.customerNo,
        o.customerName,
        o.shipToNo,
        o.shipToName,
        o.shipToCity,
        o.shipToState,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(s);
    });
  }, [orders, search]);

  if (role === null) return <div className="p-6">Loading…</div>;

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Open Sales Orders</h1>
        <div className="text-sm text-gray-600">You don’t have access to this page.</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Open Sales Orders</h1>
          <div className="text-sm text-gray-600">
  Salesperson: {selectedCode}
</div>
<div className="text-sm text-gray-600">
  Total Open Orders: {filteredOrders.length}
</div>

        </div>

        <div className="w-full max-w-md">
          <div className="text-sm font-semibold mb-1">Search</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Order #, customer, ship-to, item…"
            className="w-full border rounded px-3 py-2"
          />
        </div>
      </div>

      {/* Pills */}
      <div className="flex flex-wrap gap-2">
        {salespeople.map((sp) => (
          <button
            key={sp.code}
            type="button"
            onClick={() => setSelectedCode(sp.code)}
            className={`px-3 py-1 rounded-full border text-sm ${
              selectedCode === sp.code ? "bg-gray-900 text-white border-gray-900" : "bg-white"
            }`}
            title={`Salesperson: ${sp.code}`}
          >
            {sp.label}
          </button>
        ))}
      </div>

      {/* Orders */}
      {loading ? (
        <div className="text-sm text-gray-600">Loading open orders…</div>
      ) : filteredOrders.length === 0 ? (
        <div className="text-sm text-gray-600">No open orders found.</div>
      ) : (
        <div className="space-y-4">
          {filteredOrders.map((o) => (
            <div key={o.orderKey} className="bg-white rounded border overflow-hidden">
              <div className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-bold">{o.orderKey}</div>
                  <div className="text-sm text-gray-700">
                    {o.orderDate ? `Order Date: ${safeDateLabel(o.orderDate)}` : ""}
                    {o.customerNo ? ` • Customer: ${o.customerNo}` : ""}
                  </div>
                  <div className="text-sm text-gray-700">
                    {o.shipToName || o.customerName || ""}
                    {o.shipToCity || o.shipToState
                      ? ` • ${(o.shipToCity || "").toString()} ${(o.shipToState || "").toString()}`.trim()
                      : ""}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  
                  <span className="text-sm bg-gray-100 px-2 py-1 rounded">Total Qty: {o.totalQty}</span>
                </div>
              </div>

              <div className="border-t">
                <div className="grid grid-cols-[220px_1fr_120px] px-4 py-2 text-sm font-semibold">
                  <div>Item</div>
                  <div>Description</div>
                  <div className="text-right">Qty</div>
                </div>

                {o.lines.map((ln) => (
                  <div
                    key={ln.id}
                    className="grid grid-cols-[220px_1fr_120px] px-4 py-2 text-sm border-t"
                  >
                    <div>{getItemLabel(ln)}</div>
                    <div>{getDescLabel(ln)}</div>
                    <div className="text-right">{getQty(ln) || ""}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
