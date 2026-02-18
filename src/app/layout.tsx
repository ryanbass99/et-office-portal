import UserBadge from "./components/UserBadge";
import SignOutButton from "./components/SignOutButton";
import AuthGate from "./components/AuthGate";
import ActivityTracker from "./components/ActivityTracker";
import "./globals.css";
import type { Metadata } from "next";
import AdminNavLink from "./components/AdminNavLink";

export const metadata: Metadata = {
  title: "ET Office Portal",
  description: "Internal Office System",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-100">
        <AuthGate>
          <ActivityTracker />

          <div className="flex h-screen">
            {/* Sidebar */}
            <aside className="w-64 bg-gray-900 text-white p-6 overflow-y-auto">
              <h2 className="text-2xl font-bold mb-8">ET Products</h2>

              <nav className="space-y-2">
                <a className="block rounded px-3 py-2 hover:bg-gray-800" href="/">
                  Dashboard
                </a>

                <a
                  className="block rounded px-3 py-2 hover:bg-gray-800"
                  href="/sales-sheets"
                >
                  Sales Sheets
                </a>

                <a
                  className="block rounded px-3 py-2 hover:bg-gray-800"
                  href="/customers"
                >
                  Customers
                </a>

                {/* Hidden for now */}
                {false && (
                  <a
                    className="block rounded px-3 py-2 hover:bg-gray-800"
                    href="/messages"
                  >
                    Messages
                  </a>
                )}

                <a
                  className="block rounded px-3 py-2 hover:bg-gray-800"
                  href="/SalesOrders"
                >
                  Open Sales Orders
                </a>

                <a
                  className="block rounded px-3 py-2 hover:bg-gray-800"
                  href="/salesLeads"
                >
                  Sales Leads
                </a>

                <a
                  className="block rounded px-3 py-2 hover:bg-gray-800"
                  href="/sales-tools"
                >
                  Sales Tools
                </a>

                {/* Admin directly under Sales Tools */}
                <AdminNavLink />
              </nav>
            </aside>

            {/* Main Content */}
            <div className="flex-1 flex flex-col">
              {/* Top Header */}
              <header className="h-16 bg-white border-b flex items-center justify-between px-10">
                <div className="font-semibold">ET Produts Internal Portal</div>
                <div className="flex items-center gap-4">
                  <UserBadge />
                  <SignOutButton />
                </div>
              </header>

              {/* Page Content */}
              <main className="flex-1 p-10 overflow-y-auto">{children}</main>
            </div>
          </div>
        </AuthGate>
      </body>
    </html>
  );
}
