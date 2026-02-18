
"use client";

import { useEffect, useMemo, useState } from "react";

type Sheet = {
  name: string;
  path: string; // ✅ storage path like "sales-sheets/All Dubai Chocolates.pdf"
};

export default function SalesSheetsPage() {
  const [all, setAll] = useState<Sheet[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setErr(null);

        const res = await fetch("/api/sales-sheets", { cache: "no-store" });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Failed to load sales sheets (${res.status}): ${txt}`);
        }

        const data = await res.json();
        const items = (data?.sheets ?? []) as Sheet[];
        if (!cancelled) setAll(items);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter((x) => x.name.toLowerCase().includes(s));
  }, [q, all]);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Sales Sheets</h1>

      <div className="max-w-md">
        <label className="mb-1 block text-xs text-gray-600">Search</label>

        <div className="relative">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by file name or Item Code..."
            className="w-full rounded-md border px-3 py-2 pr-10 text-sm outline-none focus:ring-2"
          />

          {q ? (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-600">Loading…</p>
      ) : err ? (
        <p className="text-sm text-red-600">{err}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-600">No matching sales sheets.</p>
      ) : (
        <div className="divide-y rounded-md border bg-white">
          {items.map((s) => {
            const openUrl = `/api/sales-sheets/open?path=${encodeURIComponent(
              s.path
            )}`;

            // Since you're currently on LAN, keep your IP here so the email link works for you.
            // When you go live, swap this to your real domain.
            const absoluteOpenUrl = `http://192.168.168.135:3000${openUrl}`;

          const mailto = `mailto:?subject=${encodeURIComponent(
  `ET Products Sales Sheet: ${s.name}`
)}&body=${encodeURIComponent(`${absoluteOpenUrl}`)}`;



            return (
              <div
                key={s.path}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-xs text-gray-500">{s.path}</div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    View
                  </a>

                  <a
                    href={mailto}
                    className="rounded-md bg-black px-3 py-1.5 text-sm text-white hover:opacity-90"
                  >
                    Email
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
