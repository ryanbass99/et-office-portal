"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "@/lib/firebase";

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

export default function CustomerNotesDrawer({
  open,
  customerNo,
  customerName,
  onClose,
}: {
  open: boolean;
  customerNo: string;
  customerName: string;
  onClose: () => void;
}) {
  const auth = getAuth();

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);

  const [newNoteText, setNewNoteText] = useState("");
  const [newNoteFollowUp, setNewNoteFollowUp] = useState("");

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [editingNoteFollowUp, setEditingNoteFollowUp] = useState("");

  useEffect(() => {
    if (!open || !customerNo) {
      setNotes([]);
      return;
    }

    setLoading(true);

    const ref = collection(db, "customers", customerNo, "notes");
    const q = query(
      ref,
      orderBy("pinned", "desc"),
      orderBy("updatedAt", "desc"),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(q, (snap) => {
      const rows: Note[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
      setNotes(rows);
      setLoading(false);
    });

    return () => unsub();
  }, [open, customerNo]);

  async function togglePinNote(n: Note) {
    const user = auth.currentUser;
    if (!user) return;

    setNotesSaving(true);
    try {
      const ref = doc(db, "customers", customerNo, "notes", n.id);
      await updateDoc(ref, {
        pinned: !Boolean((n as any).pinned),
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid,
      });
    } finally {
      setNotesSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl border-l flex flex-col">

        <div className="p-3 border-b flex justify-between items-center">
          <div>
            <div className="font-semibold">Notes • {customerName}</div>
            <div className="text-xs text-gray-500">{customerNo}</div>
          </div>
          <button onClick={onClose} className="px-2 py-1 border rounded">✕</button>
        </div>

        <div className="p-3 overflow-auto space-y-3">
          {notes.map((n) => {
            const pinned = Boolean((n as any).pinned);
            const hl = noteHighlightClass(n);

            return (
              <div key={n.id} className={`rounded border p-2 ${hl}`}>
                <div className="flex justify-between items-start">
                  <div className="text-xs text-gray-500">
                    {fmtTs(n.createdAt)}
                    {n.createdByName ? ` • ${n.createdByName}` : ""}
                    {pinned ? ` • PINNED` : ""}
                  </div>

                  {/* ⭐ BIG YELLOW STAR */}
                  <button
                    type="button"
                    onClick={() => togglePinNote(n)}
                    disabled={notesSaving}
                    className={`w-10 h-10 flex items-center justify-center rounded border bg-white hover:bg-yellow-50
                      ${pinned ? "text-yellow-500" : "text-yellow-400"}
                      text-2xl leading-none`}
                  >
                    {pinned ? "★" : "☆"}
                  </button>
                </div>

                <div className="mt-2 text-sm">{n.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}