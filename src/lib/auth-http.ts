import { NextResponse, type NextRequest } from "next/server";

import { isValidSession } from "@/lib/auth-store";

export const SESSION_COOKIE = "__Host-voidstation-session";
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
};

function exactHttpsOrigin(name: "VOIDSTATION_ORIGIN" | "VOIDSTATION_LAN_ORIGIN", required: boolean): URL | undefined {
  const value = process.env[name];
  if (!value) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  if (origin.protocol !== "https:" || origin.origin !== value || origin.username || origin.password) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return origin;
}

export function applicationOrigins(): URL[] {
  const primary = exactHttpsOrigin("VOIDSTATION_ORIGIN", true)!;
  const lan = exactHttpsOrigin("VOIDSTATION_LAN_ORIGIN", false);
  if (lan && lan.host === primary.host) throw new Error("VOIDSTATION_LAN_ORIGIN must use a different host");
  return lan ? [primary, lan] : [primary];
}

export function applicationOrigin(request: NextRequest): URL | undefined {
  const host = request.headers.get("host");
  return applicationOrigins().find((configured) => configured.host === host);
}

export function hasSession(request: NextRequest): boolean {
  return isValidSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export function hasValidOrigin(request: NextRequest): boolean {
  const origin = applicationOrigin(request);
  return origin !== undefined && request.headers.get("origin") === origin.origin &&
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
