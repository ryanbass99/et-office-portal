import OpenSalesOrdersBySalesman from "./components/OpenSalesOrdersBySalesman";
import TopSalesmanWidget from "@/components/TopSalesmanWidget";
import TopInactiveStoresWidget from "@/components/TopInactiveStoresWidget";
import TodaysOpportunitiesCard from "./components/TodaysOpportunitiesCard"; // ✅ fix path

export default function Home() {
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top Left */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          {/* NOTE: OpenSalesOrdersBySalesman already renders its own title */}
          <OpenSalesOrdersBySalesman />
        </div>

        {/* Top Right */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          <h2 className="text-lg font-semibold mb-3">Today’s Opportunities</h2>
          <TodaysOpportunitiesCard />
        </div>

        {/* Bottom Left */}
        <div className="bg-white rounded-lg shadow p-4 border border-black flex flex-col">
          <h2 className="text-lg font-semibold mb-3">Top Salesmen</h2>
          {/* Give the chart room so it fills the card area */}
          <div className="flex-1 min-h-[360px]">
            <TopSalesmanWidget />
          </div>
        </div>

        {/* Bottom Right */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          <h2 className="text-lg font-semibold mb-3">
            Top 50 (2025) — Inactive 60+ Days
          </h2>
          <TopInactiveStoresWidget />
        </div>
      </div>
    </div>
  );
}
