
"use client";

import { useEffect, useMemo, useRef } from "react";
import { getAuth } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

function safeUUID() {
  try {
    return crypto.randomUUID();
  } catch {
    return `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
}

// Cache role per uid so we only read Firestore once per session/user
const roleCache = new Map<string, string | null>();

async function getRoleForUid(uid: string): Promise<string | null> {
  if (roleCache.has(uid)) return roleCache.get(uid) ?? null;

  try {
    const snap = await getDoc(doc(db, "users", uid));
    const role = snap.exists() ? ((snap.data() as any)?.role ?? null) : null;
    roleCache.set(uid, role);
    return role;
  } catch {
    // If role lookup fails, default to tracking (safer than silently disabling)
    roleCache.set(uid, null);
    return null;
  }
}

async function postPing(body: any, beacon = false) {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) return;

  // ✅ Skip tracking for admins
  const role = await getRoleForUid(user.uid);
  if (role === "admin") return;

  const idToken = await user.getIdToken();

  if (beacon && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify({ ...body, idToken })], {
      type: "application/json",
    });
    navigator.sendBeacon("/api/usage/ping", blob);
    return;
  }

  await fetch("/api/usage/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, idToken }),
    keepalive: beacon,
  });
}

/**
 * Active time:
 * - Active only if input happened within last 30s AND tab is visible
 * - Accumulates time in 1s ticks
 * - Flushes every 60s
 */
export default function ActivityTracker() {
  const sessionId = useMemo(() => safeUUID(), []);
  const activeMs = useRef(0);

  const lastInputAt = useRef(Date.now());
  const lastTickAt = useRef(Date.now());
  const isVisible = useRef(true);

  useEffect(() => {
    const path = () => window.location.pathname;

    const markInput = () => {
      lastInputAt.current = Date.now();
    };

    // throttle mousemove to 1/sec
    let mmTimer: any = null;
    const onMouseMove = () => {
      if (mmTimer) return;
      mmTimer = setTimeout(() => {
        mmTimer = null;
        markInput();
      }, 1000);
    };

    const onVisibility = () => {
      isVisible.current = document.visibilityState === "visible";
      if (!isVisible.current) {
        void postPing(
          { kind: "flush", sessionId, path: path(), activeMs: activeMs.current },
          true
        );
      }
    };

    // Start session
    void postPing({ kind: "start", sessionId, path: path(), activeMs: 0 });

    // listeners
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("scroll", markInput, { passive: true });
    window.addEventListener("keydown", markInput, { passive: true });
    window.addEventListener("click", markInput, { passive: true });
    window.addEventListener("pointerdown", markInput, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    const tickTimer = setInterval(() => {
      const now = Date.now();
      const dt = now - lastTickAt.current;
      lastTickAt.current = now;

      const active = isVisible.current && now - lastInputAt.current <= 30_000;
      if (active) activeMs.current += dt;
    }, 1000);

    const flushTimer = setInterval(() => {
      void postPing({
        kind: "flush",
        sessionId,
        path: path(),
        activeMs: activeMs.current,
      });
    }, 60_000);

    const onUnload = () => {
      void postPing(
        { kind: "end", sessionId, path: path(), activeMs: activeMs.current },
        true
      );
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      window.removeEventListener("mousemove", onMouseMove as any);
      window.removeEventListener("scroll", markInput as any);
      window.removeEventListener("keydown", markInput as any);
      window.removeEventListener("click", markInput as any);
      window.removeEventListener("pointerdown", markInput as any);
      document.removeEventListener("visibilitychange", onVisibility as any);
      window.removeEventListener("beforeunload", onUnload as any);
    };
  }, [sessionId]);

  return null;
}
