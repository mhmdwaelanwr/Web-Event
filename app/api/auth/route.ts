import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createStaffSession,
  safeEqual,
  sessionCookieOptions
} from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let key = "";
  try {
    const body = (await request.json()) as { key?: unknown };
    key = typeof body.key === "string" ? body.key.trim() : "";
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  if (!key) {
    return NextResponse.json({ success: false, error: "Access key is required" }, { status: 400 });
  }

  const masterKey = process.env.APP_ACCESS_KEY?.trim() || "";
  let authorized = false;
  let isMaster = false;

  if (masterKey && safeEqual(key, masterKey)) {
    authorized = true;
    isMaster = true;
  } else {
    const remoteUrl = process.env.REMOTE_CONFIG_URL?.trim();
    if (remoteUrl?.startsWith("https://")) {
      try {
        const remoteResponse = await fetch(remoteUrl, {
          cache: "no-store",
          signal: AbortSignal.timeout(6000)
        });
        if (remoteResponse.ok) {
          const remoteKey = (await remoteResponse.text()).trim();
          if (remoteKey && safeEqual(key, remoteKey)) authorized = true;
        }
      } catch {
        // First-time remote-key authentication fails closed, matching the Android app.
      }
    }
  }

  if (!authorized) {
    return NextResponse.json(
      { success: false, error: "Incorrect access key. Please try again." },
      { status: 401 }
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, createStaffSession(isMaster, isMaster ? undefined : key), sessionCookieOptions);
  return NextResponse.json({ success: true });
}
