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

function port(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a TCP port from 1 through 65535.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error(`${name} must be a TCP port from 1 through 65535.`);
  return parsed;
}

function origin(name, requiredValue) {
  const value = process.env[name];
  if (!value) {
    if (requiredValue) throw new Error(`${name} must be set.`);
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return parsed;
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function listen(server, listenPort, hostname) {
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    server.listen(listenPort, hostname, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

function listener({ certificate, privateKey, expectedHost }) {
  const server = createServer({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" });
  server.on("request", (request, response) => {
    // This is the public TLS boundary. Next may add its own forwarding headers
    // afterwards, so this check must stay here rather than in proxy.ts.
    if (Object.keys(request.headers).some((header) =>
      header === "forwarded" || header.startsWith("x-forwarded-") || header.startsWith("tailscale-"))) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
      response.end("Forwarding headers are not accepted.");
      return;
    }
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
      response.end("Unrecognized host.");
      return;
    }
    server.emit("voidstation-request", request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  // Do not turn malformed plaintext HTTP into an HTTP response. These
  // listeners speak TLS only, including when reached by a container IP.
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  return server;
}

async function main() {
  const primaryOrigin = origin("VOIDSTATION_ORIGIN", true);
  const lanOrigin = origin("VOIDSTATION_LAN_ORIGIN", false);
  const lanSettings = ["VOIDSTATION_LAN_PORT", "VOIDSTATION_LAN_TLS_CERT", "VOIDSTATION_LAN_TLS_KEY"];
  if (!lanOrigin && lanSettings.some((name) => process.env[name])) {
    throw new Error("VOIDSTATION_LAN_ORIGIN is required when LAN TLS settings are configured.");
  }
  if (lanOrigin && lanOrigin.host === primaryOrigin.host) {
    throw new Error("VOIDSTATION_LAN_ORIGIN must use a different host.");
  }

  const hostname = process.env.HOSTNAME || "127.0.0.1";
  const primary = {
    listenPort: port(process.env.PORT || "3000", "PORT"),
    certificate: readFileSync(required("VOIDSTATION_TLS_CERT")),
    privateKey: readFileSync(required("VOIDSTATION_TLS_KEY")),
    expectedHost: primaryOrigin.host,
  };
  const lan = lanOrigin && {
    listenPort: port(process.env.VOIDSTATION_LAN_PORT || "3443", "VOIDSTATION_LAN_PORT"),
    certificate: readFileSync(required("VOIDSTATION_LAN_TLS_CERT")),
    privateKey: readFileSync(required("VOIDSTATION_LAN_TLS_KEY")),
    expectedHost: lanOrigin.host,
  };
  if (lan && lan.listenPort === primary.listenPort) throw new Error("LAN and Tailscale listeners must use different ports.");

  // Read every configuration and certificate before preparing Next or binding
  // either listener. A bad LAN configuration must not leave Tailscale live.
  const application = next({ dev: false, hostname, port: primary.listenPort });
  await application.prepare();
  const handle = application.getRequestHandler();
  const servers = [primary, ...(lan ? [lan] : [])].map((options) => {
    const server = listener(options);
    server.on("voidstation-request", handle);
    return { server, ...options };
  });

  try {
    await Promise.all(servers.map(({ server, listenPort }) => listen(server, listenPort, hostname)));
  } catch (error) {
    await Promise.all(servers.map(({ server }) => close(server)));
    throw error;
  }

  for (const { listenPort, expectedHost } of servers) {
    console.log(`Voidstation HTTPS listening for ${expectedHost} on ${hostname}:${listenPort}`);
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    Promise.all(servers.map(({ server }) => close(server))).finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`Voidstation HTTPS server failed: ${error.message}`);
  process.exitCode = 1;
});
