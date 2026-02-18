"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  limit,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useRouter } from "next/navigation";

// -----------------------------
// CONFIG (grounded from your Firestore + existing widget)
// -----------------------------
const FIRESTORE = {
  customersCollection: "customers",
  usersCollection: "users",

  // /users/{uid}.salesperson = "0010"
  userRepField: "salesperson",

  // customers docs use salespersonNo for rep assignment
  repField: "salespersonNo",

  // customers docs have lastActivityTs as Timestamp
  lastActivityTsField: "lastActivityTs",

  // 2025 revenue field used in TopInactiveStoresWidget
  revenue2025Field: "udf250Totalsales",
};

// Thresholds
const INACTIVE_DAYS = 60;
const TOP_AT_RISK_NO_ORDER_DAYS = 45;
const TOP_N = 50;

// For Top 50 calc we need docs in memory (same pattern as TopInactiveStoresWidget)
const TOP50_FETCH_LIMIT = 5000;

function daysAgoToTimestamp(days: number) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return Timestamp.fromDate(new Date(ms));
}

function normalizeRep(v: any) {
  const s = (v ?? "").toString().trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits && digits.length <= 4) return digits.padStart(4, "0");
  return s;
}

function toNumber(v: any) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/[$,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export default function TodaysOpportunitiesCard() {
  const router = useRouter();

  const [inactive60, setInactive60] = useState<number | null>(null);
  const [topAtRisk, setTopAtRisk] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inactiveCutoff = useMemo(() => daysAgoToTimestamp(INACTIVE_DAYS), []);
  const topAtRiskCutoff = useMemo(
    () => daysAgoToTimestamp(TOP_AT_RISK_NO_ORDER_DAYS),
    []
  );

  useEffect(() => {
    let cancelled = false;

    async function runForUid(uid: string) {
      setError(null);

      try {
        const userSnap = await getDoc(doc(db, FIRESTORE.usersCollection, uid));
        if (!userSnap.exists()) {
          if (!cancelled) setError("No user profile found in /users.");
          return;
        }

        const repNo = normalizeRep((userSnap.data() as any)?.[FIRESTORE.userRepField]);
        if (!repNo) {
          if (!cancelled) setError(`Missing users.${FIRESTORE.userRepField}.`);
          return;
        }

        const customersRef = collection(db, FIRESTORE.customersCollection);

        // Inactive 60+ days
        const inactiveQ = query(
          customersRef,
          where(FIRESTORE.repField, "==", repNo),
          where(FIRESTORE.lastActivityTsField, "<=", inactiveCutoff)
        );
        const inactiveSnap = await getCountFromServer(inactiveQ);
        if (!cancelled) setInactive60(inactiveSnap.data().count);

        // Top 50 at risk (45+ days) — compute locally from up to 5000 docs
        const { getDocs } = await import("firebase/firestore");
        const fetchQ = query(
          customersRef,
          where(FIRESTORE.repField, "==", repNo),
          limit(TOP50_FETCH_LIMIT)
        );
        const snap = await getDocs(fetchQ);

        const customers = snap.docs.map((d) => {
          const x = d.data() as any;
          return {
            rev2025: toNumber(x?.[FIRESTORE.revenue2025Field]),
            lastActivityTs: x?.[FIRESTORE.lastActivityTsField] as Timestamp | undefined,
          };
        });

        const top50 = customers
          .sort((a, b) => b.rev2025 - a.rev2025)
          .slice(0, TOP_N);

        const cutoffMs = topAtRiskCutoff.toMillis();
        const riskCount = top50.filter((c) => {
          const ts = c.lastActivityTs;
          return ts && ts.toMillis() <= cutoffMs;
        }).length;

        if (!cancelled) setTopAtRisk(riskCount);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "Failed to load opportunities");
          setInactive60(null);
          setTopAtRisk(null);
        }
      }
    }

    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) return;
      runForUid(u.uid);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [inactiveCutoff, topAtRiskCutoff]);

  const boxClass = "rounded-lg border bg-white px-4 py-3 shadow-sm";
  const labelClass = "text-xs text-gray-500";
  const valueClass = "mt-1 text-2xl font-semibold text-gray-900";

  return (
    <div className={boxClass}>
      {error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            className="text-left"
            title="View accounts inactive 60+ days (next step)"
            onClick={() => router.push("/customers?view=inactive60")}
          >
            <div className={labelClass}>Inactive {INACTIVE_DAYS}+ days</div>
            <div className={valueClass}>{inactive60 === null ? "—" : inactive60}</div>
          </button>

          <button
            type="button"
            className="text-left cursor-pointer group"
            onClick={() => router.push("/customers?view=atRisk45")}
            title="Click to view these accounts"
          >
            <div className={labelClass}>
              Top {TOP_N} at risk ({TOP_AT_RISK_NO_ORDER_DAYS}+ days)
            </div>
            <div className={`${valueClass} group-hover:text-blue-700 group-hover:underline`}>
              {topAtRisk === null ? "—" : topAtRisk}
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
