import { NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Sales Sheets - Option A (opens user's default email client)
 *
 * This endpoint returns a *clean* mailto URL.
 * - Keeps your current workflow (opens Outlook / default client)
 * - Makes the link look professional (uses production domain + friendly text)
 * - Does NOT send the email server-side and does NOT attach PDFs
 */

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Firebase Admin init (server-side) — only used to verify caller's ID token
if (!getApps().length) {
  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const clientEmail = mustEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = mustEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function getBaseUrl(req: Request) {
  // ✅ Prefer an explicit production base URL
  const explicit = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  // Fallback to request headers (works on Netlify/Vercel)
  const proto =
    req.headers.get("x-forwarded-proto") ||
    (process.env.NODE_ENV === "production" ? "https" : "http");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";

  // If you're hitting a local dev server via LAN IP, the email will look ugly.
  // Prefer your real portal domain when the host looks like a private IP.
  const hostOnly = host.replace(/:\d+$/, "");
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostOnly);
  const isPrivateIpv4 =
    isIpv4 &&
    (hostOnly.startsWith("10.") ||
      hostOnly.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostOnly));

  if (isPrivateIpv4) {
    return (process.env.PORTAL_PUBLIC_URL || "https://portal.etproductsinc.com").replace(
      /\/$/,
      ""
    );
  }

  return `${proto}://${host}`.replace(/\/$/, "");
}

function base64url(input: string) {
  // URL-safe base64 without padding
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function POST(req: Request) {
  try {
    // Verify logged-in user (Firebase ID token)
    const authHeader = req.headers.get("authorization") || "";
    const m = authHeader.match(/^Bearer (.+)$/);
    if (!m) {
      return NextResponse.json({ error: "Missing auth token" }, { status: 401 });
    }

    const decoded = await getAuth().verifyIdToken(m[1]);
    const senderName = (decoded.name || "").trim();

    const { to, fullPath, name } = await req.json();
    if (!to || !fullPath || !name) {
      return NextResponse.json(
        { error: "Missing required fields: to, fullPath, name" },
        { status: 400 }
      );
    }

    // Use your portal domain (no internal IP)
    const baseUrl = getBaseUrl(req);

    // ✅ Make the URL visually cleaner by base64url-encoding the path
    // NOTE: update your /api/sales-sheets/open route to accept `p=` as well as `path=`.
    const p = base64url(fullPath);
    const viewUrl = `${baseUrl}/api/sales-sheets/open?p=${encodeURIComponent(p)}`;

    const subject = `ET Products Sales Sheet: ${name}`;

    // ✅ Mail clients treat body as plain text; this reads clean + keeps URL on its own line
    const bodyLines = [
      `ET Products sales sheet is ready${senderName ? ` (from ${senderName})` : ""}.`,
      "",
      "View PDF:",
      viewUrl,
      "",
      "If you have any questions, just reply to this email.",
    ];

    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(bodyLines.join("\n"))}`;

    return NextResponse.json({ ok: true, mailto, viewUrl });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
