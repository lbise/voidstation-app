import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { NextRequest } from "next/server";

import { authError, hasSession, hasValidOrigin } from "@/lib/auth-http";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const unavailable = () => authError("The Assistant worker is unavailable. Your saved conversations have not been deleted. Dashboard access is still available.", 503);

function workerConfiguration() {
  const url = new URL(process.env.VOIDSTATION_WORKER_URL ?? "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid worker URL");
  }
  const path = process.env.VOIDSTATION_WORKER_TOKEN_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Missing worker token file");
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error("Invalid worker token");
  return { url, token };
}

async function submission(request: NextRequest, turn: boolean) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = Object.keys(value);
    if (!turn) return fields.length === 0 ? "{}" : null;
    if (fields.length !== 1 || fields[0] !== "text" || !("text" in value) || typeof value.text !== "string" ||
        !value.text.trim() || value.text.length > 8_000) return null;
    return JSON.stringify({ text: value.text });
  } catch { return null; }
}

// Only these application operations can reach the worker. Never forward browser
// cookies, Authorization, query parameters, or arbitrary paths upstream.
export async function assistantRequest(request: NextRequest, segments: string[]) {
  if (!hasSession(request)) return authError("Sign in required.", 401);
  if (!["GET", "HEAD"].includes(request.method) && !hasValidOrigin(request)) return authError("Request origin rejected.", 403);
  const [collection, id, operation] = segments;
  if (collection !== "conversations" || segments.length > 3 ||
      (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      (operation !== undefined && operation !== "turns" && operation !== "events")) {
    return authError("Conversation not found.", 404);
  }
  const streaming = operation === "events";
  const allowed = operation === "turns" ? ["POST"] : streaming ? ["GET"] : id ? ["GET", "DELETE"] : ["GET", "POST"];
  if (!allowed.includes(request.method)) return authError("Method not allowed.", 405);
  let body: string | undefined;
  if (request.method === "POST") {
    const parsed = await submission(request, operation === "turns");
    if (parsed === null) return authError("Send a JSON message containing only text, up to 8,000 characters, or an empty object to create a conversation.", 400);
    body = parsed;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); };
  try {
    const { url, token } = workerConfiguration();
    const response = await fetch(new URL(`/${segments.join("/")}`, url), {
      method: request.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body, signal: controller.signal, cache: "no-store", redirect: "error",
    });
    if (response.status === 503) {
      // Only fixed, public provider explanations cross this boundary. An
      // unexpected worker error must not expose credentials or internal paths.
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      cleanup();
      const safeErrors = [
        "Provider authentication is unavailable. Run worker login.",
        "Provider limits are currently exhausted.",
        "Provider is unavailable. Try again later.",
      ];
      return typeof payload?.error === "string" && safeErrors.includes(payload.error)
        ? authError(payload.error, 503) : unavailable();
    }
    if (response.status === 401 || response.status >= 500) {
      await response.body?.cancel(); cleanup(); return unavailable();
    }
    if (!streaming || !response.ok) {
      const text = response.status === 204 ? null : await response.text();
      cleanup();
      return new Response(text, { status: response.status, headers: { ...headers, "Content-Type": "application/json" } });
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      cleanup(); controller.abort(); return unavailable();
    }
    clearTimeout(timeout);
    const reader = response.body.getReader();
    let ended = false;
    let authTimer: ReturnType<typeof setInterval>;
    let lifetime: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (ended) return;
      ended = true; clearInterval(authTimer); clearTimeout(lifetime); cleanup(); controller.abort();
      void reader.cancel().catch(() => {});
    };
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        // Existing streams must stop disclosing history after logout/recovery.
        authTimer = setInterval(() => {
          try { if (hasSession(request)) return; } catch { /* Fail closed. */ }
          finish();
        }, 1_000);
        lifetime = setTimeout(finish, 5 * 60_000);
        void (async () => {
          try {
            while (!ended) {
              const chunk = await reader.read();
              if (chunk.done || ended) break;
              output.enqueue(chunk.value);
            }
          } catch { /* Reconnect retrieves current saved state, not token replay. */ }
          finally { finish(); try { output.close(); } catch { /* Browser already closed. */ } }
        })();
      },
      cancel() { finish(); },
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
  } catch {
    cleanup(); controller.abort(); return unavailable();
  }
}
