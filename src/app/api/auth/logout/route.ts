import { NextResponse, type NextRequest } from "next/server";

import { revokeSession } from "@/lib/auth-store";
import { authError, hasSession, hasValidOrigin, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, secureResponse } from "@/lib/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    if (!hasValidOrigin(request)) return secureResponse(authError("Request origin rejected.", 403));
    if (!hasSession(request)) return secureResponse(authError("Sign in required.", 401));
    revokeSession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: 0,
    });
    response.headers.set("Clear-Site-Data", '"cache"');
    return secureResponse(response);
  } catch {
    return secureResponse(authError("Sign-out is unavailable. Try again later.", 503));
  }
}
