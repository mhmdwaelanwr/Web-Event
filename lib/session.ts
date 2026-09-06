import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "event_staff_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

type SessionPayload = {
  exp: number;
  master: boolean;
  remoteKeyHash?: string;
};

function secret(): string {
  const value = process.env.SESSION_SECRET?.trim() || process.env.APP_ACCESS_KEY?.trim();
  if (!value) throw new Error("SESSION_SECRET or APP_ACCESS_KEY must be configured");
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function hashAccessKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createStaffSession(master: boolean, remoteKey?: string): string {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    master,
    remoteKeyHash: master || !remoteKey ? undefined : hashAccessKey(remoteKey)
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyStaffSession(token?: string | null): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !safeEqual(sign(encoded), signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function remoteSessionStillValid(payload: SessionPayload): Promise<boolean> {
  if (payload.master) return true;
  if (!payload.remoteKeyHash) return false;

  const remoteUrl = process.env.REMOTE_CONFIG_URL?.trim();
  if (!remoteUrl?.startsWith("https://")) return false;

  try {
    const response = await fetch(remoteUrl, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) return true;
    const current = (await response.text()).trim();
    if (!current) return true;
    return safeEqual(hashAccessKey(current), payload.remoteKeyHash);
  } catch {
    // Match the Android behavior: an already-authorized station remains usable if the remote key host is temporarily offline.
    return true;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS
};
