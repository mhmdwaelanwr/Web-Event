import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, remoteSessionStillValid, verifyStaffSession } from "@/lib/session";

export const runtime = "nodejs";

function normalizeRegistrationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = verifyStaffSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session || !(await remoteSessionStillValid(session))) {
    cookieStore.delete(SESSION_COOKIE);
    return NextResponse.json({ success: false, error: "Staff session expired" }, { status: 401 });
  }

  let body: { registrationId?: unknown; sudo?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  const registrationId = normalizeRegistrationId(body.registrationId);
  if (!registrationId) {
    return NextResponse.json({ success: false, error: "Invalid registration code" }, { status: 400 });
  }

  const sudo = body.sudo === true;
  const target = process.env.ATTENDANCE_API_URL?.trim() || "https://mlsaegypt.org/api/attendance/mark";
  if (!target.startsWith("https://")) {
    return NextResponse.json({ success: false, error: "Attendance API is not configured securely" }, { status: 500 });
  }

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ registrationId, sudo }),
      cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });

    const raw = await upstream.text();
    return new Response(raw || JSON.stringify({ success: upstream.ok }), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Couldn't reach the check-in service. Check your connection and try again." },
      { status: 502 }
    );
  }
}
