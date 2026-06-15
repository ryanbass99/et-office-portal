"use client";

import { useEffect, useState } from "react";
import {
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import React from "react";

type Trend = {
  id: string;
  productName: string;
  category: string;
  source: string;
  mentions: number;
  growthPercent: number;
  score: number;
  status: string;
  notes?: string;
};

export default function TrendsPage() {
  const [trends, setTrends] = useState<Trend[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [trendCandidates, setTrendCandidates] = useState<any[]>([]);
  const [findingTrends, setFindingTrends] = useState(false);
  const [importedCandidates, setImportedCandidates] = useState<string[]>([]);
  const [expandedTrend, setExpandedTrend] = useState<string | null>(null);
  const [searchCategory, setSearchCategory] = useState("All");

  const watchingCount = trends.filter((t) => t.status === "Watching").length;
  const sourcingCount = trends.filter((t) => t.status === "Sourcing").length;
  const orderedCount = trends.filter((t) => t.status === "Ordered").length;
  const rejectedCount = trends.filter((t) => t.status === "Rejected").length;

  const [newTrend, setNewTrend] = useState({
    productName: "",
    category: "",
    source: "TikTok",
    mentions: 0,
    growthPercent: 0,
    score: 0,
    status: "Watching",
    notes: "",
  });

  useEffect(() => {
    loadTrends();
  }, []);

  async function loadTrends() {
    const snap = await getDocs(collection(db, "trendScout"));

    const data = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Trend[];

    data.reverse();
    setTrends(data);
    setLoading(false);
  }

  async function saveTrend() {
    await addDoc(collection(db, "trendScout"), {
      ...newTrend,
      createdAt: new Date(),
    });

    setNewTrend({
      productName: "",
      category: "",
      source: "TikTok",
      mentions: 0,
      growthPercent: 0,
      score: 0,
      status: "Watching",
      notes: "",
    });

    setShowForm(false);
    loadTrends();
  }

  async function deleteTrend(id: string) {
    await deleteDoc(doc(db, "trendScout", id));
    loadTrends();
  }

  async function updateTrendStatus(id: string, status: string) {
    await updateDoc(doc(db, "trendScout", id), {
      status,
    });

    loadTrends();
  }

  function statusStyle(status: string): React.CSSProperties {
    if (status === "Watching") {
      return { backgroundColor: "#2563eb", color: "white" };
    }

    if (status === "Sourcing") {
      return { backgroundColor: "#ca8a04", color: "white" };
    }

    if (status === "Ordered") {
      return { backgroundColor: "#16a34a", color: "white" };
    }

    return { backgroundColor: "#dc2626", color: "white" };
  }

  const filteredTrends = trends.filter(
    (trend) =>
      (statusFilter === "All" || trend.status === statusFilter) &&
      (categoryFilter === "All" || trend.category === categoryFilter)
  );

  const cardStyle: React.CSSProperties = {
    border: "1px solid #ccc",
    borderRadius: "6px",
    padding: "10px",
    minWidth: "120px",
    backgroundColor: "#fff",
    cursor: "pointer",
  };


  const groupedCandidates = Object.values(
    trendCandidates.reduce((acc: any, candidate: any) => {
      const key = candidate.trendCategory || candidate.productName;
      if (!acc[key]) {
        acc[key] = {
          trendCategory: key,
          category: candidate.category,
          sources: new Set(candidate.sources || []),
          products: [candidate.productName],
          mentions: candidate.mentions || 0,
          score: candidate.score || 0,
        };
      } else {
        acc[key].products.push(candidate.productName);
        (candidate.sources || []).forEach((s: string) => acc[key].sources.add(s));
        acc[key].mentions += candidate.mentions || 0;
        acc[key].score = Math.max(acc[key].score, candidate.score || 0);
      }
      return acc;
     }, {})
).sort((a: any, b: any) => {
  const strengthA = (a.sources.size * 5) + a.products.length;
  const strengthB = (b.sources.size * 5) + b.products.length;

  return strengthB - strengthA;
});

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Trend Scout</h1>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded bg-black px-4 py-2 text-white"
          >
            + Add Trend
          </button>

<select
  value={searchCategory}
  onChange={(e) => setSearchCategory(e.target.value)}
  className="rounded border px-3 py-2 text-sm"
>
  <option value="All">All Categories</option>
  <option value="Toys">Toys</option>
  <option value="Cellular">Cellular</option>
  <option value="Sunglasses">Sunglasses</option>
  <option value="Novelty Food">Novelty Food</option>
  <option value="Seasonal">Seasonal</option>
  <option value="General Merchandise">General Merchandise</option>
</select>

          <button
  onClick={() => {
    setFindingTrends(true);
    setImportedCandidates([]);

    fetch(`/api/find-trends?category=${encodeURIComponent(searchCategory)}`)
  .then((res) => res.json())
  .then((data) => {
    setTrendCandidates(data.candidates || []);
    setFindingTrends(false);
  });

     }}
  className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
>
  {findingTrends ? "Finding..." : "Find Trends"}
</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
        <div onClick={() => setStatusFilter("Watching")} style={cardStyle}>
          <div className="text-sm text-gray-600">Watching</div>
          <div className="text-2xl font-bold">{watchingCount}</div>
        </div>

        <div onClick={() => setStatusFilter("Sourcing")} style={cardStyle}>
          <div className="text-sm text-gray-600">Sourcing</div>
          <div className="text-2xl font-bold">{sourcingCount}</div>
        </div>

        <div onClick={() => setStatusFilter("Ordered")} style={cardStyle}>
          <div className="text-sm text-gray-600">Ordered</div>
          <div className="text-2xl font-bold">{orderedCount}</div>
        </div>

        <div onClick={() => setStatusFilter("Rejected")} style={cardStyle}>
          <div className="text-sm text-gray-600">Rejected</div>
          <div className="text-2xl font-bold">{rejectedCount}</div>
        </div>
      </div>

      <div className="mb-4">
        <select
          className="border p-2"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="All">All Statuses</option>
          <option value="Watching">Watching</option>
          <option value="Sourcing">Sourcing</option>
          <option value="Ordered">Ordered</option>
          <option value="Rejected">Rejected</option>
        </select>

        <select
          className="ml-2 border p-2"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="All">All Categories</option>
          <option value="Toys">Toys</option>
          <option value="Cellular">Cellular</option>
          <option value="Sunglasses">Sunglasses</option>
          <option value="Novelty Food">Novelty Food</option>
          <option value="Seasonal">Seasonal</option>
          <option value="America 250">America 250</option>
          <option value="General Merchandise">General Merchandise</option>
        </select>
      </div>

      {showForm && (
        <div className="mb-6 rounded border bg-white p-4">
          <input
            placeholder="Product Name"
            className="border p-2"
            value={newTrend.productName}
            onChange={(e) =>
              setNewTrend({
                ...newTrend,
                productName: e.target.value,
              })
            }
          />

          <select
            className="ml-2 border p-2"
            value={newTrend.category}
            onChange={(e) =>
              setNewTrend({
                ...newTrend,
                category: e.target.value,
              })
            }
          >
            <option value="">Select Category</option>
            <option value="Toys">Toys</option>
            <option value="Cellular">Cellular</option>
            <option value="Sunglasses">Sunglasses</option>
            <option value="Novelty Food">Novelty Food</option>
            <option value="Seasonal">Seasonal</option>
            <option value="America 250">America 250</option>
            <option value="General Merchandise">General Merchandise</option>
          </select>

          <select
            className="ml-2 border p-2"
            value={newTrend.source}
            onChange={(e) =>
              setNewTrend({
                ...newTrend,
                source: e.target.value,
              })
            }
          >
            <option value="TikTok">TikTok</option>
            <option value="Amazon">Amazon</option>
            <option value="Google Trends">Google Trends</option>
            <option value="Instagram">Instagram</option>
            <option value="Reddit">Reddit</option>
            <option value="Trade Show">Trade Show</option>
            <option value="Sales Rep">Sales Rep</option>
            <option value="Customer Request">Customer Request</option>
          </select>

          <select
            className="ml-2 border p-2"
            value={newTrend.status}
            onChange={(e) =>
              setNewTrend({
                ...newTrend,
                status: e.target.value,
              })
            }
          >
            <option value="Watching">Watching</option>
            <option value="Sourcing">Sourcing</option>
            <option value="Ordered">Ordered</option>
            <option value="Rejected">Rejected</option>
          </select>

          <input
            placeholder="Notes"
            className="ml-2 border p-2"
            value={newTrend.notes}
            onChange={(e) =>
              setNewTrend({
                ...newTrend,
                notes: e.target.value,
              })
            }
          />

          <button
            type="button"
            onClick={saveTrend}
            className="ml-2 rounded border border-black bg-black px-4 py-2 text-white"
          >
            Save
          </button>

          <button
            type="button"
            onClick={() => setShowForm(false)}
            className="ml-2 rounded border border-black px-4 py-2"
          >
            Cancel
          </button>
        </div>
      )}

{trendCandidates.length > 0 && (
  <div className="mb-6 rounded-xl border bg-white p-4 shadow-sm">
    <h2 className="mb-3 text-lg font-semibold">Trend Categories</h2>

    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="p-2">Trend</th>
            <th className="p-2">Category</th>
            <th className="p-2">Source(s)</th>
	    <th className="p-2">Confidence</th>
            <th className="p-2">Mentions</th>
            <th className="p-2">Matches</th>
            <th className="p-2">Strength</th>
	    <th className="p-2">Score</th>
            <th className="p-2">View</th>
          </tr>
        </thead>
        <tbody>

	  

          {groupedCandidates.map((group: any, index) => (
  <React.Fragment key={index}>
    <tr className="border-b">
              <td className="p-2 font-medium">{group.trendCategory}</td>
              <td className="p-2">{group.category}</td>
              <td className="p-2">{Array.from(group.sources).join(", ")}</td>
	      <td className="p-2">
  		{Array.from(group.sources).length >= 3 ? (
  <span className="rounded bg-green-100 px-2 py-1 text-xs font-semibold text-green-700">
  🟢 High
</span>
) : Array.from(group.sources).length === 2 ? (
  <span className="rounded bg-yellow-100 px-2 py-1 text-xs font-semibold text-yellow-700">
  🟡 Medium
</span>
) : (
  <span className="rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-700">
  🔴 Low
</span>
)}
	      </td>
              <td className="p-2">{group.mentions}</td>
              <td className="p-2">{group.products.length} {group.products.length === 1 ? "Match" : "Matches"}</td>
	      <td className="p-2">
  {(Array.from(group.sources).length * 5) + group.products.length}
</td>
              <td className="p-2">{group.score}</td>
              <td className="p-2">
                <button
                  className="rounded bg-black px-3 py-1 text-xs font-semibold text-white"
                  onClick={() =>
  setExpandedTrend(
    expandedTrend === group.trendCategory ? null : group.trendCategory
  )
}
                >
                  View Products
                </button>
              </td>
            </tr>

{expandedTrend === group.trendCategory && (
  <tr>
    <td colSpan={7} className="bg-gray-100 p-3">
      <div className="font-semibold mb-2">Products:</div>

      <ul className="list-disc pl-5">
        {group.products.map(
          (product: string, productIndex: number) => (
            <li key={productIndex}>
  {product}
  <span className="ml-2 text-xs text-gray-500">
    (
    {trendCandidates
      .filter((c: any) => c.productName === product)
      .flatMap((c: any) => c.sources || [])
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i)
      .join(", ")}
    )
  </span>
</li>
          )
        )}
      </ul>
    </td>
  </tr>
)}

  </React.Fragment>
))}
        </tbody>
      </table>
    </div>
  </div>
)}

      {loading ? (
        <div>Loading...</div>
      ) : (
        <table className="w-full border">
          <thead>
            <tr className="bg-black text-white">
              <th className="p-2 text-left">Product</th>
              <th className="p-2 text-left">Category</th>
              <th className="p-2 text-left">Source</th>
              <th className="p-2 text-left">Mentions</th>
              <th className="p-2 text-left">Growth %</th>
              <th className="p-2 text-left">Score</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Notes</th>
              <th className="p-2 text-left">Delete</th>
            </tr>
          </thead>

          <tbody>
            {filteredTrends.map((trend) => (
              <tr key={trend.id} className="border-b">
                <td className="p-2">{trend.productName}</td>
                <td className="p-2">{trend.category}</td>
                <td className="p-2">{trend.source}</td>
                <td className="p-2">{trend.mentions}</td>
                <td className="p-2">{trend.growthPercent}%</td>
                <td className="p-2">{trend.score}</td>
                <td className="p-2">
                  <select
                    value={trend.status}
                    onChange={(e) =>
                      updateTrendStatus(trend.id, e.target.value)
                    }
                    style={statusStyle(trend.status)}
                    className="rounded px-2 py-1"
                  >
                    <option value="Watching">Watching</option>
                    <option value="Sourcing">Sourcing</option>
                    <option value="Ordered">Ordered</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </td>
                <td className="p-2">{trend.notes}</td>
                <td className="p-2">
                  <button
                    type="button"
                    onClick={() => deleteTrend(trend.id)}
                    className="rounded border border-black px-3 py-1"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}