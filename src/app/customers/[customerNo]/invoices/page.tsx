"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useParams } from "next/navigation";
import Link from "next/link";

type Invoice = {
  id: string;
  invoiceNo?: string;
  invoiceDate?: any; // Firestore Timestamp
  nonTaxableSalesAmt?: number;
  comment?: string;
};

type InvoiceLine = {
  id: string;
  itemCode?: string;
  itemCodeDesc?: string;
  quantityShipped?: number;
  unitPrice?: number;
  extensionAmt?: number;
  discount?: number;
  productLine?: string;
  warehouseCode?: string;
  aliasItemNo?: string;
  commentText?: string;
};

function money(v: any) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatDate(ts: any) {
  if (!ts) return "";
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d instanceof Date && !isNaN(d.getTime()) ? d.toLocaleDateString() : "";
  } catch {
    return "";
  }
}

export default function CustomerInvoicesPage() {
  const params = useParams();
  const customerNo = params?.customerNo as string;

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  useEffect(() => {
    if (!customerNo) return;

    async function loadInvoices() {
      setLoading(true);
      try {
        const q = query(
          collection(db, "invoices"),
          where("customerNo", "==", customerNo),
          orderBy("invoiceDate", "desc")
        );

        const snap = await getDocs(q);

        const rows: Invoice[] = snap.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as any),
        }));

        setInvoices(rows);
      } catch (err) {
        console.error("Error loading invoices:", err);
        setInvoices([]);
      } finally {
        setLoading(false);
      }
    }

    loadInvoices();
  }, [customerNo]);

  async function openInvoice(inv: Invoice) {
    setSelectedInvoice(inv);
    setLines([]);
    setLinesLoading(true);

    try {
      const invoiceId = inv.invoiceNo || inv.id;

      // NOTE: avoid orderBy to prevent needing indexes; sort in JS
      const snap = await getDocs(
        collection(db, "invoices", invoiceId, "lines")
      );

      const rows: InvoiceLine[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      // Only show lines with a positive extension amount (hides duplicate $0 rows)
      const filtered = rows.filter((l) => (Number(l.extensionAmt) || 0) > 0);

      filtered.sort((a, b) => {
        const ad = (a.itemCodeDesc || "").toLowerCase();
        const bd = (b.itemCodeDesc || "").toLowerCase();
        if (ad < bd) return -1;
        if (ad > bd) return 1;
        return (a.itemCode || "").localeCompare(b.itemCode || "");
      });

      setLines(filtered);
    } catch (err) {
      console.error("Error loading invoice lines:", err);
      setLines([]);
    } finally {
      setLinesLoading(false);
    }
  }

  const linesSummary = useMemo(() => {
    const qty = lines.reduce((sum, l) => sum + (Number(l.quantityShipped) || 0), 0);
    const ext = lines.reduce((sum, l) => sum + (Number(l.extensionAmt) || 0), 0);
    const uniqueItems = new Set(lines.map((l) => l.itemCode || "").filter(Boolean)).size;
    return { qty, ext, uniqueItems };
  }, [lines]);

  return (
    <div className="p-6">
      {/* main content width (looks better than full bleed) */}
      <div className="max-w-3xl w-full">
        <div className="mb-4">
          <Link href="/customers" className="text-sm text-blue-600 hover:underline">
            ← Back to Customers
          </Link>
        </div>

        <h1 className="text-2xl font-bold mb-6">Invoices — {customerNo}</h1>

        {loading && <div>Loading invoices...</div>}

        {!loading && invoices.length === 0 && (
          <div className="text-gray-500">No invoices found.</div>
        )}

        {!loading && invoices.length > 0 && (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-100 text-left">
                <tr>
                  <th className="px-4 py-2">Invoice #</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Comment</th>
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const invoiceId = inv.invoiceNo || inv.id;
                  return (
                    <tr
                      key={inv.id}
                      className="border-t hover:bg-gray-50 cursor-pointer"
                      onClick={() => openInvoice(inv)}
                      title="Click to view lines"
                    >
                      <td className="px-4 py-2 font-medium">{invoiceId}</td>
                      <td className="px-4 py-2 tabular-nums">{formatDate(inv.invoiceDate)}</td>
                      <td className="px-4 py-2">
                        {inv.comment ? (
                          <span className="text-gray-600">{inv.comment}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {money(inv.nonTaxableSalesAmt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right-side drawer (Call Prep style) */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50">
          {/* overlay */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSelectedInvoice(null)}
          />
          {/* panel */}
          <aside className="absolute right-0 top-0 h-full w-[420px] max-w-[90vw] bg-white shadow-xl border-l">
            <div className="p-4 border-b flex items-start justify-between">
              <div>
                <div className="font-semibold">
                  Invoice • {selectedInvoice.invoiceNo || selectedInvoice.id}
                </div>
                <div className="text-xs text-gray-500 tabular-nums">
                  {formatDate(selectedInvoice.invoiceDate)} • Total {money(selectedInvoice.nonTaxableSalesAmt)}
                </div>
              </div>

              <button
                type="button"
                className="text-gray-600 hover:text-gray-900 text-xl leading-none"
                onClick={() => setSelectedInvoice(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto h-[calc(100%-56px)]">
              {/* Snapshot */}
              <div className="border rounded p-3">
                <div className="font-semibold text-sm mb-2">Snapshot</div>
                <div className="text-sm text-gray-700 space-y-1">
                  <div>
                    <span className="text-gray-500">Comment:</span>{" "}
                    {selectedInvoice.comment ? selectedInvoice.comment : "—"}
                  </div>
                  <div>
                    <span className="text-gray-500">Lines:</span>{" "}
                    {linesLoading ? "Loading…" : lines.length.toLocaleString()}
                  </div>
                  <div>
                    <span className="text-gray-500">Unique items:</span>{" "}
                    {linesLoading ? "—" : linesSummary.uniqueItems.toLocaleString()}
                  </div>
                  <div>
                    <span className="text-gray-500">Total qty:</span>{" "}
                    {linesLoading ? "—" : linesSummary.qty.toLocaleString()}
                  </div>
                  <div>
                    <span className="text-gray-500">Lines total:</span>{" "}
                    {linesLoading ? "—" : money(linesSummary.ext)}
                  </div>
                </div>
              </div>

              {/* Lines */}
              <div className="border rounded overflow-hidden">
                <div className="px-3 py-2 bg-gray-100 font-semibold text-sm">
                  Invoice Lines
                </div>

                {linesLoading ? (
                  <div className="p-3 text-sm text-gray-600">Loading lines…</div>
                ) : lines.length === 0 ? (
                  <div className="p-3 text-sm text-gray-500">No lines found.</div>
                ) : (
                  <div className="max-h-[55vh] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-white sticky top-0">
                        <tr className="text-left border-b">
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Description</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Ext</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l) => (
                          <tr key={l.id} className="border-b align-top">
                            <td className="px-3 py-2 whitespace-nowrap">
                              {l.itemCode || "—"}
                            </td>
                            <td className="px-3 py-2">
                              <div className="text-gray-900">
                                {l.itemCodeDesc || "—"}
                              </div>
                              {l.commentText ? (
                                <div className="text-gray-500 mt-0.5">
                                  {l.commentText}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {(Number(l.quantityShipped) || 0).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {money(l.extensionAmt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Footer actions (optional later) */}
              {/* <div className="text-xs text-gray-400">More actions coming…</div> */}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
