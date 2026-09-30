// Run against a production build with npm run test:assistant:browser.
// Real layout is required: jsdom cannot detect clipped scroll content.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assistantServer } from "./helpers/assistant-server.ts";

const exec = promisify(execFile);
const session = `assistant-scroll-${process.pid}`;
async function browser(...args: string[]) {
  const { stdout } = await exec("node_modules/.bin/agent-browser", ["--session", session, "--json", ...args]);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, stdout);
  return result.data;
}

const server = await assistantServer();
const reply = Array.from({ length: 25 }, (_, index) =>
  `Paragraph ${index + 1}. This is a long assistant reply about the server and the managed library.`,
).join("\n\n") + "\n\nEND OF REPLY";

async function assertReplyEndVisible() {
  const { result } = await browser("eval", `(async () => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    const end = [...document.querySelectorAll('.assistant-markdown p')].at(-1);
    // Allow content-visibility measurements and scroll animations to settle.
    // Do not write scrollTop: that would hide failures in automatic following.
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame);
    }
    const bounds = end.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    return {
      text: end.textContent,
      top: bounds.top, bottom: bounds.bottom,
      viewportTop: visible.top, viewportBottom: visible.bottom,
      scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    };
  })()`);
  assert.equal(result.text, "END OF REPLY");
  assert.ok(result.top >= result.viewportTop && result.bottom <= result.viewportBottom + 1,
    `The completed reply is clipped at the bottom of the chat: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.scrollHeight - result.clientHeight - result.scrollTop) <= 1,
    `The chat stopped following the reply: ${JSON.stringify(result)}`);
}

try {
  await server.fixture([{ text: reply }]);
  await server.startWorker();
  const cookie = await server.session();
  await browser("--args", `--no-sandbox,--host-resolver-rules=MAP ${server.hostname} 127.0.0.1`,
    "--ignore-https-errors", "open", `${server.origin}/login`);
  // Only synthetic, temporary credentials enter this isolated browser session.
  await browser("eval", `(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({password: ${JSON.stringify(server.password)}}),
    });
    if (!response.ok) throw new Error('Fixture login failed');
  })()`);

  for (const [width, height] of [[1280, 577], [1280, 720], [390, 844]]) {
    await browser("set", "viewport", String(width), String(height));
    const conversation = await (await server.mutate("/api/assistant/conversations", "POST", {}, cookie)).json();
    const path = `/api/assistant/conversations/${conversation.id}`;
    await server.mutate(`${path}/turns`, "POST", { text: "Give me a long reply" }, cookie);
    // Load a saved reply first, then append another through the live UI.
    for (let attempt = 0; ; attempt++) {
      const detail = await (await server.request(path, {}, cookie)).json();
      if (detail.turn?.status === "complete") break;
      assert.ok(attempt < 100, "Fixture turn did not complete");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await browser("open", `${server.origin}/assistant?conversation=${conversation.id}`);
    await browser("wait", "--text", "END OF REPLY");
    await assertReplyEndVisible();
    const streaming = height !== 577;
    await server.fixture([streaming
      ? { chunks: reply.split("\n\n").map((text) => ({ text: `${text}\n\n`, delayMs: 30 })) }
      : { text: reply }]);
    await browser("fill", "#assistant-message", "Another long reply please");
    await browser("press", "Enter");
    await browser("wait", "--fn", `document.querySelectorAll('.assistant-markdown').length === 2 &&
      !document.querySelector('#assistant-message').disabled`);
    await assertReplyEndVisible();
    await browser("reload");
    await browser("wait", "--text", "END OF REPLY");
    await assertReplyEndVisible();
    console.log(`PASS: ${streaming ? "streamed" : "instant"} replies follow to the end at ${width}x${height}, live and after reload`);
  }

  // Production CSS must keep the phone history drawer on-screen after minification.
  for (const width of [390, 320]) {
    await browser("set", "viewport", String(width), "844");
    await browser("find", "role", "button", "click", "--name", "Open conversations");
    await browser("wait", "--fn", `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog && Math.abs(dialog.getBoundingClientRect().left) < 1;
    })()`);
    const { result: drawer } = await browser("eval", `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const box = dialog.getBoundingClientRect();
      return { x: box.left, y: box.top, right: box.right, heading: dialog.querySelector('h2')?.textContent };
    })()`);
    assert.equal(drawer.heading, "Conversations");
    assert.ok(Math.abs(drawer.x) < 1 && Math.abs(drawer.y) < 1 && drawer.right <= width,
      `History is clipped at ${width}px: ${JSON.stringify(drawer)}`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);
    const { result: restored } = await browser("eval", `document.activeElement.getAttribute('aria-label')`);
    assert.equal(restored, "Open conversations");
    const { result: layout } = await browser("eval", `(() => {
      const control = [...document.querySelectorAll('.workspace-tabs button')][0];
      const label = control.querySelector('.workspace-control-label');
      const badge = control.querySelector('[data-slot="badge"]');
      const labelText = document.createRange(); labelText.selectNodeContents(label.firstChild);
      return {
        composer: document.querySelector('.assistant-composer').getBoundingClientRect().height,
        statTarget: document.querySelector('.server-glance').getBoundingClientRect().height,
        labelEnd: labelText.getBoundingClientRect().right,
        badgeStart: badge.getBoundingClientRect().left,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    assert.ok(layout.composer <= 108, `Empty composer is oversized: ${JSON.stringify(layout)}`);
    assert.ok(layout.statTarget >= 44, `Server stats target is too small: ${JSON.stringify(layout)}`);
    assert.ok(layout.badgeStart > layout.labelEnd, `Controls and Soon overlap: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflow, 0);
    console.log(`PASS: history drawer, focus restoration, compact composer and header targets at ${width}px`);
  }
} finally {
  await browser("close").catch(() => {});
  await server.close();
}
