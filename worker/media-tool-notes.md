# Media tool contract

`createMediaTools(onResult)` exports four Pi custom tools. Every result is sanitized, sent to `onResult`, and returned to Pi as JSON text. The tools share movie and series inputs. The worker routes movies to Radarr and series to Sonarr.

| Tool | Exact input | Purpose |
|---|---|---|
| `media_find` | `{ type, query?, missing? }` | Resolve an external title or browse the managed library. |
| `media_details` | `{ type, externalId, season? }` | Report tracking, monitoring, downloads, availability, and series episodes. |
| `media_configure` | `{ type, externalId, quality?, monitoring?, seasons? }` | Add a resolved title or update monitoring and quality. Series requests must declare `all`, `future`, `none`, or named `seasons`. It never starts a search. |
| `media_search` | `{ type, externalId, monitoring?, seasons? }` | Start a scoped Radarr or Sonarr search. Series searches must declare `all`, `future`, or named `seasons`; an accepted command is not evidence that a download started. |

`media_find` never silently chooses between lookup candidates. The Assistant must present the title, year, type, and external ID and ask the owner which result they mean. `media_configure` accepts only configured quality names and monitoring modes, and series configuration cannot omit monitoring scope. `media_search` accepts only a resolved, managed title. Movies reject season arguments. Series searches use `SeriesSearch` only for explicit `all`; future and named-season searches resolve bounded Sonarr episode IDs and use `EpisodeSearch`.

The executor reads `VOIDSTATION_MEDIA_CONFIG_FILE`. Each service includes `endpoint`, `keyFile`, `rootFolder`, `defaultQualityProfileId`, and `qualityMappings`. A Sonarr service may also include `languageProfileId`, which is required to add a new series. The selected service API key is read from its key file and injected only into that Python child environment. It is never passed in argv, included in a result, or logged.

The Python boundary exposes fixed commands only. It never accepts a URL, request path, arbitrary payload, HTTP method, or argument tail. Service responses are reduced to bounded, safe JSON. Process execution uses `spawn` without a shell, a minimal child environment, bounded output, a timeout, and abort-triggered process-tree termination.
