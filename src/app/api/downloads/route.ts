import type { NextRequest } from "next/server";
import { authError, hasSession } from "@/lib/auth-http";
import { fetchDownloadQueue } from "@/lib/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" };

export async function GET(request: NextRequest) {
  try {
    if (!hasSession(request)) return authError("Sign in required.", 401);
  } catch {
    return authError("Authentication is unavailable.", 503);
  }
  try {
    return Response.json(await fetchDownloadQueue(request.signal), { headers });
  } catch {
    return Response.json({ error: "Download queue unavailable." }, { status: 503, headers });
  }
}
