import type { NextRequest } from "next/server";
import { authError, hasSession } from "@/lib/auth-http";
import { collectHostMetrics } from "@/lib/host-metrics";
import { linuxHostInput } from "@/lib/linux-host-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    if (!hasSession(request)) return authError("Sign in required.", 401);
  } catch {
    return authError("Authentication is unavailable.", 503);
  }
  return Response.json(await collectHostMetrics(linuxHostInput), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
