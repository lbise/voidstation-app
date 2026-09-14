import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";

import { applicationOrigin, authError, hasSession, hasValidOrigin, secureResponse } from "@/lib/auth-http";

let loginAssets: Set<string> | undefined;
function isLoginAsset(pathname: string): boolean {
  if (process.env.NODE_ENV === "development") {
    // The dev compiler serves login's chunks and HMR without a build manifest.
    return pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/webpack-hmr");
  }
  loginAssets ??= new Set(JSON.parse(readFileSync(join(process.cwd(), ".next/login-assets.json"), "utf8")) as string[]);
  return loginAssets.has(pathname);
}

// Default deny for every page, route handler and public file. New Assistant
// routes inherit this check without having to opt into a route group or wrapper.
export function proxy(request: NextRequest) {
  try {
    const origin = applicationOrigin(request);
    if (!origin) return secureResponse(authError("Unrecognized host.", 421));
    const safe = request.method === "GET" || request.method === "HEAD";
    if (!safe && !hasValidOrigin(request)) {
      return secureResponse(authError("Request origin rejected.", 403));
    }
    const pathname = request.nextUrl.pathname;
    if ((safe && (pathname === "/login" || isLoginAsset(pathname))) ||
        (pathname === "/api/auth/login" && request.method === "POST")) {
      return secureResponse(NextResponse.next());
    }
    if (!hasSession(request)) {
      return secureResponse(pathname.startsWith("/api/") || !safe
        ? authError("Sign in required.", 401)
        : NextResponse.redirect(new URL("/login", origin), 307));
    }
    return secureResponse(NextResponse.next());
  } catch {
    return secureResponse(authError("Authentication is unavailable.", 503));
  }
}

export const config = { matcher: "/:path*" };
