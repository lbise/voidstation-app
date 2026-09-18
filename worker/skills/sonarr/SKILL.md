---
name: sonarr
description: Use the sonarr.py CLI to query and administer Sonarr
---

Sonarr is managed through `sonarr.py`, a CLI for Sonarr's v3 API.

## Sonarr CLI

Run commands as:

`sonarr.py <command> <subcommand> [options]`

The CLI has no working-directory requirement. Run `sonarr.py` when it is on `PATH`, or invoke the companion script by its installed path. In a dotfiles checkout that path is `./scripts/sonarr.py`.

## Environment Variables

Set these before running commands:

* `SONARR_API_KEY` (required): API key from Sonarr
* `SONARR_URL` (optional): Base URL, defaults to `http://localhost:8989`

## Global Options

* `--url <url>` : Override Sonarr URL
* `--api-key <key>` : Override API key
* `--timeout <seconds>` : HTTP timeout (default 30)
* `--json` : Output raw JSON instead of table/text output

## Main Command Groups

* `system status` : Show Sonarr version and instance info
* `series list|get|lookup|add|update|delete` : Full series management
* `episode list|get|update` : Episode inspection and updates
* `calendar list` : Calendar entries for date ranges
* `queue list|status|get|remove` : Download queue operations
* `wanted missing|cutoff` : Wanted episode views
* `command list|get|run` : Inspect and trigger Sonarr commands
* `resource list|get|create|update|delete` : Generic CRUD for any resource
* `request <METHOD> <PATH>` : Arbitrary API request escape hatch

## Safety Rules

Mutating commands require explicit confirmation:

* `series update/delete` require `--yes`
* `episode update` requires `--yes`
* `queue remove` requires `--yes`
* `resource update/delete` require `--yes`
* `request` with `PUT/PATCH/DELETE` requires `--yes`

## Common Examples

* Show server status:
  `sonarr.py system status`

* List tracked series:
  `sonarr.py series list`

* Find a show by name:
  `sonarr.py series lookup "Severance"`

* Add a show from lookup result index 0:
  `sonarr.py series add "The Expanse" --select 0 --search-missing`

* Trigger RSS sync:
  `sonarr.py command run RssSync`

* Show queue in JSON:
  `sonarr.py --json queue list --page-size 20`

* Generic request against any endpoint:
  `sonarr.py request GET /system/status`

* Update resource with payload file:
  `sonarr.py resource update qualityprofile 1 --data-file ./profile.json --yes`

## Restricted interface

Packaged consumers must use the companion script's fixed, narrowly scoped JSON interface, not the general commands above:

* `sonarr.py restricted lookup --term <term>`
* `sonarr.py restricted configuration`
* `sonarr.py restricted status --id <tvdb-id>`
* `sonarr.py restricted find [--term <term>] [--missing]`
* `sonarr.py restricted details --id <sonarr-id>`
* `sonarr.py restricted configure --id <sonarr-id> --quality-profile-id <id> --root-folder <path> --monitoring <mode> --language-profile-id <id>`
* `sonarr.py restricted search --id <sonarr-id>`

It takes the service URL and credential only from `SONARR_URL` and `SONARR_API_KEY`, accepts no URL or request-path override, never follows redirects, and writes one sanitized JSON result to stdout. The restricted configure and search commands are the only allowed mutation and command-dispatch operations.

## Notes

* Paths passed to `request` can be either `/foo` (auto-prefixed to `/api/v3/foo`) or full `/api/v3/foo`.
* The general CLI remains available for terminal-agent use. Its confirmation flags do not authorize an external consumer to run a mutation.
