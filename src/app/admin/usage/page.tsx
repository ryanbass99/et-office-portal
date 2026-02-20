"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function daysBetweenInclusive(startISO: string, endISO: string) {
  const s = new Date(startISO + "T00:00:00");
  const e = new Date(endISO + "T23:59:59");
  const diff = e.getTime() - s.getTime();
  const days = Math.floor(diff / (24 * 60 * 60 * 1000)) + 1;
  return clamp(days, 1, 365);
}

export default function AdminUsagePage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  const todayISO = useMemo(() => toISODate(new Date()), []);
  const defaultStartISO = useMemo(
    () => toISODate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)),
    []
  );

  const [startDate, setStartDate] = useState<string>(defaultStartISO);
  const [endDate, setEndDate] = useState<string>(todayISO);

  const days = useMemo(
    () => daysBetweenInclusive(startDate, endDate),
    [startDate, endDate]
  );

  useEffect(() => {
    let unsub: (() => void) | null = null;

    unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setErr("Not signed in.");
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setErr(null);

        const idToken = await user.getIdToken(true);

        const res = await fetch(`/api/admin/usage?start=${startDate}&end=${endDate}&days=${days}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });

        const json = await res.json();

        if (!res.ok) {
          setErr(json?.error || "Request failed");
          setData(null);
        } else {
          setData(json);
        }
      } catch (e: any) {
        setErr(e?.message || "Unknown error");
        setData(null);
      } finally {
        setLoading(false);
      }
    });

    return () => {
      if (unsub) unsub();
    };
  }, [startDate, endDate, days]);

  if (loading) return <div className="p-6">Loading…</div>;
  if (err) return <div className="p-6 text-red-600">{err}</div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-bold">Admin Usage Dashboard</h1>

        {/* Date range */}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-xs text-gray-500 mb-1">Start</div>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border rounded px-3 py-2 text-sm"
              max={endDate}
            />
          </div>

          <div>
            <div className="text-xs text-gray-500 mb-1">End</div>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border rounded px-3 py-2 text-sm"
              min={startDate}
              max={todayISO}
            />
          </div>

          <div className="text-sm text-gray-600 pb-2">
            Showing{" "}
            <span className="font-semibold">{days}</span> day
            {days === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-white shadow rounded p-4">
          <div className="text-sm text-gray-500">
            Total Sessions ({days} days)
          </div>
          <div className="text-2xl font-bold">{data.totals.sessions}</div>
        </div>

        <div className="bg-white shadow rounded p-4">
          <div className="text-sm text-gray-500">Total Active Hours</div>
          <div className="text-2xl font-bold">{data.totals.activeHours}</div>
        </div>
      </div>

      {/* Hours Per Rep */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Hours Per Rep</h2>
        <table className="w-full text-sm bg-white shadow rounded">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-2">Rep</th>
              <th className="text-left p-2">Salesman ID</th>
              <th className="text-right p-2">Hours</th>
              <th className="text-right p-2">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {data.hoursPerRep.map((r: any) => (
              <tr
                key={`${r.uid}-${r.salesmanId ?? "none"}`}
                className="border-t"
              >
                <td className="p-2">{r.name || "-"}</td>
                <td className="p-2">{r.salesmanId || "-"}</td>
                <td className="p-2 text-right">{r.hours}</td>
                <td className="p-2 text-right">{r.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Exports Per Rep */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Exports Per Rep</h2>
        <table className="w-full text-sm bg-white shadow rounded">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-2">Rep</th>
              <th className="text-left p-2">Salesman ID</th>
              <th className="text-right p-2">Exports</th>
            </tr>
          </thead>
          <tbody>
            {data.exportsPerRep.map((r: any) => (
              <tr
                key={`${r.uid}-${r.salesmanId ?? "none"}`}
                className="border-t"
              >
                <td className="p-2">{r.name || "-"}</td>
                <td className="p-2">{r.salesmanId || "-"}</td>
                <td className="p-2 text-right">{r.exports}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Page Usage */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Page Usage</h2>
        <table className="w-full text-sm bg-white shadow rounded">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-2">Path</th>
              <th className="text-right p-2">Hours</th>
              <th className="text-right p-2">Sessions</th>
              <th className="text-right p-2">Exports</th>
            </tr>
          </thead>
          <tbody>
            {data.pageUsage.map((p: any) => (
              <tr key={p.path} className="border-t">
                <td className="p-2">{p.path}</td>
                <td className="p-2 text-right">{p.hours}</td>
                <td className="p-2 text-right">{p.sessions}</td>
                <td className="p-2 text-right">{p.exports}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

{/* Page Usage By Rep */}
<div>
  <h2 className="text-lg font-semibold mb-3">Page Usage By Rep</h2>

  {data.pageUsageByRep.map((rep: any) => (
    <div key={`${rep.uid}-${rep.salesmanId ?? "none"}`} className="mb-6">
      <div className="font-medium mb-2">
        {rep.name} ({rep.salesmanId || "-"})
      </div>

      <table className="w-full text-sm bg-white shadow rounded">
        <thead className="bg-gray-100">
          <tr>
            <th className="text-left p-2">Path</th>
            <th className="text-right p-2">Hours</th>
            <th className="text-right p-2">Sessions</th>
            <th className="text-right p-2">Exports</th>
          </tr>
        </thead>
        <tbody>
          {rep.pages.map((p: any) => (
            <tr key={p.path} className="border-t">
              <td className="p-2">{p.path}</td>
              <td className="p-2 text-right">{p.hours}</td>
              <td className="p-2 text-right">{p.sessions}</td>
              <td className="p-2 text-right">{p.exports}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ))}
</div>


    </div>
  );
}
