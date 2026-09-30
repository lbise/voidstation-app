# Assistant web access without an approval gate

The Assistant can search the web through a self-hosted SearXNG and read full public pages. This gives the worker general outbound internet access, and text from untrusted pages now reaches the same model that can call `media_configure` and `media_search`.

We decided not to require approval for media tools after a web lookup. The worst realistic outcome of a prompt injection is unwanted library changes or download searches. The worker has no shell and no filesystem tools, so the damage stays small, and the owner preferred fewer clicks. We reduce the risk instead: web content is labeled untrusted to the model, the system prompt forbids media actions the owner did not request, and `web_fetch` refuses private and internal addresses.

A page could still ask the model to fetch a URL carrying conversation data, which would leak it. We accept this for now. If it matters later, restrict `web_fetch` to URLs that appeared in the owner's messages or in earlier web results, or add Action approval for media tools.

SearXNG is behind a `SearchProvider` interface, so a paid API (Brave, Tavily) can replace it by adding one implementation and changing `VOIDSTATION_SEARCH_PROVIDER`.
