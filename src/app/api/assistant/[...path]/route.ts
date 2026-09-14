import type { NextRequest } from "next/server";
import { assistantRequest } from "@/lib/assistant-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return assistantRequest(request, (await context.params).path);
}

export { handle as GET, handle as POST, handle as DELETE };
