import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? null,
    FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
  });
}
