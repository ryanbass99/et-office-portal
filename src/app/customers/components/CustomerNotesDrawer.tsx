"use client";

import React, { useEffect, useMemo, useState } from "react";
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

// ✅ Adjust this import to match your project (you’ve used "@/lib/firebase" in the portal)
import { db } from "@/lib/firebase";

type Note = {
  id: string;
  text: string;
  createdAt?: any;
  updatedAt?: any;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;
};

function fmt(ts: any) {
  try {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (!d) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

export default function CustomerNotesDrawer({
  open,
  onClose,
  customerNo,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerNo: string | null;
  customerName?: string;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);

  const [newText, setNewText] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const canShow = open && !!customerNo;

  const notesColRef = useMemo(() => {
    if (!customerNo) return null;
    return collection(db, "customers", customerNo, "notes");
  }, [customerNo]);

  useEffect(() => {
    if (!canShow || !notesColRef) {
      setNotes([]);
      setEditingId(null);
      setEditingText("");
      setNewText("");
      return;
    }

    setLoading(true);

    // ✅ createdAt is set on create, so ordering is safe.
    const q = query(notesColRef, orderBy("createdAt", "desc"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: Note[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setNotes(rows);
        setLoading(false);
      },
      (err) => {
        console.error("Notes snapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [canShow, notesColRef]);

  async function addNote() {
    const text = newText.trim();
    if (!text || !notesColRef || !customerNo) return;

    const auth = getAuth();
    const user = auth.currentUser;

    setSaving(true);
    try {
      await addDoc(notesColRef, {
        text,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByUid: user?.uid || "",
        createdByName: user?.displayName || user?.email || "",
        updatedByUid: user?.uid || "",
      });
      setNewText("");
    } catch (e) {
      console.error("Add note failed:", e);
      alert("Could not save note. Check console.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(n: Note) {
    setEditingId(n.id);
    setEditingText(n.text || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText("");
  }

  async function saveEdit() {
    if (!customerNo || !editingId) return;

    const text = editingText.trim();
    if (!text) return;

    const auth = getAuth();
    const user = auth.currentUser;

    setSaving(true);
    try {
      const ref = doc(db, "customers", customerNo, "notes", editingId);
      await updateDoc(ref, {
        text,
        updatedAt: serverTimestamp(),
        updatedByUid: user?.uid || "",
      });
      cancelEdit();
    } catch (e) {
      console.error("Update note failed:", e);
      alert("Could not update note. Check console.");
    } finally {
      setSaving(false);
    }
  }

  async function removeNote(id: string) {
    if (!customerNo) return;
    if (!confirm("Delete this note?")) return;

    setSaving(true);
    try {
      const ref = doc(db, "customers", customerNo, "notes", id);
      await deleteDoc(ref);
      if (editingId === id) cancelEdit();
    } catch (e) {
      console.error("Delete note failed:", e);
      alert("Could not delete note. Check console.");
    } finally {
      setSaving(false);
    }
  }

  // Drawer hidden when closed
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="absolute right-0 top-0 h-full w-[520px] max-w-[92vw] bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold">Notes</div>
            <div className="text-sm text-gray-600 truncate">
              {customerNo}
              {customerName ? ` — ${customerName}` : ""}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
          >
            Close
          </button>
        </div>

        {/* Add new */}
        <div className="p-4 border-b">
          <div className="text-sm font-medium mb-2">Add note</div>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={4}
            className="w-full border rounded p-2 text-sm"
            placeholder="Type your note..."
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={addNote}
              disabled={saving || !newText.trim()}
              className={`px-4 py-2 rounded text-sm text-white ${
                saving || !newText.trim()
                  ? "bg-gray-400 cursor-not-allowed"
                  : "bg-gray-900 hover:bg-gray-800"
              }`}
            >
              {saving ? "Saving..." : "Save Note"}
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-sm text-gray-600">Loading notes…</div>
          ) : notes.length === 0 ? (
            <div className="text-sm text-gray-600">No notes yet.</div>
          ) : (
            <div className="space-y-3">
              {notes.map((n) => {
                const isEditing = editingId === n.id;
                return (
                  <div key={n.id} className="border rounded p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs text-gray-600">
                        <div>
                          {fmt(n.createdAt)}
                          {n.createdByName ? ` • ${n.createdByName}` : ""}
                        </div>
                        {n.updatedAt ? (
                          <div className="mt-0.5">
                            Updated: {fmt(n.updatedAt)}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex gap-2">
                        {!isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(n)}
                              className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => removeNote(n.id)}
                              className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50"
                            >
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-2">
                      {!isEditing ? (
                        <div className="text-sm whitespace-pre-wrap break-words">
                          {n.text}
                        </div>
                      ) : (
                        <>
                          <textarea
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={4}
                            className="w-full border rounded p-2 text-sm"
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={saveEdit}
                              disabled={saving || !editingText.trim()}
                              className={`px-3 py-1.5 rounded text-sm text-white ${
                                saving || !editingText.trim()
                                  ? "bg-gray-400 cursor-not-allowed"
                                  : "bg-gray-900 hover:bg-gray-800"
                              }`}
                            >
                              {saving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t text-xs text-gray-500">
          Stored at: customers/{customerNo || "…"}/notes
        </div>
      </div>
    </div>
  );
}
