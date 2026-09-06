import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, remoteSessionStillValid, verifyStaffSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const session = verifyStaffSession(token);

  if (!session || !(await remoteSessionStillValid(session))) {
    cookieStore.delete(SESSION_COOKIE);
    return NextResponse.json({ authorized: false }, { status: 401 });
  }

  return NextResponse.json({ authorized: true });
}
