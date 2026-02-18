"use client";

import React, { useEffect, useState } from "react";
import { getApps } from "firebase/app";
import { getAuth, onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc, getFirestore, onSnapshot, Timestamp } from "firebase/firestore";

type StatDoc = {
  salespersonNo: string;
  openOrders: number;
  openLines: number;
  updatedAt?: Timestamp | null;
};

function padSalesperson(v: string) {
  const s = (v ?? "").trim();
  if (!s) return "";
  return s.length >= 4 ? s : s.padStart(4, "0");
}

export default function OpenSalesOrdersBySalesman() {
  const [user, setUser] = useState<User | null>(null);
  const [stat, setStat] = useState<StatDoc | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    const app = getApps()[0];
    if (!app) {
      setErr("Firebase app not initialized.");
      return;
    }

    const auth = getAuth(app);
    const db = getFirestore(app);

    let unsubStat: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setErr("");
      setStat(null);

      unsubStat?.();
      unsubStat = null;

      if (!u) return;

      // Read logged-in user's profile to determine salesmanId
      const userSnap = await getDoc(doc(db, "users", u.uid));
      if (!userSnap.exists()) {
        setErr("No user profile found in /users/{uid}.");
        return;
      }

      const data = userSnap.data() as any;
      const repRaw =
        data.salesmanId ??
        data.salespersonNo ??
        data.salesperson ??
        data.repId ??
        data.rep ??
        data.salesmanNo ??
        "";

      const rep = padSalesperson(String(repRaw ?? ""));
      if (!rep) {
        setErr("User profile is missing salesperson id (salesmanId/salespersonNo/repId).");
        return;
      }

      // Listen to ONLY this salesperson's stats doc
      const statRef = doc(db, "openSalesOrderStats", rep);
      unsubStat = onSnapshot(
        statRef,
        (snap) => {
          if (!snap.exists()) {
            setStat({
              salespersonNo: rep,
              openOrders: 0,
              openLines: 0,
              updatedAt: null,
            });
            return;
          }
          const v = snap.data() as any;
          setStat({
            salespersonNo: String(v.salespersonNo ?? rep),
            openOrders: Number(v.openOrders ?? 0),
            openLines: Number(v.openLines ?? 0),
            updatedAt: v.updatedAt ?? null,
          });
        },
        (e) => setErr(e?.message || String(e))
      );
    });

    return () => {
      unsubAuth();
      unsubStat?.();
    };
  }, []);

  return (
    <div className="rounded-lg bg-white shadow p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-lg font-bold">Open Sales Orders</h3>
      </div>

      {err ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {err}
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded bg-gray-50 p-3">
          <div className="text-gray-600">Orders</div>
          <div className="text-xl font-bold">{stat?.openOrders ?? "—"}</div>
        </div>
        <div className="rounded bg-gray-50 p-3">
          <div className="text-gray-600">Lines</div>
          <div className="text-xl font-bold">{stat?.openLines ?? "—"}</div>
        </div>
      </div>

      {!err && user && !stat ? (
        <div className="mt-3 text-sm text-gray-600">Loading…</div>
      ) : null}
    </div>
  );
}
