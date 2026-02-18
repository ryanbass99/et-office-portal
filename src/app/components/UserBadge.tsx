"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export default function UserBadge() {
  const [label, setLabel] = useState<string>("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setLabel("");
        return;
      }

     let role = "user";
let name = "";

try {
  const snap = await getDoc(doc(db, "users", user.uid));
  role = (snap.data()?.role as string) || "user";
  name = (snap.data()?.name as string) || "";
} catch {
  // ignore (rules/network)
}

const displayName =
  (name && name.trim().length > 0 ? name.trim() : null) ??
  user.displayName ??
  user.email ??
  "Signed in";
setLabel(displayName);

    });

    return () => unsub();
  }, []);

  if (!label) return null;

  return <div className="text-sm text-gray-600">{label}</div>;
}
