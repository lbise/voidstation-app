---
name: radarr
description: Use the radarr.py CLI to query and administer Radarr
---

Radarr is managed through `radarr.py`, a CLI for Radarr's v3 API.

## Radarr CLI

Run commands as:

`radarr.py <command> <subcommand> [options]`

The CLI has no working-directory requirement. Run `radarr.py` when it is on `PATH`, or invoke the companion script by its installed path. In a dotfiles checkout that path is `./scripts/radarr.py`.

## Environment Variables

Set these before running commands:

* `RADARR_API_KEY` (required): API key from Radarr
* `RADARR_URL` (optional): Base URL, defaults to `http://localhost:7878`

## Global Options

* `--url <url>` : Override Radarr URL
* `--api-key <key>` : Override API key
* `--timeout <seconds>` : HTTP timeout (default 30)
* `--json` : Output raw JSON instead of table/text output

## Main Command Groups

* `system status` : Show Radarr version and instance info
* `movie list|get|lookup|add|update|delete` : Full movie management
* `calendar list` : Calendar entries for release windows
* `queue list|status|get|remove` : Download queue operations
* `wanted missing` : Wanted/missing movie view
* `command list|get|run` : Inspect and trigger Radarr commands
* `resource list|get|create|update|delete` : Generic CRUD for any resource
* `request <METHOD> <PATH>` : Arbitrary API request escape hatch

## Safety Rules

Mutating commands require explicit confirmation:

* `movie update/delete` require `--yes`
* `queue remove` requires `--yes`
* `resource update/delete` require `--yes`
* `request` with `PUT/PATCH/DELETE` requires `--yes`

## Common Examples

* Show server status:
  `radarr.py system status`

* List tracked movies:
  `radarr.py movie list`

* Find a movie by name:
  `radarr.py movie lookup "Dune"`

* Add a movie from lookup result index 0 and search immediately:
  `radarr.py movie add "Blade Runner" --select 0 --search`

* Trigger RSS sync:
  `radarr.py command run RssSync`

* Show queue in JSON:
  `radarr.py --json queue list --page-size 20`

* Generic request against any endpoint:
  `radarr.py request GET /system/status`

* Update resource with payload file:
  `radarr.py resource update qualityprofile 1 --data-file ./profile.json --yes`

## Restricted interface

Packaged consumers must use the companion script's fixed, narrowly scoped JSON interface, not the general commands above:

* `radarr.py restricted lookup --term <term>`
* `radarr.py restricted configuration`
* `radarr.py restricted status --id <tmdb-id>`
* `radarr.py restricted find [--term <term>] [--missing]`
* `radarr.py restricted details --id <radarr-id>`
* `radarr.py restricted configure --id <radarr-id> --quality-profile-id <id> --root-folder <path> --monitoring <mode>`
* `radarr.py restricted search --id <radarr-id>`

It takes the service URL and credential only from `RADARR_URL` and `RADARR_API_KEY`, accepts no URL or request-path override, never follows redirects, and writes one sanitized JSON result to stdout. The restricted configure and search commands are the only allowed mutations and command dispatches.

## Notes

* Paths passed to `request` can be either `/foo` (auto-prefixed to `/api/v3/foo`) or full `/api/v3/foo`.
* The general CLI remains available for terminal-agent use. Its confirmation flags do not authorize an external consumer to run a mutation.
