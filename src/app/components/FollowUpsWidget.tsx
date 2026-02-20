"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { db, auth } from "@/lib/firebase";

type CustomerFU = {
  customerNo: string;
  customerName?: string;
  noteText: string;
  followUpDate: Timestamp;
};

type LeadFU = {
  leadId: string;
  customerLabel: string;
  noteText: string;
  followUpDate: Timestamp;
};

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function daysUntil(ts?: Timestamp) {
  if (!ts?.toDate) return null;
  const today = startOfDay(new Date()).getTime();
  const target = startOfDay(ts.toDate()).getTime();
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function rowHighlight(ts?: Timestamp) {
  const d = daysUntil(ts);
  if (d === null) return "";
  if (d < 0) return "bg-red-100";
  if (d <= 3) return "bg-yellow-100";
  return "";
}

export default function FollowUpsWidget() {
  const router = useRouter();

  const [role, setRole] = useState<string>("user");
  const [uid, setUid] = useState<string | null>(null);

  const [customerRows, setCustomerRows] = useState<CustomerFU[]>([]);
  const [leadRows, setLeadRows] = useState<LeadFU[]>([]);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    const today = startOfDay(new Date());
    const end = new Date(today);
    end.setDate(end.getDate() + 7);

    return {
      start: Timestamp.fromDate(today), // kept (used for display math), but NOT used in queries
      end: Timestamp.fromDate(
        new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59)
      ),
    };
  }, []);

  // Auth + role
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUid(null);
        setRole("user");
        setCustomerRows([]);
        setLeadRows([]);
        setLoading(false);
        return;
      }

      setUid(u.uid);

      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        setRole((snap.data()?.role as string) || "user");
      } catch {
        setRole("user");
      }
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!uid) return;

      setLoading(true);
      try {
        // ✅ Include overdue + next 7 days:
        // query followUpDate <= end (this includes overdue automatically)
        const notesQ = query(
          collectionGroup(db, "notes"),
          where("followUpDate", "<=", range.end),
          orderBy("followUpDate", "asc"),
          limit(50)
        );

        const notesSnap = await getDocs(notesQ);

        const customerNos = new Set<string>();
        const rawNotes: Array<{
          customerNo: string;
          noteText: string;
          followUpDate: Timestamp;
        }> = [];

        for (const d of notesSnap.docs) {
          const data = d.data() as any;
          const followUpDate = data.followUpDate as Timestamp | undefined;
          if (!followUpDate?.toDate) continue;

          const customerNo = d.ref.parent.parent?.id; // customers/{customerNo}/notes/{id}
          if (!customerNo) continue;

          rawNotes.push({
            customerNo,
            noteText: (data.text ?? "").toString(),
            followUpDate,
          });
          customerNos.add(customerNo);
        }

        // customer name lookup
        const nameMap: Record<string, string> = {};
        await Promise.all(
          Array.from(customerNos).slice(0, 50).map(async (cno) => {
            try {
              const cs = await getDoc(doc(db, "customers", cno));
              if (cs.exists()) {
                const cd = cs.data() as any;
                nameMap[cno] =
                  cd.customerName || cd.name || cd.customer_name || "";
              }
            } catch {}
          })
        );

        const customerFU: CustomerFU[] = rawNotes.map((n) => ({
          customerNo: n.customerNo,
          customerName: nameMap[n.customerNo] || "",
          noteText: n.noteText,
          followUpDate: n.followUpDate,
        }));

        // --- Sales Leads follow ups ---
        // Backwards compatible:
        // - include docs with status missing (treat as open)
        // - include docs with status == "open"
        const leadsBase = collection(db, "salesLeads");

        const leadsQ =
          role === "admin"
            ? query(
                leadsBase,
                where("followUpDate", "<=", range.end),
                orderBy("followUpDate", "asc"),
                limit(100)
              )
            : query(
                leadsBase,
                where("salesmanId", "==", uid),
                where("followUpDate", "<=", range.end),
                orderBy("followUpDate", "asc"),
                limit(100)
              );

        const leadsSnap = await getDocs(leadsQ);

        const leadFU: LeadFU[] = leadsSnap.docs
          .map((d) => {
            const data = d.data() as any;
            const status = (data.status ?? "open").toString();
            if (status !== "open") return null;

            return {
              leadId: d.id,
              customerLabel: `${data.customerName ?? ""} — ${data.city ?? ""}, ${
                data.state ?? ""
              }`.trim(),
              noteText: (data.comments ?? "").toString(),
              followUpDate: data.followUpDate as Timestamp,
            } as LeadFU;
          })
          .filter(Boolean) as LeadFU[];

        if (!cancelled) {
          setCustomerRows(customerFU);
          setLeadRows(leadFU);
        }
      } catch (e) {
        console.error("Follow-ups load error:", e);
        if (!cancelled) {
          setCustomerRows([]);
          setLeadRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [uid, role, range.end]);

  return (
    <div className="bg-white p-4 rounded shadow">
      <div className="font-semibold mb-3">Needs Follow Up</div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Customer follow-ups */}
          <div>
            <div className="text-sm font-semibold mb-2">Customer Follow Ups</div>
            {customerRows.length === 0 ? (
              <div className="text-sm text-gray-500">No customer follow ups.</div>
            ) : (
              <div className="space-y-2">
                {customerRows.map((r, idx) => (
                  <div
                    key={`c_${r.customerNo}_${idx}`}
                    onClick={() =>
                      router.push(
                        `/customers?customerNo=${encodeURIComponent(
                          r.customerNo
                        )}&open=notes`
                      )
                    }
                    className={`p-2 rounded cursor-pointer hover:bg-gray-50 ${rowHighlight(
                      r.followUpDate
                    )}`}
                    title="Click to open notes"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">
                        {r.customerNo} — {r.customerName || ""}
                      </div>
                      <div className="text-xs text-gray-600 whitespace-nowrap">
                        {r.followUpDate?.toDate
                          ? r.followUpDate.toDate().toLocaleDateString()
                          : ""}
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 truncate">
                      {r.noteText}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Lead follow-ups */}
          <div>
            <div className="text-sm font-semibold mb-2">Sales Leads</div>
            {leadRows.length === 0 ? (
              <div className="text-sm text-gray-500">No sales lead follow ups.</div>
            ) : (
              <div className="space-y-2">
                {leadRows.map((r) => (
                  <div
                    key={`l_${r.leadId}`}
                    onClick={() =>
                      router.push(
                        `/sales-leads?leadId=${encodeURIComponent(
                          r.leadId
                        )}&open=details`
                      )
                    }
                    className={`p-2 rounded cursor-pointer hover:bg-gray-50 ${rowHighlight(
                      r.followUpDate
                    )}`}
                    title="Click to open lead"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">
                        {r.customerLabel}
                      </div>
                      <div className="text-xs text-gray-600 whitespace-nowrap">
                        {r.followUpDate?.toDate
                          ? r.followUpDate.toDate().toLocaleDateString()
                          : ""}
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 truncate">
                      {r.noteText}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
