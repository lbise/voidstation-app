import { NextResponse, type NextRequest } from "next/server";

import { authenticateOwner, SESSION_MAX_AGE_SECONDS } from "@/lib/auth-store";
import { authError, hasValidOrigin, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, secureResponse } from "@/lib/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    if (!hasValidOrigin(request)) return secureResponse(authError("Request origin rejected.", 403));
    if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
      return secureResponse(authError("Use a URL-encoded login form.", 415));
    }
    // Bound streamed input too; Content-Length is not supplied by every client.
    const reader = request.body?.getReader();
    if (!reader) return secureResponse(authError("Password required.", 400));
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return secureResponse(authError("Login form is too large.", 413));
      }
      chunks.push(value);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const passwords = form.getAll("password");
    if (passwords.length !== 1) return secureResponse(authError("Password required.", 400));
    const result = await authenticateOwner(passwords[0]);
    if (result.status === "limited") {
      const response = authError("Too many sign-in attempts. Try again later.", 429);
      response.headers.set("Retry-After", String(result.retryAfter));
      return secureResponse(response);
    }
    if (result.status === "invalid") return secureResponse(authError("Incorrect password.", 401));
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, result.token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return secureResponse(response);
  } catch {
    return secureResponse(authError("Sign-in is unavailable. Try again later.", 503));
  }
}
