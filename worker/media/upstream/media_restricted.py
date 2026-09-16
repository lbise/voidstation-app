"""Fixed, read-only JSON interface shared by the Radarr and Sonarr CLIs.

This module intentionally does not expose the general CLI's URL, request, resource,
or mutation arguments. Consumers must invoke it through ``<service>.py restricted``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable
from urllib.parse import urlsplit

import requests

MAX_TERM_LENGTH = 300
MAX_RESULTS = 20
MAX_TEXT_LENGTH = 500
MAX_TIMEOUT_SECONDS = 30


def _text(value: object, limit: int = MAX_TEXT_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = "".join(char if char.isprintable() else " " for char in value).strip()
    return cleaned[:limit] if cleaned else None


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _positive_integer(value: object) -> int | None:
    integer = _integer(value)
    return integer if integer is not None and integer > 0 else None


def _boolean(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _items(value: object) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _output(payload: dict[str, Any]) -> None:
    # One bounded JSON value makes it safe for a caller to parse stdout without
    # relaying raw service responses or exception text.
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True))


def _failure(code: str) -> int:
    messages = {
        "invalid_input": "The requested media arguments are invalid.",
        "invalid_configuration": "The media service configuration is invalid.",
        "request_failed": "The media service request failed.",
        "timeout": "The media service request timed out.",
        "invalid_response": "The media service returned an invalid response.",
    }
    _output({"ok": False, "error": {"code": code, "message": messages[code]}})
    return 2 if code in {"invalid_input", "invalid_configuration"} else 3


def _configured_client(service: str, client_factory: Callable[[str, str, int], Any]) -> Any:
    prefix = service.upper()
    base_url = os.getenv(f"{prefix}_URL")
    api_key = os.getenv(f"{prefix}_API_KEY") or os.getenv(f"{prefix}_APIKEY")
    if not base_url or not api_key:
        raise ValueError("configuration")
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("configuration")
    try:
        timeout = int(os.getenv("VOIDSTATION_MEDIA_TIMEOUT_SECONDS", "15"))
    except ValueError as error:
        raise ValueError("configuration") from error
    if timeout < 1 or timeout > MAX_TIMEOUT_SECONDS:
        raise ValueError("configuration")
    return client_factory(base_url, api_key, timeout)


def _lookup(service: str, client: Any, term: str) -> dict[str, Any]:
    if not term.strip() or len(term) > MAX_TERM_LENGTH:
        raise ValueError("input")
    resource = "movie" if service == "radarr" else "series"
    identity_key = "tmdbId" if service == "radarr" else "tvdbId"
    raw = client.request("GET", f"/{resource}/lookup", params={"term": term.strip()})
    results: list[dict[str, Any]] = []
    for item in _items(raw)[:MAX_RESULTS]:
        identity = _positive_integer(item.get(identity_key))
        title = _text(item.get("title"))
        if identity is None or title is None:
            continue
        choice: dict[str, Any] = {"id": identity, "title": title, "type": "movie" if service == "radarr" else "series"}
        year = _positive_integer(item.get("year"))
        if year is not None:
            choice["year"] = year
        if service == "radarr":
            availability = _text(item.get("minimumAvailability"))
            if availability is not None:
                choice["minimumAvailability"] = availability
        else:
            status = _text(item.get("status"))
            if status is not None:
                choice["status"] = status
        results.append(choice)
    return {"ok": True, "action": "lookup", "service": service, "results": results}


def _configuration(service: str, client: Any) -> dict[str, Any]:
    profiles = _items(client.request("GET", "/qualityprofile"))
    folders = _items(client.request("GET", "/rootfolder"))
    result: dict[str, Any] = {
        "ok": True,
        "action": "configuration",
        "service": service,
        "qualityProfiles": [
            {"id": identity, "name": name}
            for item in profiles[:MAX_RESULTS]
            if (identity := _positive_integer(item.get("id"))) is not None
            and (name := _text(item.get("name"))) is not None
        ],
        "rootFolders": [
            {"id": identity, "path": path}
            for item in folders[:MAX_RESULTS]
            if (identity := _positive_integer(item.get("id"))) is not None
            and (path := _text(item.get("path"))) is not None
        ],
    }
    return result


def _queue_entries(service: str, client: Any, library_id: int) -> list[dict[str, Any]]:
    resource = "movie" if service == "radarr" else "series"
    response = client.request(
        "GET",
        "/queue",
        params={"page": 1, "pageSize": 1000, f"include{resource.title()}": True},
    )
    raw_records = response.get("records") if isinstance(response, dict) else response
    entries: list[dict[str, Any]] = []
    for item in _items(raw_records)[:1000]:
        media = item.get(resource)
        if not isinstance(media, dict) or _positive_integer(media.get("id")) != library_id:
            continue
        entry: dict[str, Any] = {}
        for output_key, input_key in (("id", "id"), ("status", "status"), ("title", "title")):
            value = _positive_integer(item.get(input_key)) if output_key == "id" else _text(item.get(input_key))
            if value is not None:
                entry[output_key] = value
        for output_key, input_key in (("size", "size"), ("sizeLeft", "sizeleft")):
            value = _integer(item.get(input_key))
            if value is not None and value >= 0:
                entry[output_key] = value
        entries.append(entry)
    return entries[:MAX_RESULTS]


def _status(service: str, client: Any, identity: int) -> dict[str, Any]:
    resource = "movie" if service == "radarr" else "series"
    identity_key = "tmdbId" if service == "radarr" else "tvdbId"
    found = next(
        (item for item in _items(client.request("GET", f"/{resource}", params={identity_key: identity})) if _positive_integer(item.get(identity_key)) == identity),
        None,
    )
    if found is None:
        return {"ok": True, "action": "status", "service": service, "identity": {"id": identity, "type": "movie" if service == "radarr" else "series"}, "tracked": False, "activeDownloads": []}
    library_id = _positive_integer(found.get("id"))
    if library_id is None:
        raise RuntimeError("response")
    status: dict[str, Any] = {
        "ok": True,
        "action": "status",
        "service": service,
        "identity": {"id": identity, "type": "movie" if service == "radarr" else "series"},
        "tracked": True,
        "activeDownloads": _queue_entries(service, client, library_id),
    }
    for output_key, input_key in (("title", "title"), ("status", "status")):
        value = _text(found.get(input_key))
        if value is not None:
            status[output_key] = value
    year = _positive_integer(found.get("year"))
    if year is not None:
        status["year"] = year
    for output_key, input_key in (("monitored", "monitored"), ("hasFile", "hasFile")):
        value = _boolean(found.get(input_key))
        if value is not None:
            status[output_key] = value
    if service == "sonarr" and "hasFile" not in status:
        statistics = found.get("statistics")
        episode_files = statistics.get("episodeFileCount") if isinstance(statistics, dict) else None
        if isinstance(episode_files, (int, float)) and not isinstance(episode_files, bool) and episode_files >= 0:
            status["hasFile"] = episode_files > 0
    return status


def run(
    service: str, client_factory: Callable[[str, str, int], Any], argv: list[str] | None = None
) -> int:
    parser = argparse.ArgumentParser(
        prog=f"{service}.py restricted",
        description="Fixed read-only JSON interface for a configured media service.",
    )
    commands = parser.add_subparsers(dest="action", required=True)
    lookup = commands.add_parser("lookup")
    lookup.add_argument("--term", required=True)
    commands.add_parser("configuration")
    status = commands.add_parser("status")
    status.add_argument("--id", type=int, required=True)
    args = parser.parse_args(argv)
    if getattr(args, "id", 1) <= 0:
        return _failure("invalid_input")
    try:
        client = _configured_client(service, client_factory)
        if args.action == "lookup":
            payload = _lookup(service, client, args.term)
        elif args.action == "configuration":
            payload = _configuration(service, client)
        else:
            payload = _status(service, client, args.id)
    except ValueError as error:
        return _failure("invalid_input" if str(error) == "input" else "invalid_configuration")
    except requests.exceptions.Timeout:
        return _failure("timeout")
    except requests.exceptions.RequestException:
        return _failure("request_failed")
    except (KeyError, TypeError, RuntimeError):
        return _failure("invalid_response")
    _output(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit("Invoke this module through radarr.py or sonarr.py.")
