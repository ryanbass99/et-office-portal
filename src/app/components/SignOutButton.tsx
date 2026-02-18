"use client";

import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut(auth)}
      className="text-sm px-3 py-2 rounded border hover:bg-gray-50"
    >
      Sign out
    </button>
  );
}
