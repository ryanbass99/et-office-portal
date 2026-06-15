"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  collection,
  getDocs,
  getFirestore,
  query,
  where,
} from "firebase/firestore";
import { getApps } from "firebase/app";

function getOrderDateValue(row: any) {
  return (
    row?.orderDate ||
    row?.salesOrderDate ||
    row?.orderDateTs ||
    row?.salesOrderDateTs ||
    row?.date ||
    row?.createdAt ||
    null
  );
}

function dateToMillis(value: any) {
  if (!value) return 0;

  // Firestore Timestamp
  if (typeof value?.toDate === "function") {
    return value.toDate().getTime();
  }

  // Raw Firestore timestamp object
  if (typeof value?.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  }

  // JS Date
  if (value instanceof Date) {
    return value.getTime();
  }

  // String / number
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value: any) {
  const ms = dateToMillis(value);
  if (!ms) return "";

  return new Date(ms).toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

export default function SalesOrdersPage() {
  const searchParams = useSearchParams();
  const customerNo = searchParams.get("customerNo") || "";

  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadOrders() {
      try {
        const app = getApps()[0];
        const db = getFirestore(app);

        const q = query(
          collection(db, "openSalesOrderLines"),
          where("customerNo", "==", customerNo)
        );

        const snap = await getDocs(q);

        const rows = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        rows.sort((a: any, b: any) => {
          const dateDiff =
            dateToMillis(getOrderDateValue(b)) - dateToMillis(getOrderDateValue(a));

          if (dateDiff !== 0) return dateDiff;

          const soA = String(a.salesOrderNo || "");
          const soB = String(b.salesOrderNo || "");

          if (soA !== soB) return soB.localeCompare(soA);

          const itemA = String(a.itemCode || "");
          const itemB = String(b.itemCode || "");
          return itemA.localeCompare(itemB);
        });

        setOrders(rows);
      } finally {
        setLoading(false);
      }
    }

    if (customerNo) {
      loadOrders();
    } else {
      setLoading(false);
    }
  }, [customerNo]);

  const groupedOrders = useMemo(() => {
    const grouped = orders.reduce((acc: Record<string, any[]>, row: any) => {
      const so = String(row.salesOrderNo || "Unknown");

      if (!acc[so]) acc[so] = [];
      acc[so].push(row);

      return acc;
    }, {});

    return Object.entries(grouped).sort(([, a]: any, [, b]: any) => {
      const dateA = dateToMillis(getOrderDateValue(a?.[0]));
      const dateB = dateToMillis(getOrderDateValue(b?.[0]));

      if (dateA !== dateB) return dateB - dateA;

      return String(b?.[0]?.salesOrderNo || "").localeCompare(
        String(a?.[0]?.salesOrderNo || "")
      );
    });
  }, [orders]);

  const openOrderCount = groupedOrders.length;

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link href="/customers" className="text-blue-600 hover:underline">
          ← Back to Customers
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Open Sales Orders</h1>
        <div className="text-gray-500 mt-1">Customer: {customerNo}</div>
      </div>

      {loading && <div>Loading orders...</div>}

      {!loading && (
        <>
          <div className="mb-6">
            <div className="rounded-lg border p-4 max-w-sm">
              <div className="text-sm text-gray-500">Open Orders</div>
              <div className="text-2xl font-bold">{openOrderCount}</div>
            </div>
          </div>

          {orders.length === 0 ? (
            <div>No open sales orders found.</div>
          ) : (
            groupedOrders.map(([so, lines]: any) => {
              const orderDate = formatDate(getOrderDateValue(lines?.[0]));

              return (
                <div
                  key={so}
                  className="border rounded-lg mb-6 overflow-hidden"
                >
                  <div className="bg-gray-100 px-4 py-3 flex justify-between gap-4">
                    <div className="font-bold">Sales Order #{so}</div>
                    <div className="text-sm text-gray-600">{orderDate}</div>
                  </div>

                  <table className="min-w-full text-sm">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 text-left">Item</th>
                        <th className="px-3 py-2 text-left">Description</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                      </tr>
                    </thead>

                    <tbody>
                      {lines.map((o: any) => (
                        <tr key={o.id} className="border-t hover:bg-gray-50">
                          <td className="px-3 py-2">{o.itemCode}</td>
                          <td className="px-3 py-2">{o.itemCodeDesc}</td>
                          <td className="px-3 py-2 text-right">
                            {Number(o.quantityOrdered || 0).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
