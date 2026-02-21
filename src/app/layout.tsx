import AuthGate from "./components/AuthGate";
import ActivityTracker from "./components/ActivityTracker";
import AppShell from "./components/AppShell";
import "./globals.css";
import type { Metadata } from "next";

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
      <body className="bg-white text-gray-900">
        <AuthGate>
          <ActivityTracker />
          <AppShell>{children}</AppShell>
        </AuthGate>
      </body>
    </html>
  );
}