#!/usr/bin/env node
// Keep the unauthenticated asset allowlist tied to the actual login build.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const assets = new Set();
const html = readFileSync(".next/server/app/login.html", "utf8");
for (const match of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:\?[^"<]*)?"/g)) {
  assets.add(match[1]);
}
for (const asset of assets) {
  if (!asset.endsWith(".css")) continue;
  const css = readFileSync(join(".next", asset.slice("/_next/".length)), "utf8");
  for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    const url = new URL(match[1], `https://build.invalid${asset}`);
    if (url.pathname.startsWith("/_next/static/")) assets.add(url.pathname);
  }
}
if (![...assets].some((asset) => asset.endsWith(".js"))) throw new Error("Login build has no bootstrap scripts");
writeFileSync(".next/login-assets.json", JSON.stringify([...assets].sort()) + "\n");
