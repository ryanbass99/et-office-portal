"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  doc,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "@/lib/firebase";

type LeadStatus = "open" | "closed_no_lead" | "closed_account";

type Lead = {
  id: string;
  customerName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  managerName: string;
  email: string;
  followUpDate: Timestamp;
  storeType: string;
  grocerySupplier: string;
  comments: string;

  status?: LeadStatus;
  closedAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  salesmanId?: string;
};

function dateInputToTimestamp(dateStr: string) {
  // dateStr expected: YYYY-MM-DD
  const parts = (dateStr || "").split("-").map((v) => Number(v));
  if (parts.length !== 3 || parts.some((n) => !n)) {
    throw new Error("Invalid Follow Up Date.");
  }
  const [y, m, d] = parts;
  // Use local noon to avoid off-by-one-day issues from timezone parsing.
  return Timestamp.fromDate(new Date(y, m - 1, d, 12, 0, 0));
}

function timestampToDateInput(ts?: Timestamp) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function daysUntil(ts?: Timestamp) {
  if (!ts?.toDate) return null;
  const today = startOfDay(new Date()).getTime();
  const target = startOfDay(ts.toDate()).getTime();
  const diffMs = target - today;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export default function SalesLeadsPage() {
  const [form, setForm] = useState({
    customerName: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    managerName: "",
    email: "",
    followUpDate: "",
    storeType: "",
    grocerySupplier: "",
    comments: "",
  });

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [saving, setSaving] = useState(false);

  const [role, setRole] = useState<string>("user");

  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  // ✅ Editable fields in details panel
  const [detailComments, setDetailComments] = useState("");
  const [detailStatus, setDetailStatus] = useState<LeadStatus>("open");
  const [detailFollowUpDate, setDetailFollowUpDate] = useState(""); // ✅ new
  const [savingDetails, setSavingDetails] = useState(false);

  useEffect(() => {
    if (!selectedLead) return;
    setDetailComments(selectedLead.comments ?? "");
    setDetailStatus((selectedLead.status as LeadStatus) || "open");
    setDetailFollowUpDate(timestampToDateInput(selectedLead.followUpDate)); // ✅ new
  }, [selectedLead?.id]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setForm((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const u = auth.currentUser;
    if (!u) {
      alert("Not authenticated.");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "salesLeads"), {
        ...form,
        followUpDate: dateInputToTimestamp(form.followUpDate),
        salesmanId: u.uid,
        status: "open",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      alert("Lead saved successfully.");

      setForm({
        customerName: "",
        address: "",
        city: "",
        state: "",
        zip: "",
        phone: "",
        managerName: "",
        email: "",
        followUpDate: "",
        storeType: "",
        grocerySupplier: "",
        comments: "",
      });
    } catch (error: any) {
      console.error("Firestore error:", error);
      alert(error?.message || "Error saving lead.");
    } finally {
      setSaving(false);
    }
  };

  const saveLeadDetails = async () => {
    if (!selectedLead) return;

    setSavingDetails(true);
    try {
      const ref = doc(db, "salesLeads", selectedLead.id);

      await updateDoc(ref, {
        comments: detailComments,
        status: detailStatus,
        followUpDate: dateInputToTimestamp(detailFollowUpDate), // ✅ update follow up date
        closedAt:
          detailStatus === "open"
            ? null
            : selectedLead.closedAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // If lead was closed, hide it immediately and close the detail panel
      if (detailStatus !== "open") {
        setSelectedLead(null);
        setLeads((prev) => prev.filter((x) => x.id !== selectedLead.id));
        return;
      }

      // Local UI update (snapshot will also refresh)
      setSelectedLead((prev) =>
        prev
          ? {
              ...prev,
              comments: detailComments,
              status: detailStatus,
              followUpDate: dateInputToTimestamp(detailFollowUpDate),
            }
          : prev
      );
    } catch (err: any) {
      console.error("Update lead error:", err);
      alert(err?.message || "Error updating lead.");
    } finally {
      setSavingDetails(false);
    }
  };

  useEffect(() => {
    let unsubSnap: null | (() => void) = null;

    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      if (unsubSnap) {
        unsubSnap();
        unsubSnap = null;
      }

      if (!u) {
        setRole("user");
        setLeads([]);
        setSelectedLead(null);
        setLoadingLeads(false);
        return;
      }

      setLoadingLeads(true);

      let nextRole = "user";
      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        nextRole = (snap.data()?.role as string) || "user";
      } catch {
        // ignore
      }
      setRole(nextRole);

      const leadsRef = collection(db, "salesLeads");

      // ✅ Hide closed leads by default
      // We treat missing status as "open" (backwards compatible)
      const q =
  nextRole === "admin"
    ? query(leadsRef, orderBy("followUpDate", "asc"), limit(500))
    : query(
        leadsRef,
        where("salesmanId", "==", u.uid),
        orderBy("followUpDate", "asc"),
        limit(200)
      );


      unsubSnap = onSnapshot(
        q,
        (snap) => {
          const rows: Lead[] = snap.docs.map((d) => {
            const data = d.data() as any;
            return {
              id: d.id,
              customerName: data.customerName ?? "",
              address: data.address ?? "",
              city: data.city ?? "",
              state: data.state ?? "",
              zip: data.zip ?? "",
              phone: data.phone ?? "",
              managerName: data.managerName ?? "",
              email: data.email ?? "",
              followUpDate: data.followUpDate,
              storeType: data.storeType ?? "",
              grocerySupplier: data.grocerySupplier ?? "",
              comments: data.comments ?? "",
              status: (data.status as LeadStatus) || "open",
              closedAt: data.closedAt,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              salesmanId: data.salesmanId,
            };
          });

          const openOnly = rows.filter(
  (r) => (r.status as any) === undefined || r.status === "open"
);
setLeads(openOnly);

// If selected lead becomes closed, close the panel
setSelectedLead((prev) => {
  if (!prev) return null;
  const updated = openOnly.find((r) => r.id === prev.id);
  return updated ?? null;
});


          setSelectedLead((prev) => {
            if (!prev) return null;
            const updated = rows.find((r) => r.id === prev.id);
            return updated ?? null;
          });

          setLoadingLeads(false);
        },
        (err) => {
          console.error("Leads snapshot error:", err);
          setLoadingLeads(false);
        }
      );
    });

    return () => {
      if (unsubSnap) unsubSnap();
      unsubAuth();
    };
  }, []);

  const isAdmin = useMemo(() => role === "admin", [role]);

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        <h1 className="text-2xl font-bold mb-6">Sales Leads</h1>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold mb-6">My Leads</h1>
          {isAdmin ? (
            <div className="text-sm text-gray-600">Viewing: All leads</div>
          ) : null}
        </div>

        {/* LEFT: form */}
        <div>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
            <input
              name="customerName"
              value={form.customerName}
              onChange={handleChange}
              type="text"
              placeholder="Customer Name"
              className="w-full border rounded px-3 py-2"
              required
            />

            <input
              name="address"
              value={form.address}
              onChange={handleChange}
              type="text"
              placeholder="Address"
              className="w-full border rounded px-3 py-2"
              required
            />

            <div className="grid grid-cols-2 gap-4">
              <input
                name="city"
                value={form.city}
                onChange={handleChange}
                type="text"
                placeholder="City"
                className="border rounded px-3 py-2"
                required
              />
              <input
                name="state"
                value={form.state}
                onChange={handleChange}
                type="text"
                placeholder="State"
                className="border rounded px-3 py-2"
                required
              />
            </div>

            <input
              name="zip"
              value={form.zip}
              onChange={handleChange}
              type="text"
              placeholder="Zip"
              className="w-full border rounded px-3 py-2"
              required
            />

            <input
              name="phone"
              value={form.phone}
              onChange={handleChange}
              type="text"
              placeholder="Phone"
              className="w-full border rounded px-3 py-2"
              required
            />

            <input
              name="managerName"
              value={form.managerName}
              onChange={handleChange}
              type="text"
              placeholder="Manager's Name"
              className="w-full border rounded px-3 py-2"
              required
            />

            <input
              name="email"
              value={form.email}
              onChange={handleChange}
              type="email"
              placeholder="Email"
              className="w-full border rounded px-3 py-2"
              required
            />

            <div className="space-y-1">
              <div className="text-sm font-medium">Follow Up Date</div>
              <input
                name="followUpDate"
                value={form.followUpDate}
                onChange={handleChange}
                type="date"
                className="w-full border rounded px-3 py-2"
                required
              />
            </div>

            <input
              name="storeType"
              value={form.storeType}
              onChange={handleChange}
              type="text"
              placeholder="Store Type"
              className="w-full border rounded px-3 py-2"
              required
            />

            <input
              name="grocerySupplier"
              value={form.grocerySupplier}
              onChange={handleChange}
              type="text"
              placeholder="Grocery Supplier"
              className="w-full border rounded px-3 py-2"
            />

            <textarea
              name="comments"
              value={form.comments}
              onChange={handleChange}
              placeholder="Comments"
              className="w-full border rounded px-3 py-2"
              rows={4}
              required
            />

            <button
              type="submit"
              className={`bg-gray-900 text-white px-4 py-2 rounded ${
                saving ? "opacity-60 cursor-not-allowed" : ""
              }`}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Lead"}
            </button>
          </form>
        </div>

        {/* RIGHT: details + table */}
        <div className="max-w-full self-start">
          {selectedLead ? (
            <div className="border rounded bg-white p-3 mb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{selectedLead.customerName}</div>
                  <div className="text-sm text-gray-600">
                    {selectedLead.city}, {selectedLead.state}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-sm px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-60"
                    onClick={saveLeadDetails}
                    disabled={savingDetails}
                    title="Save changes"
                  >
                    {savingDetails ? "Saving..." : "Save"}
                  </button>

                  <button
                    type="button"
                    className="text-sm px-2 py-1 rounded border hover:bg-gray-50"
                    onClick={() => setSelectedLead(null)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-gray-500">Next Follow Up</div>
                  <input
                    type="date"
                    className="mt-1 w-full border rounded px-2 py-2"
                    value={detailFollowUpDate}
                    onChange={(e) => setDetailFollowUpDate(e.target.value)}
                  />
                  <div className="mt-1 text-sm">
                    {(() => {
                      const ts = detailFollowUpDate
                        ? dateInputToTimestamp(detailFollowUpDate)
                        : undefined;
                      const d = daysUntil(ts);
                      if (d === null) return null;
                      if (d < 0)
                        return (
                          <span className="text-red-600">
                            {Math.abs(d)} day(s) overdue
                          </span>
                        );
                      if (d === 0)
                        return <span className="text-yellow-700">Today</span>;
                      return (
                        <span className="text-gray-600">in {d} day(s)</span>
                      );
                    })()}
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Status</div>
                  <div className="mt-1 flex flex-col gap-1">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="detailStatus"
                        value="open"
                        checked={detailStatus === "open"}
                        onChange={() => setDetailStatus("open")}
                      />
                      <span>Open lead</span>
                    </label>

                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="detailStatus"
                        value="closed_no_lead"
                        checked={detailStatus === "closed_no_lead"}
                        onChange={() => setDetailStatus("closed_no_lead")}
                      />
                      <span>Closed — no longer a lead</span>
                    </label>

                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="detailStatus"
                        value="closed_account"
                        checked={detailStatus === "closed_account"}
                        onChange={() => setDetailStatus("closed_account")}
                      />
                      <span>Closed — became an account</span>
                    </label>
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Manager</div>
                  <div className="font-medium">{selectedLead.managerName}</div>
                </div>

                <div>
                  <div className="text-gray-500">Phone</div>
                  <div className="font-medium">{selectedLead.phone}</div>
                </div>

                <div>
                  <div className="text-gray-500">Email</div>
                  <div className="font-medium">{selectedLead.email}</div>
                </div>

                <div className="md:col-span-2">
                  <div className="text-gray-500">Address</div>
                  <div className="font-medium">
                    {selectedLead.address}
                    {selectedLead.zip ? `, ${selectedLead.zip}` : ""}
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Store Type</div>
                  <div className="font-medium">{selectedLead.storeType}</div>
                </div>

                <div>
                  <div className="text-gray-500">Grocery Supplier</div>
                  <div className="font-medium">
                    {selectedLead.grocerySupplier || "-"}
                  </div>
                </div>

                <div className="md:col-span-2">
                  <div className="text-gray-500">Comments</div>
                  <textarea
                    className="mt-1 w-full border rounded px-2 py-2"
                    rows={4}
                    value={detailComments}
                    onChange={(e) => setDetailComments(e.target.value)}
                    placeholder="Update comments..."
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="border rounded overflow-hidden bg-white">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 sticky top-0 z-10">
                  <tr>
                    <th className="text-left p-2">Follow Up</th>
                    <th className="text-left p-2">Customer</th>
                    <th className="text-left p-2">City</th>
                    <th className="text-left p-2">State</th>
                    <th className="text-left p-2">Phone</th>
                    <th className="text-left p-2">Email</th>
                    <th className="text-left p-2">Store Type</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingLeads ? (
                    <tr>
                      <td className="p-3 text-gray-500" colSpan={7}>
                        Loading...
                      </td>
                    </tr>
                  ) : leads.length === 0 ? (
                    <tr>
                      <td className="p-3 text-gray-500" colSpan={7}>
                        No leads yet.
                      </td>
                    </tr>
                  ) : (
                    leads.map((l) => {
                      const d = daysUntil(l.followUpDate);
                      const rowClass =
                        d === null
                          ? ""
                          : d < 0
                          ? "bg-red-100"
                          : d <= 3
                          ? "bg-yellow-100"
                          : "";

                      const selected = selectedLead?.id === l.id;

                      return (
                        <tr
                          key={l.id}
                          className={`border-t cursor-pointer hover:bg-gray-50 ${rowClass} ${
                            selected ? "ring-1 ring-gray-300" : ""
                          }`}
                          onClick={() => setSelectedLead(l)}
                          title="Click to view details"
                        >
                          <td className="p-2 whitespace-nowrap">
                            {l.followUpDate?.toDate
                              ? l.followUpDate.toDate().toLocaleDateString()
                              : ""}
                          </td>
                          <td className="p-2">{l.customerName}</td>
                          <td className="p-2">{l.city}</td>
                          <td className="p-2">{l.state}</td>
                          <td className="p-2 whitespace-nowrap">{l.phone}</td>
                          <td className="p-2">{l.email}</td>
                          <td className="p-2">{l.storeType}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
