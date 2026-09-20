#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Optional

import requests

from media_restricted import read_response_body, run as run_restricted


class RadarrClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "X-Api-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def request(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        payload: Optional[Any] = None,
    ) -> Any:
        normalized_path = path if path.startswith("/") else f"/{path}"

        if normalized_path.startswith("/api/v3/"):
            url = f"{self.base_url}{normalized_path}"
        elif normalized_path == "/api/v3":
            url = f"{self.base_url}/api/v3"
        else:
            url = f"{self.base_url}/api/v3{normalized_path}"

        response = self.session.request(
            method=method.upper(),
            url=url,
            params=params,
            json=payload,
            timeout=self.timeout,
            allow_redirects=False,
            stream=True,
        )

        body = read_response_body(response)
        if response.status_code >= 300:
            raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
        if not body:
            return None
        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type or "text/json" in content_type:
            return json.loads(body.decode("utf-8"))
        return body.decode("utf-8", errors="replace")


def parse_key_value_pairs(pairs: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise ValueError(f"Expected key=value, got: {pair}")
        key, value = pair.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid key in pair: {pair}")
        result[key] = value
    return result


def load_payload_from_args(args: argparse.Namespace) -> Optional[Any]:
    if getattr(args, "data", None) and getattr(args, "data_file", None):
        raise ValueError("Use either --data or --data-file, not both")

    if getattr(args, "data", None):
        return json.loads(args.data)

    if getattr(args, "data_file", None):
        with open(args.data_file, "r", encoding="utf-8") as f:
            return json.load(f)

    return None


def print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, sort_keys=False))


def print_simple_table(
    items: list[dict[str, Any]], columns: list[tuple[str, str]]
) -> None:
    if not items:
        print("No results")
        return

    widths: list[int] = []
    for title, key in columns:
        width = len(title)
        for item in items:
            value = item.get(key, "")
            width = max(width, len(str(value)))
        widths.append(min(width, 60))

    header = "  ".join(title.ljust(widths[i]) for i, (title, _) in enumerate(columns))
    divider = "  ".join("-" * widths[i] for i, _ in enumerate(columns))
    print(header)
    print(divider)

    for item in items:
        row_parts: list[str] = []
        for i, (_, key) in enumerate(columns):
            value = str(item.get(key, ""))
            if len(value) > widths[i]:
                value = value[: widths[i] - 3] + "..."
            row_parts.append(value.ljust(widths[i]))
        print("  ".join(row_parts))


def ensure_yes(args: argparse.Namespace) -> None:
    if not getattr(args, "yes", False):
        raise ValueError("This operation is destructive. Re-run with --yes")


def handle_system_status(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", "/system/status")
    if args.json:
        print_json(data)
        return

    print(f"App: {data.get('appName', 'Radarr')}")
    print(f"Version: {data.get('version', 'unknown')}")
    print(f"Instance: {data.get('instanceName', 'unknown')}")
    print(f"OS: {data.get('osName', 'unknown')} ({data.get('osVersion', 'unknown')})")
    print(f"Startup Path: {data.get('startupPath', 'unknown')}")


def _movie_title(item: dict[str, Any]) -> str:
    movie = item.get("movie")
    if isinstance(movie, dict):
        title = movie.get("title")
        if title:
            return str(title)
    return str(item.get("title", ""))


def _default_profile_id(client: RadarrClient) -> int:
    profiles = client.request("GET", "/qualityprofile")
    if not profiles:
        raise ValueError("No quality profiles available in Radarr")
    return int(profiles[0]["id"])


def _default_root_folder(client: RadarrClient) -> str:
    folders = client.request("GET", "/rootfolder")
    if not folders:
        raise ValueError("No root folder configured in Radarr")
    path = folders[0].get("path")
    if not path:
        raise ValueError("First root folder has no path")
    return path


def handle_movie_list(client: RadarrClient, args: argparse.Namespace) -> None:
    params: dict[str, Any] = {}
    if args.tmdb_id:
        params["tmdbId"] = args.tmdb_id
    data = client.request("GET", "/movie", params=params)
    if args.json:
        print_json(data)
        return

    normalized = [
        {
            "id": item.get("id"),
            "tmdbId": item.get("tmdbId"),
            "title": item.get("title"),
            "year": item.get("year"),
            "status": item.get("status"),
            "monitored": item.get("monitored"),
            "path": item.get("path"),
        }
        for item in data
    ]
    print_simple_table(
        normalized,
        [
            ("ID", "id"),
            ("tmdbId", "tmdbId"),
            ("Title", "title"),
            ("Year", "year"),
            ("Status", "status"),
            ("Mon", "monitored"),
            ("Path", "path"),
        ],
    )


def handle_movie_get(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", f"/movie/{args.id}")
    print_json(data)


def handle_movie_lookup(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", "/movie/lookup", params={"term": args.term})
    if args.json:
        print_json(data)
        return

    normalized = [
        {
            "tmdbId": item.get("tmdbId"),
            "title": item.get("title"),
            "year": item.get("year"),
            "status": item.get("status"),
            "availability": item.get("minimumAvailability"),
            "studio": item.get("studio"),
        }
        for item in data
    ]
    print_simple_table(
        normalized,
        [
            ("tmdbId", "tmdbId"),
            ("Title", "title"),
            ("Year", "year"),
            ("Status", "status"),
            ("Availability", "availability"),
            ("Studio", "studio"),
        ],
    )


def handle_movie_add(client: RadarrClient, args: argparse.Namespace) -> None:
    lookup = client.request("GET", "/movie/lookup", params={"term": args.term})
    if not lookup:
        raise ValueError(f"No movies found for term: {args.term}")

    if args.select < 0 or args.select >= len(lookup):
        raise ValueError(
            f"--select out of range. Got {args.select}, available 0..{len(lookup) - 1}"
        )

    selected = dict(lookup[args.select])
    selected["qualityProfileId"] = args.quality_profile_id or _default_profile_id(
        client
    )
    selected["rootFolderPath"] = args.root_folder or _default_root_folder(client)
    selected["monitored"] = not args.unmonitored
    selected["minimumAvailability"] = args.minimum_availability
    selected["addOptions"] = {"searchForMovie": args.search}

    created = client.request("POST", "/movie", payload=selected)
    print_json(created)


def handle_movie_update(client: RadarrClient, args: argparse.Namespace) -> None:
    ensure_yes(args)
    payload = load_payload_from_args(args)
    if not isinstance(payload, dict):
        raise ValueError("Movie update requires an object payload")
    payload["id"] = args.id
    data = client.request("PUT", f"/movie/{args.id}", payload=payload)
    print_json(data)


def handle_movie_delete(client: RadarrClient, args: argparse.Namespace) -> None:
    ensure_yes(args)
    params = {
        "deleteFiles": bool(args.delete_files),
        "addImportExclusion": bool(args.add_import_exclusion),
    }
    data = client.request("DELETE", f"/movie/{args.id}", params=params)
    if data is None:
        print("Movie deleted")
    else:
        print_json(data)


def handle_calendar_list(client: RadarrClient, args: argparse.Namespace) -> None:
    params: dict[str, Any] = {
        "unmonitored": args.unmonitored,
        "includeMovie": args.include_movie,
        "includeMovieFile": args.include_movie_file,
    }
    if args.start:
        params["start"] = args.start
    if args.end:
        params["end"] = args.end
    if args.tags:
        params["tags"] = args.tags

    data = client.request("GET", "/calendar", params=params)
    if args.json:
        print_json(data)
        return

    normalized = [
        {
            "id": item.get("id"),
            "movie": _movie_title(item),
            "year": item.get("movie", {}).get("year")
            if isinstance(item.get("movie"), dict)
            else None,
            "inCinemas": item.get("inCinemas"),
            "physicalRelease": item.get("physicalRelease"),
            "digitalRelease": item.get("digitalRelease"),
        }
        for item in data
    ]
    print_simple_table(
        normalized,
        [
            ("ID", "id"),
            ("Movie", "movie"),
            ("Year", "year"),
            ("In Cinemas", "inCinemas"),
            ("Physical", "physicalRelease"),
            ("Digital", "digitalRelease"),
        ],
    )


def handle_queue_list(client: RadarrClient, args: argparse.Namespace) -> None:
    params: dict[str, Any] = {
        "page": args.page,
        "pageSize": args.page_size,
        "includeUnknownMovieItems": args.include_unknown_movie_items,
        "includeMovie": args.include_movie,
    }
    if args.sort_key:
        params["sortKey"] = args.sort_key
    if args.sort_direction:
        params["sortDirection"] = args.sort_direction

    data = client.request("GET", "/queue", params=params)
    if args.json:
        print_json(data)
        return

    records = data.get("records", []) if isinstance(data, dict) else data
    normalized = [
        {
            "id": item.get("id"),
            "status": item.get("status"),
            "movie": _movie_title(item),
            "size": item.get("size"),
            "left": item.get("sizeleft"),
            "protocol": item.get("protocol"),
        }
        for item in records
    ]
    print_simple_table(
        normalized,
        [
            ("ID", "id"),
            ("Status", "status"),
            ("Protocol", "protocol"),
            ("Size", "size"),
            ("Left", "left"),
            ("Movie", "movie"),
        ],
    )


def handle_queue_status(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", "/queue/status")
    print_json(data)


def handle_queue_get(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", f"/queue/{args.id}")
    print_json(data)


def handle_queue_remove(client: RadarrClient, args: argparse.Namespace) -> None:
    ensure_yes(args)
    params = {"removeFromClient": args.remove_from_client, "blocklist": args.blocklist}
    data = client.request("DELETE", f"/queue/{args.id}", params=params)
    if data is None:
        print("Queue item removed")
    else:
        print_json(data)


def handle_wanted_missing(client: RadarrClient, args: argparse.Namespace) -> None:
    params: dict[str, Any] = {
        "page": args.page,
        "pageSize": args.page_size,
        "monitored": args.monitored,
        "includeMovie": args.include_movie,
    }
    if args.sort_key:
        params["sortKey"] = args.sort_key
    if args.sort_direction:
        params["sortDirection"] = args.sort_direction

    data = client.request("GET", "/wanted/missing", params=params)
    if args.json:
        print_json(data)
        return

    records = data.get("records", []) if isinstance(data, dict) else data
    normalized = [
        {
            "id": item.get("id"),
            "movie": _movie_title(item),
            "year": item.get("movie", {}).get("year")
            if isinstance(item.get("movie"), dict)
            else None,
            "status": item.get("status"),
            "downloaded": item.get("hasFile"),
            "minimumAvailability": item.get("minimumAvailability"),
        }
        for item in records
    ]
    print_simple_table(
        normalized,
        [
            ("ID", "id"),
            ("Movie", "movie"),
            ("Year", "year"),
            ("Status", "status"),
            ("Has File", "downloaded"),
            ("Min Availability", "minimumAvailability"),
        ],
    )


def handle_command_list(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", "/command")
    if args.json:
        print_json(data)
        return

    normalized = [
        {
            "id": item.get("id"),
            "name": item.get("name") or item.get("commandName"),
            "status": item.get("status"),
            "queued": item.get("queued"),
            "started": item.get("started"),
            "ended": item.get("ended"),
        }
        for item in data
    ]
    print_simple_table(
        normalized,
        [
            ("ID", "id"),
            ("Name", "name"),
            ("Status", "status"),
            ("Queued", "queued"),
            ("Started", "started"),
            ("Ended", "ended"),
        ],
    )


def handle_command_get(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", f"/command/{args.id}")
    print_json(data)


def handle_command_run(client: RadarrClient, args: argparse.Namespace) -> None:
    payload: dict[str, Any] = {"name": args.name}
    if args.command_data:
        payload.update(json.loads(args.command_data))
    data = client.request("POST", "/command", payload=payload)
    print_json(data)


def handle_generic_list(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", f"/{args.resource}")
    print_json(data)


def handle_generic_get(client: RadarrClient, args: argparse.Namespace) -> None:
    data = client.request("GET", f"/{args.resource}/{args.id}")
    print_json(data)


def handle_generic_create(client: RadarrClient, args: argparse.Namespace) -> None:
    payload = load_payload_from_args(args)
    if payload is None:
        raise ValueError("Create requires --data or --data-file")
    data = client.request("POST", f"/{args.resource}", payload=payload)
    print_json(data)


def handle_generic_update(client: RadarrClient, args: argparse.Namespace) -> None:
    ensure_yes(args)
    payload = load_payload_from_args(args)
    if payload is None:
        raise ValueError("Update requires --data or --data-file")
    data = client.request("PUT", f"/{args.resource}/{args.id}", payload=payload)
    print_json(data)


def handle_generic_delete(client: RadarrClient, args: argparse.Namespace) -> None:
    ensure_yes(args)
    data = client.request("DELETE", f"/{args.resource}/{args.id}")
    if data is None:
        print("Deleted")
    else:
        print_json(data)


def handle_request(client: RadarrClient, args: argparse.Namespace) -> None:
    method = args.method.upper()
    if method in {"PUT", "PATCH", "DELETE"}:
        ensure_yes(args)

    params = parse_key_value_pairs(args.query or [])
    payload = load_payload_from_args(args)

    data = client.request(method, args.path, params=params, payload=payload)
    if data is None:
        print("OK")
        return

    if isinstance(data, (dict, list)):
        print_json(data)
    else:
        print(data)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Simple Radarr CLI (v3 API)",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--url",
        default=os.getenv("RADARR_URL", "http://localhost:7878"),
        help="Radarr base URL (default: env RADARR_URL or http://localhost:7878)",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("RADARR_API_KEY") or os.getenv("RADARR_APIKEY"),
        help="Radarr API key (default: env RADARR_API_KEY)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds (default: 30)",
    )
    parser.add_argument("--json", action="store_true", help="Output full JSON response")

    subparsers = parser.add_subparsers(dest="command", required=True)

    system = subparsers.add_parser("system", help="System endpoints")
    system_sub = system.add_subparsers(dest="system_command", required=True)
    system_status = system_sub.add_parser("status", help="Get Radarr status")
    system_status.set_defaults(handler=handle_system_status)

    movie = subparsers.add_parser("movie", help="Movie operations")
    movie_sub = movie.add_subparsers(dest="movie_command", required=True)

    movie_list = movie_sub.add_parser("list", help="List movies")
    movie_list.add_argument("--tmdb-id", type=int)
    movie_list.set_defaults(handler=handle_movie_list)

    movie_get = movie_sub.add_parser("get", help="Get a movie by id")
    movie_get.add_argument("id", type=int)
    movie_get.set_defaults(handler=handle_movie_get)

    movie_lookup = movie_sub.add_parser("lookup", help="Lookup movies by term")
    movie_lookup.add_argument("term", help="Search term")
    movie_lookup.set_defaults(handler=handle_movie_lookup)

    movie_add = movie_sub.add_parser("add", help="Add a new movie from lookup term")
    movie_add.add_argument("term", help='Lookup term (e.g. "Blade Runner")')
    movie_add.add_argument(
        "--select",
        type=int,
        default=0,
        help="Index from lookup results to add (default: 0)",
    )
    movie_add.add_argument("--root-folder", help="Root folder path")
    movie_add.add_argument("--quality-profile-id", type=int)
    movie_add.add_argument(
        "--minimum-availability",
        default="released",
        choices=["announced", "inCinemas", "released", "preDB"],
    )
    movie_add.add_argument(
        "--unmonitored", action="store_true", help="Add as unmonitored"
    )
    movie_add.add_argument(
        "--search", action="store_true", help="Search for movie after adding"
    )
    movie_add.set_defaults(handler=handle_movie_add)

    movie_update = movie_sub.add_parser("update", help="Update a movie by id")
    movie_update.add_argument("id", type=int)
    movie_update.add_argument("--data", help="JSON payload string")
    movie_update.add_argument("--data-file", help="Path to JSON payload file")
    movie_update.add_argument("--yes", action="store_true", help="Confirm update")
    movie_update.set_defaults(handler=handle_movie_update)

    movie_delete = movie_sub.add_parser("delete", help="Delete a movie by id")
    movie_delete.add_argument("id", type=int)
    movie_delete.add_argument("--delete-files", action="store_true")
    movie_delete.add_argument("--add-import-exclusion", action="store_true")
    movie_delete.add_argument("--yes", action="store_true", help="Confirm delete")
    movie_delete.set_defaults(handler=handle_movie_delete)

    calendar = subparsers.add_parser("calendar", help="Calendar operations")
    calendar_sub = calendar.add_subparsers(dest="calendar_command", required=True)
    calendar_list = calendar_sub.add_parser("list", help="List calendar entries")
    calendar_list.add_argument("--start", help="Start datetime (ISO-8601)")
    calendar_list.add_argument("--end", help="End datetime (ISO-8601)")
    calendar_list.add_argument("--unmonitored", action="store_true")
    calendar_list.add_argument("--include-movie", action="store_true")
    calendar_list.add_argument("--include-movie-file", action="store_true")
    calendar_list.add_argument("--tags", help="Comma separated tags")
    calendar_list.set_defaults(handler=handle_calendar_list)

    queue = subparsers.add_parser("queue", help="Queue operations")
    queue_sub = queue.add_subparsers(dest="queue_command", required=True)

    queue_list = queue_sub.add_parser("list", help="List queue items")
    queue_list.add_argument("--page", type=int, default=1)
    queue_list.add_argument("--page-size", type=int, default=50)
    queue_list.add_argument("--sort-key")
    queue_list.add_argument("--sort-direction", choices=["ascending", "descending"])
    queue_list.add_argument("--include-unknown-movie-items", action="store_true")
    queue_list.add_argument("--include-movie", action="store_true")
    queue_list.set_defaults(handler=handle_queue_list)

    queue_status = queue_sub.add_parser("status", help="Get queue status")
    queue_status.set_defaults(handler=handle_queue_status)

    queue_get = queue_sub.add_parser("get", help="Get queue item by id")
    queue_get.add_argument("id", type=int)
    queue_get.set_defaults(handler=handle_queue_get)

    queue_remove = queue_sub.add_parser("remove", help="Remove queue item by id")
    queue_remove.add_argument("id", type=int)
    queue_remove.add_argument("--remove-from-client", action="store_true")
    queue_remove.add_argument("--blocklist", action="store_true")
    queue_remove.add_argument("--yes", action="store_true", help="Confirm remove")
    queue_remove.set_defaults(handler=handle_queue_remove)

    wanted = subparsers.add_parser("wanted", help="Wanted endpoints")
    wanted_sub = wanted.add_subparsers(dest="wanted_command", required=True)

    wanted_missing = wanted_sub.add_parser("missing", help="List missing movies")
    wanted_missing.add_argument("--page", type=int, default=1)
    wanted_missing.add_argument("--page-size", type=int, default=50)
    wanted_missing.add_argument("--sort-key")
    wanted_missing.add_argument("--sort-direction", choices=["ascending", "descending"])
    wanted_missing.add_argument(
        "--no-movie",
        dest="include_movie",
        action="store_false",
        help="Do not include movie object",
    )
    monitor_group = wanted_missing.add_mutually_exclusive_group()
    monitor_group.add_argument(
        "--monitored",
        dest="monitored",
        action="store_true",
        help="Only monitored movies (default)",
    )
    monitor_group.add_argument(
        "--unmonitored",
        dest="monitored",
        action="store_false",
        help="Include unmonitored movies",
    )
    wanted_missing.set_defaults(
        handler=handle_wanted_missing,
        monitored=True,
        include_movie=True,
    )

    command = subparsers.add_parser("command", help="Command endpoints")
    command_sub = command.add_subparsers(dest="command_command", required=True)

    command_list = command_sub.add_parser("list", help="List command history")
    command_list.set_defaults(handler=handle_command_list)

    command_get = command_sub.add_parser("get", help="Get command by id")
    command_get.add_argument("id", type=int)
    command_get.set_defaults(handler=handle_command_get)

    command_run = command_sub.add_parser("run", help="Run a Radarr command")
    command_run.add_argument("name", help="Command name, e.g. RefreshMovie")
    command_run.add_argument(
        "--command-data",
        help='Extra JSON object to merge into payload (example: {"movieId":12})',
    )
    command_run.set_defaults(handler=handle_command_run)

    generic = subparsers.add_parser("resource", help="Generic resource CRUD")
    generic_sub = generic.add_subparsers(dest="resource_command", required=True)

    g_list = generic_sub.add_parser("list", help="GET /<resource>")
    g_list.add_argument("resource", help="Resource path (example: indexer)")
    g_list.set_defaults(handler=handle_generic_list)

    g_get = generic_sub.add_parser("get", help="GET /<resource>/<id>")
    g_get.add_argument("resource")
    g_get.add_argument("id", type=int)
    g_get.set_defaults(handler=handle_generic_get)

    g_create = generic_sub.add_parser("create", help="POST /<resource>")
    g_create.add_argument("resource")
    g_create.add_argument("--data", help="JSON payload string")
    g_create.add_argument("--data-file", help="Path to JSON payload file")
    g_create.set_defaults(handler=handle_generic_create)

    g_update = generic_sub.add_parser("update", help="PUT /<resource>/<id>")
    g_update.add_argument("resource")
    g_update.add_argument("id", type=int)
    g_update.add_argument("--data", help="JSON payload string")
    g_update.add_argument("--data-file", help="Path to JSON payload file")
    g_update.add_argument("--yes", action="store_true", help="Confirm update")
    g_update.set_defaults(handler=handle_generic_update)

    g_delete = generic_sub.add_parser("delete", help="DELETE /<resource>/<id>")
    g_delete.add_argument("resource")
    g_delete.add_argument("id", type=int)
    g_delete.add_argument("--yes", action="store_true", help="Confirm delete")
    g_delete.set_defaults(handler=handle_generic_delete)

    request = subparsers.add_parser("request", help="Arbitrary API request")
    request.add_argument("method", help="HTTP method, e.g. GET/POST/PUT/DELETE")
    request.add_argument("path", help="Path like /movie or /api/v3/movie")
    request.add_argument(
        "--query",
        action="append",
        help="Query key=value (repeatable)",
    )
    request.add_argument("--data", help="JSON payload string")
    request.add_argument("--data-file", help="Path to JSON payload file")
    request.add_argument("--yes", action="store_true", help="Confirm mutating request")
    request.set_defaults(handler=handle_request)

    return parser


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "restricted":
        raise SystemExit(run_restricted("radarr", RadarrClient, sys.argv[2:]))

    parser = build_parser()
    args = parser.parse_args()

    if not args.api_key:
        print(
            "Error: Radarr API key missing. Use --api-key or set RADARR_API_KEY.",
            file=sys.stderr,
        )
        sys.exit(2)

    client = RadarrClient(args.url, args.api_key, timeout=args.timeout)

    try:
        args.handler(client, args)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON payload - {e}", file=sys.stderr)
        sys.exit(2)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)
    except requests.exceptions.ConnectionError as e:
        print(f"Error: Could not connect to Radarr - {e}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.Timeout:
        print("Error: Radarr request timed out", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.HTTPError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.RequestException as e:
        print(f"Error: Request failed - {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
