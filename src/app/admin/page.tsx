"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getAuth } from "firebase/auth";

type LeadRow = {
  salesmanId: string;
  name: string;
  email: string;
  salesperson: string;
  entered: number;
  open: number;
  closed_no_lead: number;
  closed_account: number;
};

function formatLocalDate(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function firstDayOfMonth() {
  const now = new Date();
  return formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
}

function today() {
  return formatLocalDate(new Date());
}

export default function AdminPage() {
  const [start, setStart] = useState(firstDayOfMonth());
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadLeadsByDriver() {
    setLoading(true);
    setError("");

    try {
      const auth = getAuth();
      const user = auth.currentUser;

      if (!user) {
        throw new Error("You must be signed in to view lead totals.");
      }

      const token = await user.getIdToken();
      const res = await fetch(
        `/api/admin/leads-by-driver?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to load lead totals.");
      }

      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setTotalLeads(typeof data?.totalLeads === "number" ? data.totalLeads : 0);
    } catch (err: any) {
      setRows([]);
      setTotalLeads(0);
      setError(err?.message || "Failed to load lead totals.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLeadsByDriver();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.open += row.open || 0;
        acc.closedNoLead += row.closed_no_lead || 0;
        acc.closedAccount += row.closed_account || 0;
        return acc;
      },
      { open: 0, closedNoLead: 0, closedAccount: 0 }
    );
  }, [rows]);

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="rounded bg-white p-4 shadow">
        <div className="mb-3 text-sm text-gray-600">Admin Tools</div>

        <div className="flex flex-col gap-2">
          <Link
            href="/admin/usage"
            className="inline-flex items-center justify-between rounded border px-4 py-3 hover:bg-gray-50"
          >
            <span className="font-medium">Usage Dashboard</span>
            <span className="text-gray-500">→</span>
          </Link>

          <Link
            href="/admin/open-sales-orders"
            className="inline-flex items-center justify-between rounded border px-4 py-3 hover:bg-gray-50"
          >
            <span className="font-medium">Open Sales Orders</span>
            <span className="text-gray-500">→</span>
          </Link>
        </div>
      </div>

      <div className="rounded bg-white p-4 shadow">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-lg font-semibold">Leads Entered by Driver</div>
            <div className="text-sm text-gray-600">
              Shows all leads entered per driver for the selected timeframe.
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Start Date</label>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="rounded border px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">End Date</label>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="rounded border px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={loadLeadsByDriver}
              disabled={loading}
              className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Loading..." : "Apply"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded border p-3">
            <div className="text-xs text-gray-500">Total Leads</div>
            <div className="text-xl font-semibold">{totalLeads}</div>
          </div>

          <div className="rounded border p-3">
            <div className="text-xs text-gray-500">Open</div>
            <div className="text-xl font-semibold">{totals.open}</div>
          </div>

          <div className="rounded border p-3">
            <div className="text-xs text-gray-500">Closed - No Lead</div>
            <div className="text-xl font-semibold">{totals.closedNoLead}</div>
          </div>

          <div className="rounded border p-3">
            <div className="text-xs text-gray-500">Closed - Account</div>
            <div className="text-xl font-semibold">{totals.closedAccount}</div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 font-semibold">Driver</th>
                <th className="px-3 py-2 font-semibold">Rep #</th>
                <th className="px-3 py-2 font-semibold">Entered</th>
                <th className="px-3 py-2 font-semibold">Open</th>
                <th className="px-3 py-2 font-semibold">Closed No Lead</th>
                <th className="px-3 py-2 font-semibold">Closed Account</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                    No leads found for this timeframe.
                  </td>
                </tr>
              ) : null}

              {rows.map((row) => (
                <tr key={row.salesmanId} className="border-b last:border-b-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.name || row.salesmanId}</div>
                    {row.email ? <div className="text-xs text-gray-500">{row.email}</div> : null}
                  </td>
                  <td className="px-3 py-2">{row.salesperson || "-"}</td>
                  <td className="px-3 py-2">{row.entered}</td>
                  <td className="px-3 py-2">{row.open}</td>
                  <td className="px-3 py-2">{row.closed_no_lead}</td>
                  <td className="px-3 py-2">{row.closed_account}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
