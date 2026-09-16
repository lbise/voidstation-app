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
    ("media_restricted.py", "scripts/media_restricted.py", UPSTREAM),
)

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
    # Keep the shared CLI unchanged while exposing Sonarr's series-level file
    # statistics through the fixed worker status projection.
    path = staged / "media/upstream/media_restricted.py"
    source = path.read_text()
    old = '    return status\n\n\ndef run(\n'
    new = '''    if service == "sonarr" and "hasFile" not in status:
        statistics = found.get("statistics")
        episode_files = statistics.get("episodeFileCount") if isinstance(statistics, dict) else None
        if isinstance(episode_files, (int, float)) and not isinstance(episode_files, bool) and episode_files >= 0:
            status["hasFile"] = episode_files > 0
    return status


def run(
'''
    if old not in source or source.count(old) != 1: raise ValueError("shared media source portability patch no longer applies")
    source = source.replace(old, new)
    language_old = '''    if service == "sonarr":
        languages = _items(client.request("GET", "/languageprofile"))
        result["languageProfiles"] = [
            {"id": identity, "name": name}
            for item in languages[:MAX_RESULTS]
            if (identity := _positive_integer(item.get("id"))) is not None
            and (name := _text(item.get("name"))) is not None
        ]
'''
    if language_old not in source or source.count(language_old) != 1: raise ValueError("shared language profile patch no longer applies")
    source = source.replace(language_old, "")
    queue_old = '        params={"page": 1, "pageSize": 100, f"include{resource.title()}": True},'
    queue_new = '        params={"page": 1, "pageSize": 1000, f"include{resource.title()}": True},'
    if queue_old not in source or source.count(queue_old) != 1: raise ValueError("shared queue pagination patch no longer applies")
    source = source.replace(queue_old, queue_new).replace("for item in _items(raw_records)[:100]:", "for item in _items(raw_records)[:1000]:")
    path.write_text(source)
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
    for entry in files:
        if entry["path"] == "media_restricted.py": entry["sha256"] = digest(path)

def update(root: Path) -> None:
    rev, files = entries(root)
    with tempfile.TemporaryDirectory(dir=ROOT / "worker") as directory:
        staged = Path(directory)
        for entry in files:
            destination = staged / ("skills" if entry["path"].endswith("SKILL.md") else "media/upstream") / (entry["path"] if entry["path"].endswith("SKILL.md") else Path(entry["path"]).name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / entry["sourcePath"], destination)
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
