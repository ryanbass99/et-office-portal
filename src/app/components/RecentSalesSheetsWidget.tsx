"use client";

import { useEffect, useState } from "react";

type RecentFile = {
  name: string;
  fileName: string;
  contentType: string;
  size: number;
  updated: string | null;
  url: string;
};

function fmtSize(bytes: number) {
  if (!bytes || bytes <= 0) return "";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

async function fetchJsonWithFallback(urls: string[]) {
  let lastErr: Error | null = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const text = await res.text();
      const trimmed = text.trim();

      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        throw new Error(`API ${res.status} non-JSON from ${url}: ${trimmed.slice(0, 120)}`);
      }

      const data = JSON.parse(trimmed);

      if (!res.ok) {
        throw new Error(data?.error || `API ${res.status} error from ${url}`);
      }

      return data;
    } catch (e: any) {
      lastErr = new Error(e?.message || String(e));
    }
  }

  throw lastErr || new Error("Failed to fetch from all endpoints.");
}

export default function RecentSalesSheetsWidget() {
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      const qs = "days=7&prefix=sales-sheets/";
      const endpoints = [
        `/api/storage/sales-sheets/recent?${qs}`,
        `/api/storage/recent?${qs}`,
      ];

      try {
        const data = await fetchJsonWithFallback(endpoints);
        const next = Array.isArray(data?.files) ? (data.files as RecentFile[]) : [];

        if (!cancelled) setFiles(next);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="bg-white rounded-lg shadow p-4 border border-black">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Recent Sales Sheets (last 7 days)</h2>
        <div className="text-xs text-gray-500">{files.length}</div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-600">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-600 whitespace-pre-wrap">{error}</div>
      ) : files.length === 0 ? (
        <div className="text-sm text-gray-600">No sales sheets uploaded in the last 7 days.</div>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <div key={f.name} className="border border-gray-200 rounded px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{f.fileName}</div>
                  <div className="text-xs text-gray-600">
                    {f.updated ? new Date(f.updated).toLocaleString() : ""}
                    {f.size ? ` • ${fmtSize(f.size)}` : ""}
                    {f.contentType ? ` • ${f.contentType}` : ""}
                  </div>
                </div>

                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs font-medium underline"
                >
                  Open
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}