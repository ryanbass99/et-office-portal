import OpenSalesOrdersBySalesman from "./components/OpenSalesOrdersBySalesman";
import TopSalesmanWidget from "@/components/TopSalesmanWidget";
import TodaysOpportunitiesCard from "./components/TodaysOpportunitiesCard";
import FollowUpsWidget from "./components/FollowUpsWidget";
import RecentSalesSheetsWidget from "./components/RecentSalesSheetsWidget";

export default function Home() {
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top Left */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          <OpenSalesOrdersBySalesman />
        </div>

        {/* Top Right */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          <h2 className="text-lg font-semibold mb-3">Today’s Opportunities</h2>
          <TodaysOpportunitiesCard />
        </div>

        {/* Middle Left */}
        <div className="bg-white rounded-lg shadow p-4 border border-black flex flex-col">
          <h2 className="text-lg font-semibold mb-3">Top Salesmen</h2>
          <div className="flex-1 min-h-[360px]">
            <TopSalesmanWidget />
          </div>
        </div>

        {/* Middle Right */}
        <div className="bg-white rounded-lg shadow p-4 border border-black">
          <h2 className="text-lg font-semibold mb-3">
            Needs Follow Up (Overdue + Next 7 Days)
          </h2>
          <FollowUpsWidget />
        </div>

        {/* Bottom Full Width */}
        <div className="md:col-span-2">
          <RecentSalesSheetsWidget />
        </div>
      </div>
    </div>
  );
}