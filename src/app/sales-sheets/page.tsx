"use client";

import { useEffect, useMemo, useState } from "react";

type Sheet = {
  name: string;
  path: string; // storage path like "sales-sheets/All Dubai Chocolates.pdf"

  // Optional metadata (depends on what /api/sales-sheets returns)
  updatedAt?: any;
  updated?: any;
  lastModified?: any;
  timeCreated?: any;
  createdAt?: any;
};

const PROD_BASE_URL = "https://portal.etproductsinc.com";

function isPrivateOrigin(origin: string) {
  // Matches common private ranges + localhost
  return (
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    /^https?:\/\/192\.168\./i.test(origin) ||
    /^https?:\/\/10\./i.test(origin) ||
    /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\./i.test(origin)
  );
}

function toMillis(v: any): number {
  if (!v) return 0;

  // Firestore Timestamp
  if (typeof v === "object" && typeof v.toMillis === "function") {
    try {
      return v.toMillis();
    } catch {
      return 0;
    }
  }

  // Date object
  if (v instanceof Date) return v.getTime();

  // number epoch (seconds or ms)
  if (typeof v === "number") {
    // if it's in seconds, convert to ms
    return v < 10_000_000_000 ? v * 1000 : v;
  }

  // string (ISO, RFC, etc.)
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }

  return 0;
}

function modifiedMillis(s: Sheet): number {
  // Try common fields that APIs/storage metadata might return
  return (
    toMillis((s as any).updatedAt) ||
    toMillis((s as any).updated) ||
    toMillis((s as any).lastModified) ||
    toMillis((s as any).timeCreated) ||
    toMillis((s as any).createdAt) ||
    0
  );
}

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
    const filtered = !s
      ? all
      : all.filter((x) => x.name.toLowerCase().includes(s));

    // ✅ Newest first (date modified/updated)
    return [...filtered].sort((a, b) => {
      const bt = modifiedMillis(b);
      const at = modifiedMillis(a);
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name);
    });
  }, [q, all]);

  // ✅ Build a clean base URL for email links:
  // - If you're on a private LAN host, use PROD domain so the email looks professional.
  // - Otherwise use the current origin.
  const emailBaseUrl =
    typeof window !== "undefined"
      ? isPrivateOrigin(window.location.origin)
        ? PROD_BASE_URL
        : window.location.origin
      : PROD_BASE_URL;

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

            // ✅ Email link uses clean domain (prod if you're on LAN)
            const absoluteOpenUrl = `${emailBaseUrl}${openUrl}`;

            // ✅ You asked for ONLY the link in the body
            const subject = `ET Products Sales Sheet: ${s.name}`;
            const mailto = `mailto:?subject=${encodeURIComponent(
              subject
            )}&body=${encodeURIComponent(absoluteOpenUrl)}`;

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
