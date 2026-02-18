"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase"; // adjust if needed

type Cust = {
  id: string;
  customerName?: string;
  customerNo?: string;
  city?: string;
  state?: string;
  phone?: string;
  udf250Totalsales?: string | number;
  lastActivityTs?: Timestamp;
  dateLastActivity?: string;
};

function toNumber(v: any) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/[$,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatPhone(raw?: string) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return s;
}

function normalizeRep(v: any) {
  const s = (v ?? "").toString().trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits && digits.length <= 4) return digits.padStart(4, "0");
  return s;
}

export default function TopInactiveStoresWidget() {
  const [rows, setRows] = useState<Cust[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        setLoading(true);
        setErr(null);
        setRows([]);

        if (!user) return;

        const usnap = await getDoc(doc(db, "users", user.uid));
        const u = usnap.exists() ? (usnap.data() as any) : null;

        // ✅ YOUR FIELD NAME (from your screenshot)
        const repNo = normalizeRep(u?.salesperson); // "0010"

        if (!repNo) {
          setErr("Missing users.salesperson.");
          return;
        }

        // Query this rep's customers only (no inactivity filter in Firestore)
        const qy = query(
          collection(db, "customers"),
          where("salespersonNo", "==", repNo), // customers field name from your customer doc screenshot
          limit(5000)
        );

        const snap = await getDocs(qy);

        const data: Cust[] = snap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: d.id,
            customerName: x.customerName,
            customerNo: x.customerNo ?? d.id,
            city: x.city,
            state: x.state,
            phone: x.phone,
            udf250Totalsales: x.udf250Totalsales,
            lastActivityTs: x.lastActivityTs,
            dateLastActivity: x.dateLastActivity,
          };
        });

        setRows(data);
      } catch (e: any) {
        console.error("TopInactiveStoresWidget error:", e);
        setErr(e?.message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const top10 = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffMs = cutoff.getTime();

    const inactive = rows.filter((c) => {
      if (!c.lastActivityTs) return false;
      return c.lastActivityTs.toDate().getTime() <= cutoffMs;
    });

    return inactive
      .sort((a, b) => toNumber(b.udf250Totalsales) - toNumber(a.udf250Totalsales))
      .slice(0, 10);
  }, [rows]);

  return (
    <div className="bg-white rounded-lg shadow p-3 border">
      {/* NO second header inside this card */}
      <div className="grid grid-cols-12 gap-2 text-[11px] text-gray-500 border-b pb-1">
        <div className="col-span-6">Customer</div>
        <div className="col-span-3">City</div>
        <div className="col-span-2">Phone</div>
        <div className="col-span-1 text-right">2025</div>
      </div>

      {loading ? (
        <div className="py-3 text-sm text-gray-500">Loading…</div>
      ) : err ? (
        <div className="py-3 text-sm text-red-600">{err}</div>
      ) : top10.length === 0 ? (
        <div className="py-3 text-sm text-gray-500">No inactive stores.</div>
      ) : (
        <div className="divide-y">
          {top10.map((c) => {
            const cityState = [c.city, c.state].filter(Boolean).join(", ");
            return (
              <div key={c.id} className="grid grid-cols-12 gap-2 py-2 text-xs">
                <div className="col-span-6 leading-tight">
                  <div className="font-medium">{c.customerName || "(No name)"}</div>
                  <div className="text-[11px] text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis">
                    {c.customerNo ?? ""}
                    {c.dateLastActivity ? ` · Last: ${c.dateLastActivity}` : ""}
                  </div>
                </div>

                <div className="col-span-3 whitespace-nowrap overflow-hidden text-ellipsis">
                  {cityState}
                </div>

                <div className="col-span-2 text-[12px] font-medium whitespace-nowrap">
                  {formatPhone(c.phone)}
                </div>

                <div className="col-span-1 text-right whitespace-nowrap">
                  {money(toNumber(c.udf250Totalsales))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
