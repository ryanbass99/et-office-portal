"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export default function AdminNavLink() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!cancelled) setIsAdmin(false);
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const role = snap.exists() ? (snap.data() as any).role : null;
        if (!cancelled) setIsAdmin(role === "admin");
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!isAdmin) return null;

  return (
    <a className="block rounded px-3 py-2 hover:bg-gray-800" href="/admin">
      Admin
    </a>
  );
}
