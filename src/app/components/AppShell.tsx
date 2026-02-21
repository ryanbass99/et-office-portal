"use client";

import { useEffect, useState } from "react";
import UserBadge from "./UserBadge";
import SignOutButton from "./SignOutButton";
import AdminNavLink from "./AdminNavLink";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");

    const update = () => {
      setIsDesktop(mq.matches);
      if (mq.matches) setOpen(false);
    };

    update();

    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);

    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!isDesktop && open) document.body.classList.add("overflow-hidden");
    else document.body.classList.remove("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, [open, isDesktop]);

  const navLink = "block rounded px-3 py-2 hover:bg-gray-800";

  return (
    <div className="min-h-dvh bg-white text-gray-900 opacity-100">
      {/* Header */}
      <header className="sticky top-0 z-[60] h-16 bg-white border-b flex items-center justify-between px-4 md:px-6 text-gray-900">
        <div className="flex items-center gap-3 min-w-0">
          {!isDesktop ? (
            <button
              type="button"
              className="rounded border px-3 py-2 text-gray-900"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              ☰
            </button>
          ) : null}

          <div className="font-semibold truncate text-gray-900">
            ET Products Internal Portal
          </div>
        </div>

        <div className="flex items-center gap-3 text-gray-900">
          <UserBadge />
          <SignOutButton />
        </div>
      </header>

      <div className="flex md:min-h-[calc(100dvh-4rem)] bg-white text-gray-900 opacity-100">
        {/* Desktop sidebar */}
        {isDesktop ? (
          <aside className="w-64 bg-gray-900 text-white p-6 overflow-y-auto">
            <h2 className="text-2xl font-bold mb-8">ET Products</h2>
            <nav className="space-y-2">
              <a className={navLink} href="/">
                Dashboard
              </a>
              <a className={navLink} href="/sales-sheets">
                Sales Sheets
              </a>
              <a className={navLink} href="/customers">
                Customers
              </a>
              <a className={navLink} href="/SalesOrders">
                Open Sales Orders
              </a>
              <a className={navLink} href="/salesLeads">
                Sales Leads
              </a>
              <a className={navLink} href="/sales-tools">
                Sales Tools
              </a>
              <AdminNavLink />
            </nav>
          </aside>
        ) : null}

        {/* Mobile drawer */}
        {!isDesktop && open ? (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50"
              onClick={() => setOpen(false)}
            />

            <aside className="fixed top-0 left-0 z-50 h-dvh w-64 bg-gray-900 text-white p-6 overflow-y-auto">
              <div className="flex items-start justify-between">
                <h2 className="text-2xl font-bold mb-8">ET Products</h2>
                <button
                  type="button"
                  className="-mt-1 -mr-1 rounded px-3 py-2 hover:bg-gray-800"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                >
                  ✕
                </button>
              </div>

              <nav className="space-y-2">
                <a className={navLink} href="/" onClick={() => setOpen(false)}>
                  Dashboard
                </a>
                <a
                  className={navLink}
                  href="/sales-sheets"
                  onClick={() => setOpen(false)}
                >
                  Sales Sheets
                </a>
                <a
                  className={navLink}
                  href="/customers"
                  onClick={() => setOpen(false)}
                >
                  Customers
                </a>
                <a
                  className={navLink}
                  href="/SalesOrders"
                  onClick={() => setOpen(false)}
                >
                  Open Sales Orders
                </a>
                <a
                  className={navLink}
                  href="/salesLeads"
                  onClick={() => setOpen(false)}
                >
                  Sales Leads
                </a>
                <a
                  className={navLink}
                  href="/sales-tools"
                  onClick={() => setOpen(false)}
                >
                  Sales Tools
                </a>

                <div onClick={() => setOpen(false)}>
                  <AdminNavLink />
                </div>
              </nav>
            </aside>
          </>
        ) : null}

        {/* Main content */}
        <main className="flex-1 min-w-0 p-4 md:p-10 overflow-y-auto bg-white text-gray-900 opacity-100">
          {children}
        </main>
      </div>
    </div>
  );
}