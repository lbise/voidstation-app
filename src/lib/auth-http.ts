import { NextResponse, type NextRequest } from "next/server";

import { isValidSession } from "@/lib/auth-store";

export const SESSION_COOKIE = "__Host-voidstation-session";
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
};

export function applicationOrigin(): URL {
  const value = process.env.VOIDSTATION_ORIGIN;
  if (!value) throw new Error("VOIDSTATION_ORIGIN is required");
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.origin !== value || origin.username || origin.password) {
    throw new Error("VOIDSTATION_ORIGIN must be an exact HTTPS origin");
  }
  return origin;
}

export function hasSession(request: NextRequest): boolean {
  return isValidSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export function hasValidOrigin(request: NextRequest): boolean {
  return request.headers.get("origin") === applicationOrigin().origin &&
    !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

export function authError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function secureResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Strict-Transport-Security", "max-age=31536000");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  return response;
}
