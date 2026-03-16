"use client";

import dynamic from "next/dynamic";

const ProspectMapClient = dynamic(() => import("./ProspectMapClient"), {
  ssr: false,
  loading: () => <div className="p-4">Loading map…</div>,
});

export default function ProspectMapPage() {
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-4">Prospect Map</h1>

      <div className="bg-white border border-black rounded-lg shadow overflow-hidden">
        <div className="p-4 border-b border-black">
          <div className="text-lg font-bold">Prospects</div>
          <div className="text-sm text-gray-600">Map view</div>
        </div>

        {/* ✅ HARD HEIGHT HERE so it can’t collapse */}
        <div style={{ height: "72vh", width: "100%" }}>
          <ProspectMapClient />
        </div>
      </div>
    </div>
  );
}