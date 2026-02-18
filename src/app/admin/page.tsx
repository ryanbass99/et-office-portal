import Link from "next/link";

export default function AdminPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="bg-white shadow rounded p-4">
        <div className="text-sm text-gray-600 mb-3">Admin Tools</div>

        <div className="flex flex-col gap-2">
          <Link
            href="/admin/usage"
            className="inline-flex items-center justify-between rounded border px-4 py-3 hover:bg-gray-50"
          >
            <span className="font-medium">Usage Dashboard</span>
            <span className="text-gray-500">→</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
