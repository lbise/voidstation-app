# Web tool contract

`createWebTools()` exports two Pi custom tools. The model gets the full result as text. The conversation stores a small summary in `details.result`, which the UI shows in the tool activity.

| Tool | Input | Purpose |
|---|---|---|
| `web_search` | `{ query, category?, timeRange? }` | Search the public web. `category` is `general` (default), `videos`, or `news`. `timeRange` is `day`, `week`, `month`, or `year`. Returns up to 10 results with title, URL, snippet, source engine, date, and thumbnail. |
| `web_fetch` | `{ url }` | Read one public page. Returns the main text (Readability, capped at 24,000 characters), up to 40 links, and YouTube or Vimeo links found in the page. |

## Search backend

`VOIDSTATION_SEARCH_PROVIDER` selects the backend. The only value today is `searxng`, which reads `VOIDSTATION_SEARXNG_URL` and calls `/search?format=json`. The instance must have the JSON format enabled. To add another backend, implement `SearchProvider` in `src/web-search.ts` and add a case to `searchProviderFromEnv`. The tools and UI do not change.

The backend URL is trusted configuration and may point at an internal host. It is read on every call, so a missing or bad value becomes a `configuration` tool error, not a startup failure.

## Page fetch guard

The worker shares a network with Radarr, Sonarr, the dashboard, and SearXNG, and the host LAN is reachable from it. `web_fetch` therefore:

- accepts only `http` and `https` URLs without credentials, on ports 80, 443, 8080, or 8443;
- refuses `localhost`, `*.local`, `*.internal`, and single-label names such as `searxng`;
- resolves DNS itself and refuses the request if any answer is not a public unicast address (private, loopback, link-local, CGNAT including Tailscale, multicast, documentation, IPv4-mapped private, ULA). The connection uses the checked address, so DNS rebinding cannot swap it;
- follows at most 5 redirects and checks every hop the same way;
- stops after 20 seconds or 3 MiB of decoded body, and reads only HTML and text types.

## Untrusted content

Every result the model sees starts with a notice that the content is untrusted and cannot give instructions. The system prompt repeats this and forbids media changes the owner did not ask for. There is no approval gate on media tools; see `docs/adr/0001-assistant-web-access.md`.

## Video embeds

The UI embeds YouTube (through `youtube-nocookie.com`) and Vimeo links from an Assistant reply only if the same video appeared in a successful `web_search` or `web_fetch` result in that conversation. A link the model invented stays a plain link.
