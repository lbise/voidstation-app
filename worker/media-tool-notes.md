# Read-only media tool contract

`createMediaTools(onResult)` exports four Pi custom tools. Every result is sent to `onResult` after sanitization and is also returned to Pi as JSON text. Results use a `kind` discriminator: `skill`, `lookup`, `discovery`, `status`, or `error`. Skill contents are returned to Pi but are not persisted in application history. Failures are explicit structured results. They contain no process output, service URL, API key, file path, or raw service error.

| Tool | Exact input | Result data |
|---|---|---|
| `read_skill` | `{ service: "radarr" | "sonarr", resource: "SKILL.md" | approved relative resource }` | `{ service, resource, content }` |
| `media_lookup` | `{ type: "movie" | "series", query: string }` | `{ choices: Array<{ externalId, title, year, type }> }` |
| `media_discover` | `{ type: "movie" | "series", quality?: string }` | `{ type, rootFolder, qualityProfileId, quality? }` |
| `media_status` | `{ type: "movie" | "series", externalId: positive integer }` | `{ type, externalId, tracked, activeDownload, available }` |

Schemas reject unknown keys. `media_lookup` does not select a result. `media_discover` validates the configured root folder and profile ID against the selected service and rejects missing or ambiguous quality mappings. `media_status` reports each evidence field as `true`, `false`, or `null`.

The executor reads `VOIDSTATION_MEDIA_CONFIG_FILE`. It accepts a JSON object with only `radarr` and `sonarr`; each service is an object with only `endpoint`, `keyFile`, `rootFolder`, `defaultQualityProfileId`, and `qualityMappings`. `qualityMappings` is a map of non-empty names to positive integer profile IDs. The selected service API key is read from its `keyFile` and injected only into that Python child environment. It is never passed in argv, included in a result, or logged.

The Python integration boundary is intentionally fixed. The executor has no operation, URL, path, script, argument-tail, payload, or method input. It invokes only the static lookup, discovery, and status vectors specified in `media-integration-notes.md`; it does not invoke add, update, delete, queue removal, command execution, resource CRUD, or arbitrary requests.

`read_skill` reads a verified packaged skill root. The application persists only lookup, discovery, status, and error results, never skill contents. It permits `SKILL.md` and only manifest-listed regular supporting files. It rejects absolute paths, traversal, non-relative paths, symlinks, and paths escaping the skill root. If the package includes a manifest with SHA-256 digests, the reader verifies the selected file before returning it.

The implementation uses `spawn` without a shell, a minimal child environment without proxy variables, a bounded timeout and output buffers, abort-triggered process-tree termination, and generic sanitized errors.
