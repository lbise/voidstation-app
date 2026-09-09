import { collectHostMetrics } from "@/lib/host-metrics";
import { linuxHostInput } from "@/lib/linux-host-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return Response.json(await collectHostMetrics(linuxHostInput), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
