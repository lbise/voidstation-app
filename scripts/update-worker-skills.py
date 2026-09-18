#!/usr/bin/env python3
"""Update or verify pinned Radarr/Sonarr skills and Python integrations."""
from __future__ import annotations
import argparse, hashlib, json, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "worker" / "skills"
UPSTREAM = ROOT / "worker" / "media" / "upstream"
SOURCES = (
    ("radarr/SKILL.md", "dot/.agents/skills-catalog/radarr/SKILL.md", SKILLS),
    ("sonarr/SKILL.md", "dot/.agents/skills-catalog/sonarr/SKILL.md", SKILLS),
    ("radarr.py", "scripts/radarr.py", UPSTREAM),
    ("sonarr.py", "scripts/sonarr.py", UPSTREAM),
)
APP_OWNED_RESTRICTED = "media_restricted.py"

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode: raise ValueError("source root is not a Git checkout")
    return result.stdout.strip()

def revision(root: Path) -> str:
    paths = [source for _, source, _ in SOURCES]
    if git(root, "status", "--porcelain", "--", *paths): raise ValueError("commit selected shared sources before packaging")
    value = git(root, "rev-parse", "HEAD")
    if len(value) != 40: raise ValueError("source revision is invalid")
    return value

def entries(root: Path) -> tuple[str, list[dict[str, str]]]:
    rev = revision(root)
    result = []
    for destination, source, _ in SOURCES:
        path = root / source
        if not path.is_file(): raise ValueError(f"missing shared source: {source}")
        result.append({"path": destination, "sourcePath": source, "sha256": digest(path)})
    return rev, result

def apply_portability_patches(staged: Path, files: list[dict[str, str]]) -> None:
    for adapter in ("radarr.py", "sonarr.py"):
        adapter_path = staged / "media/upstream" / adapter
        adapter_source = adapter_path.read_text()
        request_old = "            allow_redirects=False,\n        )\n"
        request_new = "            allow_redirects=False,\n            stream=True,\n        )\n"
        if adapter_source.count(request_old) != 1: raise ValueError("shared adapter request patch no longer applies")
        adapter_source = adapter_source.replace(request_old, request_new)
        body_old = '''        if response.status_code >= 300:
            message = response.text.strip()
            raise requests.exceptions.HTTPError(
                f"HTTP {response.status_code} {response.reason}: {message}",
                response=response,
            )

        if not response.content:
            return None

        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type or "text/json" in content_type:
            return response.json()

        return response.text
'''
        body_new = '''        body = response.raw.read(131073)
        if len(body) > 131072:
            raise requests.exceptions.RequestException("response too large")
        if response.status_code >= 300:
            raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
        if not body:
            return None
        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type or "text/json" in content_type:
            return json.loads(body.decode("utf-8"))
        return body.decode("utf-8", errors="replace")
'''
        if adapter_source.count(body_old) != 1: raise ValueError("shared adapter body patch no longer applies")
        adapter_path.write_text(adapter_source.replace(body_old, body_new))
        for entry in files:
            if entry["path"] == adapter: entry["sha256"] = digest(adapter_path)
    skill_commands = {
        "radarr/SKILL.md": [
            "* `radarr.py restricted find [--term <term>] [--missing]`",
            "* `radarr.py restricted details --id <radarr-id>`",
            "* `radarr.py restricted configure --id <radarr-id> --quality-profile-id <id> --root-folder <path> --monitoring <mode>`",
            "* `radarr.py restricted search --id <radarr-id>`",
        ],
        "sonarr/SKILL.md": [
            "* `sonarr.py restricted find [--term <term>] [--missing]`",
            "* `sonarr.py restricted details --id <sonarr-id>`",
            "* `sonarr.py restricted configure --id <sonarr-id> --quality-profile-id <id> --root-folder <path> --monitoring <mode> --language-profile-id <id>`",
            "* `sonarr.py restricted search --id <sonarr-id>`",
        ],
    }
    for relative, commands in skill_commands.items():
        path = staged / "skills" / relative
        source = path.read_text()
        source = source.replace("Packaged consumers that need read-only media data must use the companion script's fixed JSON interface, not the general commands above:", "Packaged consumers must use the companion script's fixed, narrowly scoped JSON interface, not the general commands above:")
        marker = commands[0]
        if marker not in source:
            status = next(line for line in source.splitlines() if "restricted status --id" in line)
            source = source.replace(status, status + "\n" + "\n".join(commands))
        service = "RADARR" if relative.startswith("radarr/") else "SONARR"
        source = source.replace(f"It takes the service URL and credential only from `{service}_URL` and `{service}_API_KEY`, accepts no URL or request-path override, never follows redirects, and writes one sanitized JSON result to stdout. It does not authorize mutations.", f"It takes the service URL and credential only from `{service}_URL` and `{service}_API_KEY`, accepts no URL or request-path override, never follows redirects, and writes one sanitized JSON result to stdout. The restricted configure and search commands are the only allowed mutation and command-dispatch operations.")
        path.write_text(source)
        for entry in files:
            if entry["path"] == relative: entry["sha256"] = digest(path)

def update(root: Path) -> None:
    rev, files = entries(root)
    app_path = UPSTREAM / APP_OWNED_RESTRICTED
    if not app_path.is_file(): raise ValueError(f"missing app-owned source: {app_path}")
    files.append({"path": APP_OWNED_RESTRICTED, "sourcePath": str(app_path.relative_to(ROOT)), "sha256": digest(app_path)})
    with tempfile.TemporaryDirectory(dir=ROOT / "worker") as directory:
        staged = Path(directory)
        for entry in files:
            destination = staged / ("skills" if entry["path"].endswith("SKILL.md") else "media/upstream") / (entry["path"] if entry["path"].endswith("SKILL.md") else Path(entry["path"]).name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = app_path if entry["path"] == APP_OWNED_RESTRICTED else root / entry["sourcePath"]
            shutil.copyfile(source, destination)
        apply_portability_patches(staged, files)
        (staged / "skills" / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "source": {"repository": "dotfiles", "revision": rev}, "files": [entry for entry in files if entry["path"].endswith("SKILL.md")]}, indent=2) + "\n")
        (staged / "media").mkdir(exist_ok=True)
        (staged / "media" / "source-manifest.json").write_text(json.dumps({"schemaVersion": 1, "source": {"repository": "dotfiles", "revision": rev}, "files": [entry for entry in files if entry["path"].endswith(".py")]}, indent=2) + "\n")
        for target in (SKILLS, UPSTREAM):
            target.mkdir(parents=True, exist_ok=True)
        for entry in files:
            if entry["path"].endswith("SKILL.md"):
                destination = SKILLS / entry["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(staged / "skills" / entry["path"], destination)
        for entry in files:
            if entry["path"].endswith(".py"):
                destination = UPSTREAM / entry["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(staged / "media/upstream" / entry["path"], destination)
        shutil.copyfile(staged / "skills/manifest.json", SKILLS / "manifest.json")
        shutil.copyfile(staged / "media/source-manifest.json", ROOT / "worker/media/source-manifest.json")

def check() -> None:
    try:
        manifest = json.loads((SKILLS / "manifest.json").read_text())
        source_manifest = json.loads((ROOT / "worker/media/source-manifest.json").read_text())
    except (OSError, json.JSONDecodeError) as error: raise ValueError("source manifest is missing or invalid") from error
    for value, expected_suffix in ((manifest, "SKILL.md"), (source_manifest, ".py")):
        if value.get("schemaVersion") != 1 or value.get("source", {}).get("repository") != "dotfiles": raise ValueError("source manifest schema is invalid")
        files = value.get("files")
        if not isinstance(files, list): raise ValueError("source manifest file list is invalid")
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"].endswith(expected_suffix) or not isinstance(entry.get("sha256"), str): raise ValueError("source manifest entry is invalid")
            path = (SKILLS / entry["path"]) if expected_suffix == "SKILL.md" else (UPSTREAM / entry["path"])
            if not path.is_file() or digest(path) != entry["sha256"]: raise ValueError(f"source hash mismatch: {entry['path']}")
        expected = {"radarr.py", "sonarr.py", "media_restricted.py"} if expected_suffix == ".py" else {"radarr/SKILL.md", "sonarr/SKILL.md"}
        if {entry["path"] for entry in files} != expected: raise ValueError("source manifest entries are incomplete or unexpected")
    actual = {path.relative_to(SKILLS).as_posix() for path in SKILLS.rglob("*") if path.is_file()}
    if actual != {"radarr/SKILL.md", "sonarr/SKILL.md", "manifest.json"}: raise ValueError("skill snapshot contains an unexpected file")
    actual_upstream = {path.name for path in UPSTREAM.iterdir() if path.is_file()}
    if actual_upstream != {"radarr.py", "sonarr.py", "media_restricted.py"}: raise ValueError("media source snapshot contains an unexpected file")

def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True); group.add_argument("--update", action="store_true"); group.add_argument("--check", action="store_true")
    parser.add_argument("--source-root", type=Path); args = parser.parse_args()
    try:
        if args.update:
            if not args.source_root: raise ValueError("--source-root is required with --update")
            update(args.source_root.resolve())
        else:
            if args.source_root: raise ValueError("--source-root is only valid with --update")
            check()
    except (OSError, ValueError, KeyError) as error:
        print(f"worker sources: {error}", file=sys.stderr); return 1
    print("worker sources: ok"); return 0

if __name__ == "__main__": raise SystemExit(main())
