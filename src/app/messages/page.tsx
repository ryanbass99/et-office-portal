"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collectionGroup,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "../../lib/firebase";

type RangeKey = "7" | "30" | "90" | "365" | "all";

type Line = {
  id: string;
  invoiceNo: string;
  invoiceDate?: Timestamp | null;
  customerNo?: string | null;
  salespersonNo?: string | null;

  itemCode?: string | null;
  itemCodeDesc?: string | null;
  quantityShipped?: number | null;
};

function formatDate(ts?: Timestamp | null) {
  if (!ts) return "";
  return ts.toDate().toLocaleDateString();
}

function daysAgoTimestamp(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return Timestamp.fromDate(d);
}

export default function MessagesPage() {
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState<string>("");

  const [range, setRange] = useState<RangeKey>("30");
  const [signedIn, setSignedIn] = useState(false);

  async function loadLines(activeRange: RangeKey) {
    try {
      setErr("");
      setLoading(true);

      const base = [
        collectionGroup(db, "lines"),
        orderBy("invoiceDate", "desc"),
        limit(200),
      ] as const;

      const q =
        activeRange === "all"
          ? query(...base)
          : query(
              collectionGroup(db, "lines"),
              where("invoiceDate", ">=", daysAgoTimestamp(Number(activeRange))),
              orderBy("invoiceDate", "desc"),
              limit(200)
            );

      const snap = await getDocs(q);

      const rows: Line[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          invoiceNo: String(data.invoiceNo ?? ""),
          invoiceDate: data.invoiceDate ?? null,
          customerNo: data.customerNo ?? null,
          salespersonNo: data.salespersonNo ?? null,
          itemCode: data.itemCode ?? null,
          itemCodeDesc: data.itemCodeDesc ?? null,
          quantityShipped:
            typeof data.quantityShipped === "number"
              ? data.quantityShipped
              : Number(data.quantityShipped ?? 0),
        };
      });

      setLines(rows);
    } catch (e: any) {
      setErr(`${e?.code ?? ""} ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setSignedIn(!!user);
      if (user) {
        loadLines(range);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    loadLines(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, signedIn]);

  const totalQty = useMemo(
    () => lines.reduce((sum, r) => sum + (r.quantityShipped || 0), 0),
    [lines]
  );

  const buttons: { key: RangeKey; label: string }[] = [
    { key: "7", label: "7D" },
    { key: "30", label: "30D" },
    { key: "90", label: "90D" },
    { key: "365", label: "1Y" },
    { key: "all", label: "All" },
  ];

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Items Purchased (All)</h1>

      {/* Filter buttons */}
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {buttons.map((b) => {
          const active = range === b.key;
          return (
            <button
              key={b.key}
              onClick={() => setRange(b.key)}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: active ? "#111" : "#fff",
                color: active ? "#fff" : "#111",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {b.label}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 8, opacity: 0.8 }}>
        Showing latest <b>{lines.length}</b> lines • Total qty: <b>{totalQty}</b>
      </div>

      {loading && <div style={{ marginTop: 16 }}>Loading…</div>}
      {!!err && (
        <div style={{ marginTop: 16, color: "crimson" }}>
          Error: {err}
        </div>
      )}

      {!loading && !err && (
        <div style={{ marginTop: 16, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Date", "Invoice", "Customer", "Item", "Description", "Qty"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: "10px 8px",
                      fontWeight: 700,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((r) => (
                <tr key={r.id}>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {formatDate(r.invoiceDate)}
                  </td>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {r.invoiceNo}
                  </td>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {r.customerNo ?? ""}
                  </td>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {r.itemCode ?? ""}
                  </td>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {r.itemCodeDesc ?? ""}
                  </td>
                  <td style={{ borderBottom: "1px solid #f0f0f0", padding: "10px 8px" }}>
                    {r.quantityShipped ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
