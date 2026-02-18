import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function json(status: number, body: any) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ✅ Do NOT crash module load if env is missing
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || "";

// Firebase Admin init (server-side) — wrapped so it can't throw HTML pages
function ensureAdmin() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n"
  );

  if (!projectId || !clientEmail || !privateKey) {
    const missing = [
      !projectId ? "FIREBASE_PROJECT_ID" : null,
      !clientEmail ? "FIREBASE_CLIENT_EMAIL" : null,
      !privateKey ? "FIREBASE_PRIVATE_KEY" : null,
    ].filter(Boolean);
    throw new Error(`Missing Firebase Admin env vars: ${missing.join(", ")}`);
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function csvEscape(v: any) {
  const s = String(v ?? "");
  if (
    s.includes('"') ||
    s.includes(",") ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(values: any[]) {
  return values.map(csvEscape).join(",");
}

function requireSmtpConfig() {
  const missing = [
    !SMTP_HOST ? "SMTP_HOST" : null,
    !SMTP_PORT ? "SMTP_PORT" : null,
    !SMTP_USER ? "SMTP_USER" : null,
    !SMTP_PASS ? "SMTP_PASS" : null,
    !SMTP_FROM_EMAIL ? "SMTP_FROM_EMAIL" : null,
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Missing SMTP env vars: ${missing.join(", ")}`);
  }
}

export async function POST(req: Request) {
  try {
    // ✅ Validate SMTP config first
    requireSmtpConfig();

    // ✅ Ensure Firebase Admin is initialized
    ensureAdmin();

    const adminAuth = getAuth();
    const adminDb = getFirestore();

    let payload: any = null;
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON" });
    }

    const { idToken, customerNos } = payload || {};
    if (!idToken || !Array.isArray(customerNos)) {
      return json(400, { error: "Missing idToken or customerNos" });
    }

    // ✅ Verify user
    const decoded = await adminAuth.verifyIdToken(String(idToken));
    const toEmail = decoded.email;
    if (!toEmail) return json(400, { error: "User email missing" });

    // sanitize list
    const list = customerNos
      .map((x: any) => String(x || "").trim())
      .filter(Boolean);

    if (list.length === 0)
      return json(400, { error: "No customers to export" });

    const MAX = 5000;
    const exportList = list.slice(0, MAX);

    const header = [
      "CustomerNo",
      "CustomerName",
      "Address",
      "City",
      "State",
      "Phone",
      "CurrentBalance",
      "2025Sales",
      "BuyerEmail",
    ];
    const rows: string[] = [toCsvRow(header)];

    // Fetch docs in chunks
    const CHUNK = 400;
    for (let i = 0; i < exportList.length; i += CHUNK) {
      const chunk = exportList.slice(i, i + CHUNK);
      const refs = chunk.map((customerNo: string) =>
        adminDb.collection("customers").doc(customerNo)
      );

      const snaps = await adminDb.getAll(...refs);

      for (const snap of snaps) {
        if (!snap.exists) continue;
        const c: any = snap.data() || {};
        const customerNo = snap.id;

        rows.push(
          toCsvRow([
            customerNo,
            c.customerName ?? "",
            c.address1 ?? "",
            c.city ?? "",
            c.state ?? "",
            c.phone ?? "",
            c.currentBalance ?? "",
            c.udf250TotalSales ?? c.udf250Totalsales ?? "",
            // ✅ ONLY buyer email if present; else blank (match your new rule)
            c.buyerEmail ?? "",
          ])
        );
      }
    }

    const csv = rows.join("\n");
    const filename = `customers_export_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    // ✅ SMTP transport (Office 365 friendly)
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = true, 587 = false
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    // Optional: verify connection early for clearer errors
    await transporter.verify();

    await transporter.sendMail({
      to: toEmail,
      from: `"ET Portal Customer List" <${SMTP_FROM_EMAIL}>`,
      replyTo: toEmail, // replies go to the logged-in rep
      subject: `Customer Export (${rows.length - 1} customers)`,
      text: "Attached is your customer export based on your current filters.",
      attachments: [
        {
          filename,
          content: csv,
          contentType: "text/csv",
        },
      ],
    });

    // ✅ Usage tracking: record export event (keep your existing event log)
    await adminDb.collection("usageEvents").add({
      uid: decoded.uid,
      email: toEmail,
      action: "export_customers",
      requestedCount: list.length,
      exportedCount: rows.length - 1,
      cappedAtMax: list.length > MAX,
      createdAt: FieldValue.serverTimestamp(),
    });

    // ✅ ALSO write to usageSessions so Admin Usage dashboard counts exports per rep
    // (dashboard currently counts exports where usageSessions.lastKind === "export")
    const userSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const u: any = userSnap.exists ? userSnap.data() : {};

    await adminDb.collection("usageSessions").add({
      uid: decoded.uid,
      name: u?.name ?? decoded.name ?? null,
      salesmanId: u?.salesperson ?? u?.salesmanId ?? u?.salesmanID ?? u?.repId ?? null,
      path: "/customers", // this is the export route context
      lastKind: "export",
      activeMs: 0,
      startedAt: FieldValue.serverTimestamp(),
      endedAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
    });

    return json(200, { ok: true, sentTo: toEmail, count: rows.length - 1 });
  } catch (e: any) {
    console.error("export-customers error:", e);
    return json(500, { error: e?.message ?? String(e) });
  }
}
