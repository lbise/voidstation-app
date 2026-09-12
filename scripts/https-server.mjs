#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import process from "node:process";
import next from "next";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function port(value) {
  if (!/^\d+$/.test(value)) throw new Error("PORT must be a TCP port from 1 through 65535.");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error("PORT must be a TCP port from 1 through 65535.");
  return parsed;
}

function validateOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("VOIDSTATION_ORIGIN must be an HTTPS origin.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("VOIDSTATION_ORIGIN must be an HTTPS origin without a path, query, fragment, or credentials.");
  }
}

async function main() {
  validateOrigin(required("VOIDSTATION_ORIGIN"));
  const hostname = process.env.HOSTNAME || "127.0.0.1";
  const listenPort = port(process.env.PORT || "3000");
  const certificate = readFileSync(required("VOIDSTATION_TLS_CERT"));
  const privateKey = readFileSync(required("VOIDSTATION_TLS_KEY"));

  const application = next({ dev: false, hostname, port: listenPort });
  await application.prepare();
  const handle = application.getRequestHandler();
  const expectedHost = new URL(process.env.VOIDSTATION_ORIGIN).host;
  const server = createServer({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" }, (request, response) => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
      response.end("Unrecognized host.");
      return;
    }
    // TLS terminates here. No proxy or client-supplied identity is trusted.
    for (const header of Object.keys(request.headers)) {
      if (header === "forwarded" || header.startsWith("x-forwarded-") || header.startsWith("tailscale-")) {
        delete request.headers[header];
      }
    }
    handle(request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  // Do not turn malformed plaintext HTTP into an HTTP error response. This
  // listener speaks TLS only, including when reached by the container IP.
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.listen(listenPort, hostname, () => {
    console.log(`Voidstation HTTPS listening on ${hostname}:${listenPort}`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`Voidstation HTTPS server failed: ${error.message}`);
  process.exitCode = 1;
});
