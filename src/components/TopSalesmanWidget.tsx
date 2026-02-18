"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "@/lib/firebase";
import TopSalesmanChart from "@/components/TopSalesmanChart";

type SalesData = {
  name: string;
  total: number;
};

export default function TopSalesmanWidget() {
  const [data, setData] = useState<SalesData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      // If not signed in yet, don't query Firestore (prevents permissions error)
      if (!user) {
        setLoading(false);
        setData([]);
        return;
      }

      setLoading(true);
      try {
        const q = query(
          collection(db, "topSalesmen"),
          orderBy("total", "desc"),
          limit(10)
        );

        const snap = await getDocs(q);
        const rows: SalesData[] = snap.docs.map((d) => {
          const v = d.data() as any;
          return {
            name: String(v.name ?? ""),
            total: Number(v.total ?? 0),
          };
        });

        setData(rows);
      } catch (e) {
        console.error("TopSalesmanWidget fetch error:", e);
        setData([]);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, []);

  if (loading) return <div style={{ padding: 12 }}>Loading top salesmen…</div>;

  // Optional: if not signed in, show nothing (or a friendly message)
  if (!data.length) return null;

  return <TopSalesmanChart data={data} />;
}
