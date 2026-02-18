import { NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

// Firebase Admin init (server-side)
if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin env vars. Need FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY."
    );
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    storageBucket: "et-office-portal.firebasestorage.app",
  });
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
    const senderEmail = decoded.email || "";
    const senderName = (decoded.name || "").trim();

    if (!senderEmail) {
      return NextResponse.json(
        { error: "Logged-in user has no email on account" },
        { status: 400 }
      );
    }

    const { to, fullPath, name } = await req.json();
    if (!to || !fullPath || !name) {
      return NextResponse.json(
        { error: "Missing required fields: to, fullPath, name" },
        { status: 400 }
      );
    }

    // From MUST be a verified SendGrid sender/domain
    const fromEmail = process.env.SENDGRID_FROM_EMAIL; // set to sales@etproductsinc.com
    if (!fromEmail) {
      return NextResponse.json(
        { error: "Missing env var: SENDGRID_FROM_EMAIL" },
        { status: 500 }
      );
    }

    // Download PDF bytes from Storage
    const bucket = getStorage().bucket();
    const [buf] = await bucket.file(fullPath).download();

    await sgMail.send({
      to,
      from: {
        email: fromEmail,
        name: senderName ? `${senderName} (ET Products)` : "ET Products",
      },
      replyTo: senderEmail, // customer replies go to logged-in rep
      subject: `ET Products Sales Sheet: ${name}`,
      text: `Attached is the requested ET Products sales sheet: ${name}`,
      attachments: [
        {
          content: buf.toString("base64"),
          filename: name,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
