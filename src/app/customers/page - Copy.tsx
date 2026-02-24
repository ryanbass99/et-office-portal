"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  deleteDoc,
  addDoc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  or,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentSnapshot,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";

type Customer = {
  id: string;
  customerNo: string;
  customerName: string;
  address1?: string;
  city?: string;
  state?: string;
  stateUpper?: string;
  phone?: string;

  dateLastActivity?: any;
  lastActivityDate?: any;
  lastActivity?: any;
  date_last_activity?: any;
  lastInvoiceDate?: any;
  lastSaleDate?: any;

  activityDays?: number | string;
  daysSinceLastActivity?: number | string;
  lastActivityDays?: number | string;
  daysInactive?: number | string;
  inactiveDays?: number | string;

  buyerEmail?: string;

  buyer2Email?: string;

  creditHoldBool?: boolean;
  lastActivityBucket?: string;
  status?: "A" | "I" | string;

  currentBalance?: string | number;
  udf250TotalSales?: string | number;

  email?: string;
};

type Salesperson = {
  uid: string;
  name: string;
  salespersonNo: string;
  role?: string;
};

type Note = {
  id: string;
  text: string;
  pinned?: boolean;
  followUpDate?: any;
  createdAt?: any;
  updatedAt?: any;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;
};

function fmtTs(ts: any) {
  try {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (!d) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function fmtDateOnly(ts: any) {
  try {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (!d) return "";
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function noteHighlightClass(n: Note) {
  const raw = (n as any).followUpDate;
  const d: Date | null = raw?.toDate ? raw.toDate() : raw instanceof Date ? raw : null;
  if (!d) return "";

  const today = startOfDay(new Date()).getTime();
  const due = startOfDay(d).getTime();
  const msDay = 1000 * 60 * 60 * 24;
  const daysUntil = Math.floor((due - today) / msDay);

  if (daysUntil < 0) return "bg-red-50 border-red-200";
  if (daysUntil <= 3) return "bg-yellow-50 border-yellow-200";
  return "";
}

type CallPrepItem = { itemCode: string; itemCodeDesc?: string | null; qty: number };
type PitchNextItem = CallPrepItem & { reason: string };

type CallPrepResponse = {
  customerNo: string;
  customer: {
    customerName: string | null;
    address1: string | null;
    city: string | null;
    state: string | null;
    phone: string | null;
    buyerEmail: string | null;
    creditHold: string | null;
    creditHoldBool: boolean;
    status: string | null;
    salespersonNo: string | null;
  };
  stats: {
    lastInvoice: {
      invoiceNo: string;
      invoiceDate: string | null;
    } | null;
    daysSinceLastInvoice: number | null;
    avgDaysBetweenLast5: number | null;
  };
  itemIntel: {
    topItemsLast365: CallPrepItem[];
    topItemsAllTime: CallPrepItem[];
    stoppedBuying: CallPrepItem[];
    pitchNext?: PitchNextItem[];
    last90UniqueItemCount: number;
    invoicesScannedForItems: number;
  };
};

const PAGE_SIZE = 50;
const FETCH_CHUNK = 500;

function toMoney(v: any) {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function normalizeSalespersonNo(v: string) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length >= 4 ? s : s.padStart(4, "0");
}
function normalizeItemCode(v: string) {
  return String(v || "").trim().toUpperCase();
}

function parseCustomerDate(v: any): Date | null {
  if (v && typeof v === "object") {
    if (typeof (v as any).toDate === "function") {
      const d = (v as any).toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
    if (typeof (v as any).seconds === "number") {
      const d = new Date((v as any).seconds * 1000);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const s = String(v ?? "").trim();
  if (!s) return null;

  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy >= 1900) {
      const d = new Date(yyyy, mm - 1, dd);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  return null;
}

function daysSince(d: Date): number {
  const now = Date.now();
  const diff = now - d.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getCustomerAgeDays(c: any): number | null {
  const candidates = [
    c.activityDays,
    c.daysSinceLastActivity,
    c.lastActivityDays,
    c.daysInactive,
    c.inactiveDays,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }

  const dv =
    c.dateLastActivity ??
    c.lastActivityDate ??
    c.lastActivity ??
    c.date_last_activity ??
    c.lastInvoiceDate ??
    c.lastInvoice ??
    c.lastSaleDate ??
    c.lastSale ??
    null;

  const d = parseCustomerDate(dv);
  if (!d) return null;
  return daysSince(d);
}

export default function CustomersPage() {
  const auth = getAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [allRows, setAllRows] = useState<Customer[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [search, setSearch] = useState("");
  const [salespersonNo, setSalespersonNo] = useState<string>("");

  // role + admin-only rep switcher
  const [role, setRole] = useState<string>("");
  const isAdmin = role === "admin";

  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [selectedSalespersonNo, setSelectedSalespersonNo] = useState<string>("");

  const [error, setError] = useState<string>("");
  const [totalForRep, setTotalForRep] = useState<number | null>(null);

  // chips
  const [creditHoldOnly, setCreditHoldOnly] = useState(false);
  const [activityBucket, setActivityBucket] = useState<
    "lt60" | "60_120" | "gt120" | "unknown" | ""
  >("");
  const [statusFilter, setStatusFilter] = useState<"" | "A" | "I">("");
  const [top50Only, setTop50Only] = useState(false);
  const [stateFilter, setStateFilter] = useState<string>("");

  // dashboard quick views
  const [quickView, setQuickView] = useState<"" | "atRisk45" | "inactive60">("");

  // preset mode: whitespace list (NOT bought item)
  const [invertItemFilter, setInvertItemFilter] = useState(false);

  // item filter
  const [itemInput, setItemInput] = useState<string>("");
  const [activeItemCode, setActiveItemCode] = useState<string>("");
  const [itemCustomerSet, setItemCustomerSet] = useState<Set<string> | null>(null);
  const [itemLoading, setItemLoading] = useState<boolean>(false);
  const [itemError, setItemError] = useState<string>("");

  // export
  const [exporting, setExporting] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string>("");

  const ITEM_BUTTONS: { label: string; code: string }[] = [
    { label: "2025 Mothers Day", code: "K573" },
    { label: "Wing Rack Topper", code: "K191" },
    { label: "9 Bin", code: "K203" },
    { label: "4-Tier", code: "K233" },
    { label: "PD Bulk", code: "K399" },
    { label: "Cable Wing Rack", code: "K411" },
    { label: "PD Cable Wing Rack", code: "K412" },
    { label: "Wing Rack 99", code: "K414" },
    { label: "8' Cable Wing Topper", code: "K452" },
    { label: "8' PD Wing Topper", code: "K453" },
    { label: "Everyday Sunglasses", code: "K251" },
    { label: "Sunglass Spinner", code: "K494" },
  ];

  const [sortKey, setSortKey] = useState<
    "customer" | "address" | "city" | "phone" | "balance" | "sales"
  >("customer");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ---- Call Prep drawer ----
  const [callPrepOpen, setCallPrepOpen] = useState(false);
  const [callPrepFor, setCallPrepFor] = useState<Customer | null>(null);
  const [callPrepLoading, setCallPrepLoading] = useState(false);
  const [callPrepError, setCallPrepError] = useState<string | null>(null);
  const [callPrepData, setCallPrepData] = useState<CallPrepResponse | null>(null);

  // ---- Notes drawer ----
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesFor, setNotesFor] = useState<Customer | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesRows, setNotesRows] = useState<Note[]>([]);
  const [newNoteText, setNewNoteText] = useState<string>("");
  const [newNoteFollowUp, setNewNoteFollowUp] = useState<string>("");
  const [notesSaving, setNotesSaving] = useState<boolean>(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState<string>("");
  const [editingNoteFollowUp, setEditingNoteFollowUp] = useState<string>("");
  const [notesCountByCustomerNo, setNotesCountByCustomerNo] = useState<Record<string, number>>(
    {}
  );

  async function refreshNotesCount(customerNo: string) {
    const key = String(customerNo || "").trim();
    if (!key) return;

    try {
      const colRef = collection(db, "customers", key, "notes");
      const snap = await getCountFromServer(colRef);
      const count = snap.data().count || 0;

      setNotesCountByCustomerNo((prev) => {
        if (prev[key] === count) return prev;
        return { ...prev, [key]: count };
      });
    } catch (e) {
      console.error("refreshNotesCount failed", key, e);
    }
  }

  function closeNotes() {
    const key = String(notesFor?.customerNo || "").trim();
    setNotesOpen(false);
    setNotesFor(null);

    if (key) refreshNotesCount(key);
  }

  async function openCallPrep(c: Customer) {
    setCallPrepOpen(true);
    setCallPrepFor(c);
    setCallPrepLoading(true);
    setCallPrepError(null);
    setCallPrepData(null);

    try {
      const res = await fetch(`/api/call-prep?customerNo=${encodeURIComponent(c.customerNo)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Failed to load call prep (${res.status})`);
      setCallPrepData(json as CallPrepResponse);
    } catch (e: any) {
      setCallPrepError(e?.message ?? "Failed to load call prep");
    } finally {
      setCallPrepLoading(false);
    }
  }

  function openNotes(c: Customer) {
    setNotesOpen(true);
    setNotesFor(c);
    setNotesError(null);
    setNotesRows([]);
    setNewNoteText("");
    setNewNoteFollowUp("");
    setEditingNoteId(null);
    setEditingNoteText("");
    setEditingNoteFollowUp("");
  }

  const searchTimer = useRef<any>(null);

  // Notes realtime subscription (customers/{customerNo}/notes)
  useEffect(() => {
    if (!notesOpen || !notesFor?.customerNo) {
      setNotesRows([]);
      setNotesLoading(false);
      return;
    }

    setNotesLoading(true);
    setNotesError(null);

    const notesRef = collection(db, "customers", notesFor.customerNo, "notes");
    const q = query(
      notesRef,
      orderBy("pinned", "desc"),
      orderBy("updatedAt", "desc"),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: Note[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setNotesRows(rows);
        setNotesLoading(false);
      },
      (err) => {
        console.error("Notes snapshot error:", err);
        setNotesError(err?.message ?? "Failed to load notes");
        setNotesLoading(false);
      }
    );

    return () => unsub();
  }, [notesOpen, notesFor?.customerNo]);

  async function addNote() {
    const text = newNoteText.trim();
    if (!text || !notesFor?.customerNo) return;

    const user = auth.currentUser;
    if (!user) {
      alert("Not signed in.");
      return;
    }

    setNotesSaving(true);
    try {
      const notesRef = collection(db, "customers", notesFor.customerNo, "notes");
      await addDoc(notesRef, {
        text,
        pinned: false,
        ...(newNoteFollowUp.trim()
          ? { followUpDate: new Date(`${newNoteFollowUp}T00:00:00`) }
          : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByUid: user.uid,
        createdByName: user.displayName || user.email || "",
        updatedByUid: user.uid,
      });

      // Make Notes pill go green immediately
      setNotesCountByCustomerNo((prev) => {
        const key = String(notesFor.customerNo || "").trim();
        if (!key) return prev;
        const nextCount = Math.max(1, (prev[key] || 0) + 1);
        return { ...prev, [key]: nextCount };
      });
      refreshNotesCount(notesFor.customerNo);

      setNewNoteText("");
      setNewNoteFollowUp("");
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? "Failed to save note");
    } finally {
      setNotesSaving(false);
    }
  }

  function startEditNote(n: Note) {
    setEditingNoteId(n.id);
    setEditingNoteText(n.text || "");
    const raw = (n as any).followUpDate;
    const d: Date | null = raw?.toDate ? raw.toDate() : raw instanceof Date ? raw : null;
    setEditingNoteFollowUp(d ? d.toISOString().slice(0, 10) : "");
  }

  function cancelEditNote() {
    setEditingNoteId(null);
    setEditingNoteText("");
    setEditingNoteFollowUp("");
  }

  async function saveEditNote() {
    if (!notesFor?.customerNo || !editingNoteId) return;
    const text = editingNoteText.trim();
    if (!text) return;

    const user = auth.currentUser;
    if (!user) {
      alert("Not signed in.");
      return;
    }

    setNotesSaving(true);
    try {
      const ref = doc(db, "customers", notesFor.customerNo, "notes", editingNoteId);
      await updateDoc(ref, {
        text,
        followUpDate: editingNoteFollowUp.trim()
          ? new Date(`${editingNoteFollowUp}T00:00:00`)
          : null,
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid,
      });
      cancelEditNote();
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? "Failed to update note");
    } finally {
      setNotesSaving(false);
    }
  }

  async function togglePinNote(n: Note) {
    if (!notesFor?.customerNo) return;

    const user = auth.currentUser;
    if (!user) {
      alert("Not signed in.");
      return;
    }

    setNotesSaving(true);
    try {
      const ref = doc(db, "customers", notesFor.customerNo, "notes", n.id);
      await updateDoc(ref, {
        pinned: !Boolean((n as any).pinned),
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid,
      });
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? "Failed to pin/unpin note");
    } finally {
      setNotesSaving(false);
    }
  }

  async function deleteNote(noteId: string) {
    if (!notesFor?.customerNo) return;
    if (!confirm("Delete this note?")) return;

    setNotesSaving(true);
    try {
      const ref = doc(db, "customers", notesFor.customerNo, "notes", noteId);
      await deleteDoc(ref);
      refreshNotesCount(notesFor.customerNo);
      if (editingNoteId === noteId) cancelEditNote();
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? "Failed to delete note");
    } finally {
      setNotesSaving(false);
    }
  }

  function mapSnap(snap: any): Customer[] {
    return snap.docs.map((d: any) => {
      const v = d.data() as any;
      return {
        id: d.id,
        customerNo: String(v.customerNo ?? d.id ?? ""),
        customerName: String(v.customerName ?? ""),
        address1: v.address1 ?? "",
        city: v.city ?? "",
        state: v.state ?? "",
        stateUpper: v.stateUpper ?? (v.state ? String(v.state).toUpperCase() : ""),
        phone: v.phone ?? "",

        dateLastActivity:
          v.dateLastActivity ??
          v.lastActivityDate ??
          v.lastActivity ??
          v.date_last_activity ??
          v.lastInvoiceDate ??
          v.lastSaleDate ??
          "",
        lastActivityDate: v.lastActivityDate ?? null,
        lastActivity: v.lastActivity ?? null,
        date_last_activity: v.date_last_activity ?? null,
        lastInvoiceDate: v.lastInvoiceDate ?? null,
        lastSaleDate: v.lastSaleDate ?? null,

        activityDays: v.activityDays ?? null,
        daysSinceLastActivity: v.daysSinceLastActivity ?? null,
        lastActivityDays: v.lastActivityDays ?? null,
        daysInactive: v.daysInactive ?? null,
        inactiveDays: v.inactiveDays ?? null,

        creditHoldBool: v.creditHoldBool ?? undefined,
        lastActivityBucket: v.lastActivityBucket ?? "",
        status: v.status ?? "",
        currentBalance: v.currentBalance ?? "",
        udf250TotalSales: v.udf250TotalSales ?? v.udf250Totalsales ?? "",
        buyerEmail: v.buyerEmail ?? "",
        buyer2Email: v.buyer2Email ?? "",
email: v.email ?? "",
      };
    });
  }

  async function fetchAllForRep(sp: string) {
    setError("");

    try {
      const countSnap = await getCountFromServer(
        query(
          collection(db, "customers"),
          or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp))
        )
      );
      setTotalForRep(countSnap.data().count);
    } catch {
      // ignore
    }

    let all: Customer[] = [];
    let last: DocumentSnapshot | null = null;

    while (true) {
      const qAny: any = last
        ? query(
            collection(db, "customers"),
            or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp)),
            orderBy("customerName"),
            startAfter(last),
            limit(FETCH_CHUNK)
          )
        : query(
            collection(db, "customers"),
            or(where("salespersonNo", "==", sp), where("salespersonNo2", "==", sp)),
            orderBy("customerName"),
            limit(FETCH_CHUNK)
          );

      const snap = await getDocs(qAny);
      all = all.concat(mapSnap(snap));

      if (snap.docs.length < FETCH_CHUNK) break;
      last = snap.docs[snap.docs.length - 1] as any;
    }

    setAllRows(all);
    setVisibleCount(PAGE_SIZE);
  }

  async function fetchCustomersWhoOrderedItem(itemCode: string, sp: string) {
    const code = normalizeItemCode(itemCode);
    if (!code) {
      setActiveItemCode("");
      setItemCustomerSet(null);
      return;
    }

    const rep = normalizeSalespersonNo(sp);
    if (!rep) return;

    setItemError("");
    setItemLoading(true);

    try {
      const docId = `${code}__${rep}`;
      const ref = doc(db, "itemCustomerIndex", docId);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        setItemCustomerSet(new Set());
        return;
      }

      const v = snap.data() as any;
      const list: string[] = Array.isArray(v.customerNos) ? v.customerNos : [];
      const set = new Set<string>(list.map((x) => String(x ?? "").trim()).filter(Boolean));
      setItemCustomerSet(set);
    } catch (e: any) {
      console.error(e);
      setItemCustomerSet(null);
      setItemError(
        e?.code ? `${e.code}: ${e.message ?? ""}` : String(e?.message ?? e ?? "Unknown error")
      );
    } finally {
      setItemLoading(false);
    }
  }

  async function exportCustomersEmail(customerNos: string[]) {
    try {
      setExporting(true);

      const user = auth.currentUser;
      if (!user) {
        setUserEmail("");
        alert("Not signed in.");
        return;
      }

      if (!customerNos.length) {
        alert("No customers match your current filters.");
        return;
      }

      const idToken = await user.getIdToken();

      const res = await fetch("/api/export-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, customerNos }),
      });

      const data = await res.json();

      if (res.ok && data?.ok) {
        alert(`Export emailed to ${data.sentTo}. (${data.count ?? "?"} customers)`);
      } else {
        alert(`Error: ${data?.error ?? "Unknown error"}`);
      }
    } catch (err: any) {
      alert(`Error: ${err?.message ?? String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  // auth + load
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setLoading(true);
      setError("");
      setAllRows([]);
      setVisibleCount(PAGE_SIZE);
      setTotalForRep(null);

      if (!user) {
        setUserEmail("");
        setSalespersonNo("");
        setLoading(false);
        return;
      }

      setUserEmail(user.email ?? "");

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        const u = (userSnap.data() as any) || {};
        setRole(String(u.role ?? ""));

        const sp = normalizeSalespersonNo(String(u.salesperson ?? ""));
        setSalespersonNo(sp);

        if (!sp) {
          setAllRows([]);
          setLoading(false);
          return;
        }

        await fetchAllForRep(sp);
      } catch (e: any) {
        console.error(e);
        setError(
          e?.code ? `${e.code}: ${e.message ?? ""}` : String(e?.message ?? e ?? "Unknown error")
        );
        setAllRows([]);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Admin-only: load salespeople for rep pills
  useEffect(() => {
    if (!isAdmin) {
      setSalespeople([]);
      setSelectedSalespersonNo("");
      return;
    }

    (async () => {
      try {
        const snap = await getDocs(collection(db, "users"));

        const rows: Salesperson[] = snap.docs
          .map((d) => {
            const v = d.data() as any;

            const sp = normalizeSalespersonNo(String(v.salesperson ?? ""));
            if (!sp) return null;

            const r = String(v.role ?? "").toLowerCase();
            if (r === "admin") return null;

            const name = String(v.name ?? v.displayName ?? v.fullName ?? v.email ?? sp).trim();
            return { uid: d.id, name: name || sp, salespersonNo: sp, role: v.role };
          })
          .filter(Boolean) as Salesperson[];

        rows.sort((a, b) => a.name.localeCompare(b.name));
        setSalespeople(rows);
      } catch (e) {
        console.error(e);
        setSalespeople([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Admin-only: switch rep when a pill is clicked
  useEffect(() => {
    if (!isAdmin) return;

    const sp = normalizeSalespersonNo(selectedSalespersonNo);
    if (!sp) return;

    (async () => {
      setLoading(true);
      setError("");
      setAllRows([]);
      setVisibleCount(PAGE_SIZE);
      setTotalForRep(null);

      try {
        setSalespersonNo(sp);
        await fetchAllForRep(sp);
      } catch (e: any) {
        console.error(e);
        setError(
          e?.code ? `${e.code}: ${e.message ?? ""}` : String(e?.message ?? e ?? "Unknown error")
        );
        setAllRows([]);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSalespersonNo, isAdmin]);

  // quick preset from Sales Tools: /customers?quick=whitespace&top50=1&item=K411
  useEffect(() => {
    const quick = (searchParams.get("quick") || "").trim();
    const view = (searchParams.get("view") || "").trim();
    const item = normalizeItemCode(searchParams.get("item") || "");
    const top50Param = (searchParams.get("top50") || "").trim() === "1";

    if (quick === "whitespace" && item) {
      setQuickView("");
      setInvertItemFilter(true);
      setItemInput(item);
      setActiveItemCode(item);

      setSortKey("sales");
      setSortDir("desc");
      setTop50Only(top50Param);
      setVisibleCount(PAGE_SIZE);

      setSearch("");
      setCreditHoldOnly(false);
      setActivityBucket("");
      setStatusFilter("");
      setStateFilter("");
      return;
    }

    // dashboard views
    if (view === "atRisk45" || view === "inactive60") {
      setQuickView(view);

      setVisibleCount(PAGE_SIZE);
      setSearch("");
      setCreditHoldOnly(false);
      setStatusFilter("");
      setStateFilter("");
      setTop50Only(false);
      setInvertItemFilter(false);
      setActiveItemCode("");
      setItemInput("");
      setActivityBucket("");

      setSortKey("sales");
      setSortDir("desc");
      return;
    }

    setQuickView("");
    setInvertItemFilter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Deep-link: /customers?customerNo=XXXX&open=notes
  useEffect(() => {
    const open = (searchParams.get("open") || "").trim();
    const customerNo = (searchParams.get("customerNo") || "").trim();

    if (open !== "notes" || !customerNo) return;

    const found = allRows.find((r) => String(r.customerNo || "").trim() === customerNo) || null;

    async function run() {
      try {
        if (found) {
          openNotes(found);
        } else {
          const snap = await getDoc(doc(db, "customers", customerNo));
          const data = snap.exists() ? (snap.data() as any) : {};
          openNotes({
            id: customerNo,
            customerNo,
            customerName: data.customerName || data.customer || customerNo,
          } as Customer);
        }
      } finally {
        const next = new URLSearchParams(searchParams.toString());
        next.delete("open");
        next.delete("customerNo");
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      }
    }

    if (!notesOpen || notesFor?.customerNo !== customerNo) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, allRows]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setVisibleCount(PAGE_SIZE);
    }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Only fetch buyers list once BOTH item + rep are known
  useEffect(() => {
    if (!activeItemCode) {
      setItemCustomerSet(null);
      setItemError("");
      setItemLoading(false);
      return;
    }
    if (!salespersonNo) return;

    fetchCustomersWhoOrderedItem(activeItemCode, salespersonNo);
    setVisibleCount(PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItemCode, salespersonNo]);

  const filteredAll = useMemo(() => {
    const s = search.trim().toLowerCase();

    const salesNum = (v: any) => {
      if (v === null || v === undefined || v === "") return 0;
      const n = Number(String(v).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    const baseRows =
      quickView === "atRisk45"
        ? [...allRows]
            .sort((a, b) => salesNum(b.udf250TotalSales) - salesNum(a.udf250TotalSales))
            .slice(0, 50)
        : allRows;

    return baseRows.filter((c) => {
      if (quickView) {
        const age = getCustomerAgeDays(c);
        if (age === null) return false;

        if (quickView === "inactive60") {
          if (age < 60) return false;
        }

        if (quickView === "atRisk45") {
          if (age < 60) return false;
        }
      }

      if (creditHoldOnly && c.creditHoldBool !== true) return false;
      if (activityBucket && (c.lastActivityBucket ?? "") !== activityBucket) return false;
      if (statusFilter && String(c.status ?? "") !== statusFilter) return false;
      if (stateFilter && String(c.stateUpper ?? "") !== stateFilter) return false;

      if (activeItemCode) {
        if (!itemCustomerSet) return false;
        const has = itemCustomerSet.has(String(c.customerNo ?? "").trim());
        if (invertItemFilter) {
          if (has) return false;
        } else {
          if (!has) return false;
        }
      }

      if (!s) return true;

      return (
        c.customerNo.toLowerCase().includes(s) ||
        c.customerName.toLowerCase().includes(s) ||
        (c.address1 ?? "").toLowerCase().includes(s) ||
        (c.city ?? "").toLowerCase().includes(s) ||
        (c.state ?? "").toLowerCase().includes(s) ||
        (c.phone ?? "").toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s)
      );
    });
  }, [
    allRows,
    search,
    quickView,
    creditHoldOnly,
    activityBucket,
    statusFilter,
    stateFilter,
    activeItemCode,
    itemCustomerSet,
    invertItemFilter,
  ]);

  const stateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allRows) {
      const st = String(c.stateUpper ?? "").trim();
      if (st) set.add(st);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const sortedAll = useMemo(() => {
    const rows = [...filteredAll];
    const dir = sortDir === "asc" ? 1 : -1;

    const toNum = (v: any) => {
      if (v === null || v === undefined || v === "") return NaN;
      const n = Number(String(v).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : NaN;
    };

    rows.sort((a, b) => {
      switch (sortKey) {
        case "customer":
          return dir * a.customerName.localeCompare(b.customerName);
        case "address":
          return dir * (a.address1 ?? "").localeCompare(b.address1 ?? "");
        case "city":
          return dir * (a.city ?? "").localeCompare(b.city ?? "");
        case "phone":
          return dir * (a.phone ?? "").localeCompare(b.phone ?? "");
        case "balance": {
          const an = toNum(a.currentBalance);
          const bn = toNum(b.currentBalance);
          if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
          if (Number.isNaN(an)) return 1;
          if (Number.isNaN(bn)) return -1;
          return dir * (an - bn);
        }
        case "sales": {
          const an = toNum(a.udf250TotalSales);
          const bn = toNum(b.udf250TotalSales);
          if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
          if (Number.isNaN(an)) return 1;
          if (Number.isNaN(bn)) return -1;
          return dir * (an - bn);
        }
        default:
          return 0;
      }
    });

    return rows;
  }, [filteredAll, sortKey, sortDir]);

  const topRows = useMemo(() => (top50Only ? sortedAll.slice(0, 50) : sortedAll), [
    top50Only,
    sortedAll,
  ]);

  const visibleRows = useMemo(() => topRows.slice(0, visibleCount), [topRows, visibleCount]);

  // Notes pill: show green if customer has at least 1 note
  useEffect(() => {
    let cancelled = false;

    async function loadNoteCounts() {
      try {
        const customerNos = (visibleRows || [])
          .map((c) => String((c as any).customerNo || "").trim())
          .filter(Boolean);

        if (customerNos.length === 0) {
          if (!cancelled) setNotesCountByCustomerNo({});
          return;
        }

        const entries = await Promise.all(
          customerNos.map(async (customerNo) => {
            try {
              const colRef = collection(db, "customers", customerNo, "notes");
              const snap = await getCountFromServer(colRef);
              return [customerNo, snap.data().count] as const;
            } catch (e) {
              console.error("notes count failed", customerNo, e);
              return [customerNo, 0] as const;
            }
          })
        );

        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const [k, v] of entries) next[k] = v;
        setNotesCountByCustomerNo(next);
      } catch (e) {
        console.error("loadNoteCounts failed", e);
      }
    }

    loadNoteCounts();
    return () => {
      cancelled = true;
    };
  }, [visibleRows]);

  const hasMore = !top50Only && visibleCount < topRows.length;

  async function loadMore() {
    if (top50Only) return;
    setLoadingMore(true);
    try {
      setVisibleCount((v) => Math.min(v + PAGE_SIZE, sortedAll.length));
    } finally {
      setLoadingMore(false);
    }
  }

  function resetChips() {
    setCreditHoldOnly(false);
    setActivityBucket("");
    setStatusFilter("");
    setStateFilter("");
    setInvertItemFilter(false);
    setTop50Only(false);
    setVisibleCount(PAGE_SIZE);
  }

  function toggleSort(key: "customer" | "address" | "city" | "phone" | "balance" | "sales") {
    setVisibleCount(PAGE_SIZE);
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortIcon(key: typeof sortKey) {
    if (sortKey !== key) return <span className="ml-1 text-gray-300">▲</span>;
    return <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  const exportCustomerNos = useMemo(() => {
    return topRows
      .map((c) => String(c.customerNo || "").trim())
      .filter(Boolean);
  }, [topRows]);

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Customers</h1>
            <p className="text-gray-600 text-sm">
              Showing {visibleRows.length} • Total: {topRows.length}
            </p>
            <p className="text-gray-500 text-xs">
              Rep: {salespersonNo || "(none)"}
              {totalForRep !== null ? ` • Total: ${totalForRep}` : ""}
            </p>

            {/* Filter chips */}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  !creditHoldOnly && !activityBucket && !statusFilter
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={resetChips}
              >
                All
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  creditHoldOnly
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setCreditHoldOnly((v) => !v);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                Credit Hold
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  activityBucket === "lt60"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setActivityBucket((v) => (v === "lt60" ? "" : "lt60"));
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                Activity &lt; 60
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  activityBucket === "60_120"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setActivityBucket((v) => (v === "60_120" ? "" : "60_120"));
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                Activity 60–120
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  activityBucket === "gt120"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setActivityBucket((v) => (v === "gt120" ? "" : "gt120"));
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                Activity &gt; 120
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  statusFilter === "A"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setStatusFilter((v) => (v === "A" ? "" : "A"));
                  setVisibleCount(PAGE_SIZE);
                }}
                title="Active"
              >
                Active
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  statusFilter === "I"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setStatusFilter((v) => (v === "I" ? "" : "I"));
                  setVisibleCount(PAGE_SIZE);
                }}
                title="Inactive"
              >
                Inactive
              </button>

              <button
                className={`px-3 py-1 rounded-full border text-xs ${
                  top50Only
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => {
                  setTop50Only((v) => !v);
                  setSortKey("sales");
                  setSortDir("desc");
                  setVisibleCount(PAGE_SIZE);
                  setStatusFilter("");
                  setActivityBucket("");
                }}
                title="Top 50 accounts by 2025 sales"
              >
                Top 50
              </button>
            </div>

            {/* State chips */}
            {stateOptions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className={`px-3 py-1 rounded-full border text-xs ${
                    !stateFilter
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white hover:bg-gray-50"
                  }`}
                  onClick={() => {
                    setStateFilter("");
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  All States
                </button>

                {stateOptions.map((st) => (
                  <button
                    key={st}
                    className={`px-3 py-1 rounded-full border text-xs ${
                      stateFilter === st
                        ? "bg-gray-900 text-white border-gray-900"
                        : "bg-white hover:bg-gray-50"
                    }`}
                    onClick={() => {
                      setStateFilter((v) => (v === st ? "" : st));
                      setVisibleCount(PAGE_SIZE);
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
            ) : null}

            {/* Item filter */}
            <div className="mt-3">
              <div className="text-xs text-gray-600 mb-2">
                {invertItemFilter
                  ? "Show accounts that have NOT ordered item code:"
                  : "Show accounts that ordered item code:"}
                {activeItemCode ? (
                  <span className="ml-2 font-semibold text-gray-900">{activeItemCode}</span>
                ) : (
                  <span className="ml-2 text-gray-400">(none)</span>
                )}
                {itemLoading ? <span className="ml-2 text-gray-500">Loading…</span> : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {ITEM_BUTTONS.map((b) => {
                  const code = normalizeItemCode(b.code);
                  const active = !!code && activeItemCode === code && !invertItemFilter;
                  return (
                    <button
                      key={b.label}
                      type="button"
                      className={`px-3 py-1 rounded-full border text-xs ${
                        active
                          ? "bg-gray-900 text-white border-gray-900"
                          : "bg-white hover:bg-gray-50"
                      } ${!code ? "opacity-40 cursor-not-allowed" : ""}`}
                      onClick={() => {
                        if (!code) return;
                        setInvertItemFilter(false);
                        setItemInput(code);
                        setActiveItemCode(code);
                        setVisibleCount(PAGE_SIZE);
                      }}
                      disabled={!code}
                      title={code || "Set a code"}
                    >
                      {b.label}
                    </button>
                  );
                })}

                <button
                  type="button"
                  className={`px-3 py-1 rounded-full border text-xs ${
                    !activeItemCode
                      ? "bg-gray-100 text-gray-500 border-gray-200 cursor-not-allowed"
                      : "bg-white hover:bg-gray-50"
                  }`}
                  onClick={() => {
                    setInvertItemFilter(false);
                    setItemInput("");
                    setActiveItemCode("");
                    setItemCustomerSet(null);
                    setItemError("");
                    setVisibleCount(PAGE_SIZE);
                  }}
                  disabled={!activeItemCode}
                >
                  Clear Item
                </button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="w-full max-w-[240px] border rounded px-3 py-2 text-sm"
                  placeholder="Enter item code (e.g., K411)"
                  value={itemInput}
                  onChange={(e) => setItemInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const code = normalizeItemCode(itemInput);
                      setInvertItemFilter(false);
                      setActiveItemCode(code);
                    }
                  }}
                />
                <button
                  type="button"
                  className="px-4 py-2 rounded border bg-white hover:bg-gray-100 text-sm"
                  onClick={() => {
                    const code = normalizeItemCode(itemInput);
                    setInvertItemFilter(false);
                    setActiveItemCode(code);
                  }}
                >
                  Apply
                </button>
              </div>

              {/* Admin-only: Salesman filter pills */}
              {isAdmin ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {salespeople.length ? (
                    <>
                      <button
                        type="button"
                        className={`px-3 py-1 rounded-full border text-xs ${
                          !selectedSalespersonNo
                            ? "bg-gray-900 text-white border-gray-900"
                            : "bg-white hover:bg-gray-50"
                        }`}
                        onClick={() => setSelectedSalespersonNo("")}
                        title="Clear salesman filter"
                      >
                        All Salesmen
                      </button>

                      {salespeople.map((sp) => (
                        <button
                          key={sp.uid}
                          type="button"
                          className={`px-3 py-1 rounded-full border text-xs ${
                            selectedSalespersonNo === sp.salespersonNo
                              ? "bg-gray-900 text-white border-gray-900"
                              : "bg-white hover:bg-gray-50"
                          }`}
                          onClick={() => setSelectedSalespersonNo(sp.salespersonNo)}
                          title={`Salesperson #${sp.salespersonNo}`}
                        >
                          {sp.name}
                        </button>
                      ))}
                    </>
                  ) : (
                    <span className="text-xs text-gray-500">No salesmen found.</span>
                  )}
                </div>
              ) : null}

              {itemError ? (
                <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                  {itemError}
                </div>
              ) : null}
            </div>
          </div>

          {/* TOP RIGHT: Export + Search */}
          <div className="w-full max-w-md flex flex-col gap-2 items-end">
            <button
              type="button"
              className={`px-4 py-2 rounded border text-sm ${
                exporting
                  ? "bg-gray-100 text-gray-500 border-gray-200 cursor-not-allowed"
                  : "bg-gray-900 text-white border-gray-900 hover:bg-gray-800"
              }`}
              onClick={() => exportCustomersEmail(exportCustomerNos)}
              disabled={exporting}
              title="Email export of current filtered list"
            >
              {exporting ? (
                "Emailing…"
              ) : (
                <span className="flex flex-col leading-tight">
                  <span>Email to</span>
                  <span className="text-xs opacity-90">{userEmail}</span>
                </span>
              )}
            </button>

            <input
              className="w-full border rounded px-3 py-2"
              placeholder="Search customer #, name, address, phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="text-gray-600">Loading customers...</div>
        ) : error ? (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full table-fixed text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-1 w-[44%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("customer")}
                    >
                      Customer{sortIcon("customer")}
                    </button>
                  </th>
                  <th className="text-left p-1 w-[18%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("address")}
                    >
                      Address{sortIcon("address")}
                    </button>
                  </th>
                  <th className="text-left p-1 w-[16%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("city")}
                    >
                      City{sortIcon("city")}
                    </button>
                  </th>
                  <th className="text-left p-1 w-[10%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("phone")}
                    >
                      Phone{sortIcon("phone")}
                    </button>
                  </th>
                  <th className="text-right p-1 w-[6%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("balance")}
                    >
                      Current Balance{sortIcon("balance")}
                    </button>
                  </th>
                  <th className="text-right p-1 w-[6%]">
                    <button
                      type="button"
                      className="font-semibold hover:underline"
                      onClick={() => toggleSort("sales")}
                    >
                      2025 Sales{sortIcon("sales")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td className="p-1 text-gray-500" colSpan={6}>
                      No customers found.
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-1">
                        <div className="min-w-0">
                          <div className="font-medium leading-4 truncate">{c.customerName}</div>
                          <div className="text-gray-500 leading-4 flex flex-wrap items-center gap-2">
                            <span className="tabular-nums">{c.customerNo}</span>

                            <span className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700">
                              {String(c.status ?? "").toUpperCase() === "I" ? "Inactive" : "Active"}
                            </span>

	                            {(() => {
	                              const raw = [
	                                (c as any).buyerEmail,
	                                (c as any).buyer2Email,
	                              ]
	                                .map((v) => String(v ?? "").trim())
	                                .filter(Boolean);
	                              if (!raw.length) return null;
	                              const seen = new Set<string>();
	                              const emails = raw.filter((e) => {
	                                const k = e.toLowerCase();
	                                if (seen.has(k)) return false;
	                                seen.add(k);
	                                return true;
	                              });
	                              const to = emails.join(",");
	                              return (
	                                <a
	                                  href={`mailto:${to}`}
	                                  className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700 hover:bg-gray-50"
	                                  title={to}
	                                >
	                                  Email Buyer
	                                </a>
	                              );
	                            })()}

                            <button
                              type="button"
                              onClick={() => openCallPrep(c)}
                              className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700 hover:bg-gray-50"
                              title="AI Call Prep"
                            >
                              Call Prep
                            </button>

                            <a
                              href={`/customers/${encodeURIComponent(
                                String(c.customerNo ?? "").trim()
                              )}/invoices`}
                              className="px-1.5 py-0.5 rounded border bg-white text-[10px] text-gray-700 hover:bg-gray-50"
                              title="View invoices"
                            >
                              Invoices
                            </a>

                            <button
                              type="button"
                              onClick={() => openNotes(c)}
                              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                                (notesCountByCustomerNo[String(c.customerNo ?? "").trim()] || 0) >
                                0
                                  ? "bg-green-100 border-green-400 text-green-900"
                                  : "bg-white text-gray-700 hover:bg-gray-50"
                              }`}
                              title="Notes"
                            >
                              Notes
                            </button>

                            {c.creditHoldBool ? (
                              <span className="px-1.5 py-0.5 rounded border text-[10px] bg-red-50 border-red-200 text-red-700">
                                CH
                              </span>
                            ) : null}

                            {c.dateLastActivity ? (
                              <span className="text-[10px] text-gray-500">Last: {c.dateLastActivity}</span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="p-1 truncate">{c.address1 ?? ""}</td>
                      <td className="p-1 truncate">
                        {c.city || c.state
                          ? `${c.city ?? ""}${c.city && c.state ? ", " : ""}${c.state ?? ""}`
                          : ""}
                      </td>
                      <td className="p-1 truncate tabular-nums">{c.phone ?? ""}</td>
                      <td className="p-1 text-right tabular-nums">{toMoney(c.currentBalance)}</td>
                      <td className="p-1 text-right tabular-nums">{toMoney(c.udf250TotalSales)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {hasMore ? (
              <div className="p-2 border-t bg-gray-50 flex justify-center">
                <button
                  className="px-4 py-2 rounded border bg-white hover:bg-gray-100 disabled:opacity-50 text-sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Call Prep Drawer */}
      {callPrepOpen ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label="Close call prep"
            onClick={() => setCallPrepOpen(false)}
          />
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl border-l flex flex-col">
            <div className="p-3 border-b flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold leading-5 truncate">
                  Call Prep{callPrepFor ? ` • ${callPrepFor.customerName}` : ""}
                </div>
                {callPrepFor ? (
                  <div className="text-xs text-gray-500 truncate">{callPrepFor.customerNo}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="px-2 py-1 rounded border bg-white hover:bg-gray-50 text-sm"
                onClick={() => setCallPrepOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="p-3 overflow-auto space-y-4">
              {callPrepLoading ? (
                <div className="text-sm text-gray-600">Loading…</div>
              ) : callPrepError ? (
                <div className="text-sm text-red-700">{callPrepError}</div>
              ) : callPrepData ? (
                <>
                  <div className="rounded border bg-gray-50 p-3 text-sm">
                    <div className="font-medium text-gray-900 mb-1">Snapshot</div>
                    <div className="text-gray-700 space-y-1">
                      <div>
                        <span className="text-gray-500">Days since last invoice:</span>{" "}
                        <span className="tabular-nums">
                          {callPrepData.stats.daysSinceLastInvoice ?? "—"}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Avg reorder (last 5):</span>{" "}
                        <span className="tabular-nums">
                          {callPrepData.stats.avgDaysBetweenLast5 ?? "—"} days
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Last invoice date:</span>{" "}
                        <span className="tabular-nums">
                          {callPrepData.stats.lastInvoice?.invoiceDate
                            ? new Date(callPrepData.stats.lastInvoice.invoiceDate).toLocaleDateString()
                            : "—"}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Credit hold:</span>{" "}
                        <span>{callPrepData.customer.creditHoldBool ? "YES" : "No"}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="font-medium text-sm mb-2">Top items (last 365 days) — qty</div>
                    {callPrepData.itemIntel.topItemsLast365?.length ? (
                      <ul className="space-y-1">
                        {callPrepData.itemIntel.topItemsLast365.map((it) => (
                          <li
                            key={it.itemCode}
                            className="flex items-baseline justify-between gap-3 text-sm"
                          >
                            <span className="min-w-0">
                              <span className="font-mono">{it.itemCode}</span>
                              {it.itemCodeDesc ? (
                                <span className="ml-2 text-gray-600 truncate">— {it.itemCodeDesc}</span>
                              ) : null}
                            </span>
                            <span className="tabular-nums text-gray-700">{it.qty}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-gray-500">No items found.</div>
                    )}
                  </div>

                  <div>
                    <div className="font-medium text-sm mb-2">
                      Stopped buying (hasn't ordered in 90 days)
                    </div>
                    {callPrepData.itemIntel.stoppedBuying?.length ? (
                      <ul className="space-y-1">
                        {callPrepData.itemIntel.stoppedBuying.map((it) => (
                          <li
                            key={it.itemCode}
                            className="flex items-baseline justify-between gap-3 text-sm"
                          >
                            <span className="min-w-0">
                              <span className="font-mono">{it.itemCode}</span>
                              {it.itemCodeDesc ? (
                                <span className="ml-2 text-gray-600 truncate">— {it.itemCodeDesc}</span>
                              ) : null}
                            </span>
                            <span className="tabular-nums text-gray-700">{it.qty}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-gray-500">None detected.</div>
                    )}
                  </div>

                  {/* Pitch Next hidden */}
                  {false ? (
                    <div>
                      <div className="font-medium text-sm mb-2">Pitch Next</div>
                      {callPrepData?.itemIntel?.pitchNext?.length ? (
                        <ul className="space-y-1">
                          {callPrepData?.itemIntel?.pitchNext?.map((it: any) => (
                            <li
                              key={`pitch-${it.itemCode}-${it.reason}`}
                              className="flex items-baseline justify-between gap-3 text-sm"
                            >
                              <span className="min-w-0">
                                <span className="font-mono">{it.itemCode}</span>
                                {it.itemCodeDesc ? (
                                  <span className="ml-2 text-gray-600 truncate">— {it.itemCodeDesc}</span>
                                ) : null}
                                <div className="text-[11px] text-blue-600">{it.reason}</div>
                              </span>
                              <span className="tabular-nums text-gray-700">{it.qty}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-gray-500">No pitch suggestions.</div>
                      )}
                    </div>
                  ) : null}

                  <div className="text-xs text-gray-500">
                    Scanned {callPrepData.itemIntel.invoicesScannedForItems} invoices •{" "}
                    {callPrepData.itemIntel.last90UniqueItemCount} unique items in last 90 days
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-500">Select a customer.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Notes Drawer */}
      {notesOpen ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label="Close notes"
            onClick={closeNotes}
          />
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl border-l flex flex-col">
            <div className="p-3 border-b flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold leading-5 truncate">
                  Notes{notesFor ? ` • ${notesFor.customerName}` : ""}
                </div>
                {notesFor ? (
                  <div className="text-xs text-gray-500 truncate">{notesFor.customerNo}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="px-2 py-1 rounded border bg-white hover:bg-gray-50 text-sm"
                onClick={closeNotes}
              >
                ✕
              </button>
            </div>

            <div className="p-3 border-b space-y-2">
              <div className="text-xs font-semibold text-gray-700">Add Note</div>
              <textarea
                className="w-full border rounded px-2 py-2 text-sm"
                rows={4}
                placeholder="Type a note..."
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
              />
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-gray-600">Follow up date (optional)</div>
                <input
                  type="date"
                  className="border rounded px-2 py-1 text-sm"
                  value={newNoteFollowUp}
                  onChange={(e) => setNewNoteFollowUp(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={addNote}
                  disabled={notesSaving || !newNoteText.trim()}
                  className={`px-3 py-2 rounded text-sm text-white ${
                    notesSaving || !newNoteText.trim()
                      ? "bg-gray-400 cursor-not-allowed"
                      : "bg-gray-900 hover:bg-gray-800"
                  }`}
                >
                  {notesSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            <div className="p-3 overflow-auto space-y-3">
              {notesLoading ? (
                <div className="text-sm text-gray-600">Loading…</div>
              ) : notesError ? (
                <div className="text-sm text-red-700">{notesError}</div>
              ) : notesRows.length === 0 ? (
                <div className="text-sm text-gray-600">No notes yet.</div>
              ) : (
                notesRows.map((n) => {
                  const isEditing = editingNoteId === n.id;
                  const hl = noteHighlightClass(n);
                  const pinned = Boolean((n as any).pinned);

                  return (
                    <div key={n.id} className={`rounded border p-2 ${hl}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[11px] text-gray-500">
                            {fmtTs(n.createdAt)}
                            {n.createdByName ? ` • ${n.createdByName}` : ""}
                            {n.updatedAt ? ` • Updated ${fmtTs(n.updatedAt)}` : ""}
                            {pinned ? <span className="ml-2 text-gray-900">• PINNED</span> : null}
                          </div>
                          {(n as any).followUpDate ? (
                            <div className="text-[11px] text-gray-700 mt-0.5">
                              Follow up:{" "}
                              <span className="font-semibold">
                                {fmtDateOnly((n as any).followUpDate)}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        {!isEditing ? (
                          <div className="flex gap-2 items-center">
                            {/* ⭐ Pin */}
                            <button
  type="button"
  className={`px-2 py-1 rounded border bg-white hover:bg-gray-50 text-xs ${
    pinned ? "text-yellow-500 border-yellow-400" : "text-gray-700 border-gray-300"
  }`}
  onClick={() => togglePinNote(n)}
  title={pinned ? "Unpin note" : "Pin note"}
  disabled={notesSaving}
>
  {pinned ? "★" : "☆"}
</button>

                            <button
                              type="button"
                              className="px-2 py-1 rounded border bg-white hover:bg-gray-50 text-xs"
                              onClick={() => startEditNote(n)}
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              className="px-2 py-1 rounded border bg-white hover:bg-gray-50 text-xs"
                              onClick={() => deleteNote(n.id)}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {!isEditing ? (
                        <div className="mt-2 text-sm whitespace-pre-wrap break-words">{n.text}</div>
                      ) : (
                        <div className="mt-2 space-y-2">
                          <textarea
                            className="w-full border rounded px-2 py-2 text-sm"
                            rows={4}
                            value={editingNoteText}
                            onChange={(e) => setEditingNoteText(e.target.value)}
                          />
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-gray-600">Follow up date (optional)</div>
                            <input
                              type="date"
                              className="border rounded px-2 py-1 text-sm"
                              value={editingNoteFollowUp}
                              onChange={(e) => setEditingNoteFollowUp(e.target.value)}
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="px-3 py-1.5 rounded border bg-white hover:bg-gray-50 text-sm"
                              onClick={cancelEditNote}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className={`px-3 py-1.5 rounded text-sm text-white ${
                                notesSaving || !editingNoteText.trim()
                                  ? "bg-gray-400 cursor-not-allowed"
                                  : "bg-gray-900 hover:bg-gray-800"
                              }`}
                              disabled={notesSaving || !editingNoteText.trim()}
                              onClick={saveEditNote}
                            >
                              {notesSaving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}