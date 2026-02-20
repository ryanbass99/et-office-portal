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

// "0041" == "41"
function normalizeSalesCode(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (!digits) return s.toLowerCase();
  return (digits.replace(/^0+/, "") || "0").trim();
}

export default function FollowUpsWidget() {
  const router = useRouter();

  const [role, setRole] = useState<string>("user");
  const [uid, setUid] = useState<string | null>(null);
  const [userSalesperson, setUserSalesperson] = useState<string>("");

  const [customerRows, setCustomerRows] = useState<CustomerFU[]>([]);
  const [leadRows, setLeadRows] = useState<LeadFU[]>([]);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    const today = startOfDay(new Date());
    const end = new Date(today);
    end.setDate(end.getDate() + 7);

    return {
      end: Timestamp.fromDate(
        new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59)
      ),
    };
  }, []);

  // Auth + role + salesperson (your schema: users/{uid}.salesperson)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUid(null);
        setRole("user");
        setUserSalesperson("");
        setCustomerRows([]);
        setLeadRows([]);
        setLoading(false);
        return;
      }

      setUid(u.uid);

      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        const data = snap.data() as any;

        setRole((data?.role as string) || "user");
        setUserSalesperson(String(data?.salesperson ?? "").trim());
      } catch {
        setRole("user");
        setUserSalesperson("");
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
        const isAdmin = role === "admin";
        const userCodeNorm = normalizeSalesCode(userSalesperson);

        // DEBUG (remove later): proves which file is running + which salesperson it sees
        console.log("[FollowUpsWidget live]", { role, uid, userSalesperson, userCodeNorm });

        const notesQ = query(
          collectionGroup(db, "notes"),
          where("followUpDate", "<=", range.end),
          orderBy("followUpDate", "asc"),
          limit(300)
        );

        const notesSnap = await getDocs(notesQ);

        const customerCache = new Map<
          string,
          { allowed: boolean; name: string; custSalespersonNo: string }
        >();

        const customerFU: CustomerFU[] = [];

        for (const nd of notesSnap.docs) {
          const data = nd.data() as any;
          const followUpDate = data.followUpDate as Timestamp | undefined;
          if (!followUpDate?.toDate) continue;

          const customerNo = nd.ref.parent.parent?.id; // customers/{customerNo}/notes/{id}
          if (!customerNo) continue;

          if (!customerCache.has(customerNo)) {
            let allowed = false;
            let name = "";
            let custSalespersonNo = "";

            try {
              const cs = await getDoc(doc(db, "customers", customerNo));
              if (cs.exists()) {
                const cd = cs.data() as any;

                name = String(cd.customerName ?? "").trim();
                custSalespersonNo = String(cd.salespersonNo ?? "").trim();

                if (isAdmin) {
                  allowed = true;
                } else {
                  const custNorm = normalizeSalesCode(custSalespersonNo);
                  allowed = !!userCodeNorm && !!custNorm && custNorm === userCodeNorm;
                }
              }
            } catch {}

            customerCache.set(customerNo, { allowed, name, custSalespersonNo });
          }

          const cached = customerCache.get(customerNo)!;
          if (!cached.allowed) continue;

          customerFU.push({
            customerNo,
            customerName: cached.name || "",
            noteText: String(data.text ?? ""),
            followUpDate,
          });

          if (customerFU.length >= 50) break;
        }

        // Sales Leads follow ups (your schema uses salesmanId = uid)
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
            const lead = d.data() as any;
            const status = String(lead.status ?? "open");
            if (status !== "open") return null;

            return {
              leadId: d.id,
              customerLabel: `${lead.customerName ?? ""} — ${lead.city ?? ""}, ${
                lead.state ?? ""
              }`.trim(),
              noteText: String(lead.comments ?? ""),
              followUpDate: lead.followUpDate as Timestamp,
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
  }, [uid, role, userSalesperson, range.end]);

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
                        `/salesLeads?leadId=${encodeURIComponent(
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