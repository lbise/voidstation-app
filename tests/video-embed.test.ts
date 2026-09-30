import { expect, it } from "vitest";
import { messageVideos, verifiedVideoKeys, videoEmbed } from "../src/lib/video-embed";
import type { ToolCallRecord } from "../src/lib/assistant-contract";

it.each([
  ["https://www.youtube.com/watch?v=abcDEF12345", "youtube:abcDEF12345"],
  ["https://m.youtube.com/watch?v=abcDEF12345&t=1m30s", "youtube:abcDEF12345"],
  ["https://youtu.be/abcDEF12345?si=share", "youtube:abcDEF12345"],
  ["https://www.youtube.com/shorts/abcDEF12345", "youtube:abcDEF12345"],
  ["https://www.youtube-nocookie.com/embed/abcDEF12345", "youtube:abcDEF12345"],
  ["https://vimeo.com/76979871", "vimeo:76979871"],
  ["https://player.vimeo.com/video/76979871", "vimeo:76979871"],
])("recognizes %s", (url, key) => {
  expect(videoEmbed(url)?.key).toBe(key);
});

it.each([
  "https://www.youtube.com/watch?v=short",
  "https://www.youtube.com/channel/UC123",
  "https://evil.example/watch?v=abcDEF12345",
  "https://youtube.com.evil.example/watch?v=abcDEF12345",
  "javascript:alert(1)",
  "not a url",
])("ignores %s", (url) => {
  expect(videoEmbed(url)).toBeUndefined();
});

it("builds privacy-enhanced embed URLs and keeps start times", () => {
  expect(videoEmbed("https://youtu.be/abcDEF12345?t=90")).toMatchObject({
    embedUrl: "https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0&start=90",
    watchUrl: "https://www.youtube.com/watch?v=abcDEF12345",
  });
  expect(videoEmbed("https://www.youtube.com/watch?v=abcDEF12345&t=1m30s")?.start).toBe(90);
  expect(videoEmbed("https://vimeo.com/76979871")?.embedUrl).toBe("https://player.vimeo.com/video/76979871?dnt=1");
});

it("verifies videos from successful web results only and matches other URL forms of the same video", () => {
  const calls: ToolCallRecord[] = [
    { id: "1", turnId: "t", name: "web_search", parameters: {}, status: "complete", result: { kind: "webSearch", query: "q", category: "videos", results: [{ title: "A", url: "https://www.youtube.com/watch?v=abcDEF12345" }] } },
    { id: "2", turnId: "t", name: "web_fetch", parameters: {}, status: "complete", result: { kind: "webPage", url: "https://example.com", characters: 1, truncated: false, videos: ["https://vimeo.com/76979871"] } },
    { id: "3", turnId: "t", name: "web_search", parameters: {}, status: "error", result: { kind: "webSearch", query: "q", category: "videos", results: [{ title: "B", url: "https://youtu.be/zzzzzzzzzzz" }] } },
    { id: "4", turnId: "t", name: "media_find", parameters: {}, status: "complete", result: { kind: "find", choices: [], library: [] } },
  ];
  const verified = verifiedVideoKeys(calls);
  expect([...verified].sort()).toEqual(["vimeo:76979871", "youtube:abcDEF12345"]);
  const text = "Trailer: https://youtu.be/abcDEF12345. Also [clip](https://vimeo.com/76979871), [guess](https://youtu.be/zzzzzzzzzzz), and https://www.youtube.com/watch?v=abcDEF12345 again.";
  expect(messageVideos(text, verified).map((video) => video.key)).toEqual(["youtube:abcDEF12345", "vimeo:76979871"]);
});
