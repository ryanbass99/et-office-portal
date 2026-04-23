"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getAuth } from "firebase/auth";

type TrendStatus = "new" | "shortlist" | "approved" | "rejected";
type TrendCategory =
  | "novelty_gm"
  | "toys"
  | "novelty_food"
  | "tech_accessories";

type TrendItem = {
  id: string;
  category: TrendCategory;
  title: string;
  keyword: string;
  status: TrendStatus;
  velocity: "Low" | "Medium" | "High";
  source: string;
  fitScore: number;
  notes: string;
};

export default function TikTokTrendsPage() {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<TrendStatus>("new");
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  const categories = [
    { key: "novelty_gm", title: "Novelty GM" },
    { key: "toys", title: "Toys" },
    { key: "novelty_food", title: "Novelty Food/Candy" },
    { key: "tech_accessories", title: "Tech Accessories" },
  ] as const;

  useEffect(() => {
    async function loadTrends() {
      const snap = await getDocs(collection(db, "tiktokTrendCandidates"));
      const data = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
      setTrends(data as TrendItem[]);
      setLoading(false);
    }

    loadTrends();
  }, []);

  async function changeStatus(id: string, nextStatus: TrendStatus) {
    const prev = trends;
    setSavingId(id);

    setTrends((p) =>
      p.map((t) => (t.id === id ? { ...t, status: nextStatus } : t))
    );

    try {
      await updateDoc(doc(db, "tiktokTrendCandidates", id), {
        status: nextStatus,
      });
    } catch {
      setTrends(prev);
      alert("Failed to update");
    } finally {
      setSavingId(null);
    }
  }

  async function handleImportTrends() {
    try {
      setImporting(true);
      setImportMessage("");

      const auth = getAuth();
      const user = auth.currentUser;

      if (!user) {
        throw new Error("No logged-in Firebase user");
      }

      const token = await user.getIdToken();

      const res = await fetch("/api/admin/tiktok-trends/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Import failed");
      }

      setImportMessage(
        `${data?.message || "Import complete"} | fetched: ${data?.fetched ?? 0} | created: ${data?.created ?? 0} | skipped: ${data?.skipped ?? 0}`
      );

      const snap = await getDocs(collection(db, "tiktokTrendCandidates"));
      const refreshed = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
      setTrends(refreshed as TrendItem[]);
    } catch (err: any) {
      setImportMessage(err?.message || "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function handlePasteImport() {
    if (!importText.trim()) return;

    const lines = importText.split("\n").filter(Boolean);

    setImporting(true);
    setImportMessage("");

    try {
      const created: TrendItem[] = [];

      for (const line of lines) {
        const [title, keyword, categoryRaw] = line
          .split("|")
          .map((s) => s.trim());

        const category =
          categoryRaw === "toys" ||
          categoryRaw === "novelty_food" ||
          categoryRaw === "tech_accessories"
            ? categoryRaw
            : "novelty_gm";

        const payload = {
          title,
          keyword,
          category,
          status: "new" as TrendStatus,
          velocity: "Medium" as const,
          source: "tiktok_import",
          fitScore: 0,
          notes: "",
        };

        const ref = await addDoc(collection(db, "tiktokTrendCandidates"), payload);

        created.push({
          id: ref.id,
          ...payload,
        });
      }

      setTrends((prev) => [...created, ...prev]);
      setImportText("");
      setShowImport(false);
      setImportMessage(`Paste import complete | created: ${created.length}`);
    } catch (err) {
      console.error(err);
      setImportMessage("Paste import failed");
    } finally {
      setImporting(false);
    }
  }

  const trendsByCategory = useMemo(() => {
    return categories
      .filter((c) => categoryFilter === "all" || c.key === categoryFilter)
      .map((c) => ({
        ...c,
        trends: trends.filter(
          (t) => t.category === c.key && t.status === statusFilter
        ),
      }));
  }, [trends, categoryFilter, statusFilter]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-start">
        <h1 className="text-2xl font-semibold">TikTok Trends</h1>

        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleImportTrends}
            disabled={importing}
            className="bg-black text-white px-4 py-2 rounded disabled:opacity-50"
            type="button"
          >
            {importing ? "Importing..." : "Import Trends"}
          </button>

          <button
            onClick={() => setShowImport((p) => !p)}
            className="text-sm underline"
            type="button"
          >
            {showImport ? "Hide Paste Import" : "Paste Import (Fallback)"}
          </button>

          {importMessage ? (
            <div className="text-sm text-right">{importMessage}</div>
          ) : null}
        </div>
      </div>

      {showImport && (
        <div className="border p-4 bg-white space-y-3">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            className="w-full border p-2 h-40"
            placeholder="title | hashtag | category"
          />

          <button
            onClick={handlePasteImport}
            disabled={importing}
            className="bg-black text-white px-4 py-2 rounded disabled:opacity-50"
            type="button"
          >
            {importing ? "Importing..." : "Run Paste Import"}
          </button>
        </div>
      )}

      <div className="flex gap-3">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="border px-3 py-2 rounded"
        >
          <option value="all">All</option>
          <option value="novelty_gm">GM</option>
          <option value="toys">Toys</option>
          <option value="novelty_food">Food</option>
          <option value="tech_accessories">Tech</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TrendStatus)}
          className="border px-3 py-2 rounded"
        >
          <option value="new">New</option>
          <option value="shortlist">Shortlist</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {loading && <p>Loading...</p>}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {trendsByCategory.map((cat) => (
          <div key={cat.key} className="border p-3">
            <h2 className="font-semibold mb-2">{cat.title}</h2>

            {cat.trends.map((t) => (
              <div key={t.id} className="border p-2 mb-2">
                <div>{t.title}</div>
                <div className="text-xs">{t.keyword}</div>

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => changeStatus(t.id, "shortlist")}
                    disabled={savingId === t.id}
                    className="border border-black px-2 py-1 text-sm rounded disabled:opacity-50"
                    type="button"
                  >
                    Shortlist
                  </button>
                  <button
                    onClick={() => changeStatus(t.id, "approved")}
                    disabled={savingId === t.id}
                    className="border border-black px-2 py-1 text-sm rounded disabled:opacity-50"
                    type="button"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => changeStatus(t.id, "rejected")}
                    disabled={savingId === t.id}
                    className="border border-black px-2 py-1 text-sm rounded disabled:opacity-50"
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
