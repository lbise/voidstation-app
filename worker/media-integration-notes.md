# Packaged media integration contract

The worker image packages the approved media resources at these fixed paths:

- `/app/media/skills/radarr`
- `/app/media/skills/sonarr`
- `/app/media/upstream/radarr.py`
- `/app/media/upstream/sonarr.py`
- `/app/media/upstream/media_restricted.py`
- `/app/media/requirements.txt`

Each skill directory contains `SKILL.md` plus only its manifest-listed support files. The manifest records SHA-256 digests. `requirements.txt` pins `requests` with an exact `==` version. The packaging updater applies reviewed portability patches to the shared restricted sources: Sonarr `statistics.episodeFileCount` is projected to the status response's `hasFile` field, queue inspection is bounded to a fixed 1,000-item page, service responses are capped before JSON parsing, and unused language-profile discovery is omitted. These do not change the terminal CLI.

The restricted executor invokes Python without a shell. Its only process vectors are:

```text
python3 /app/media/upstream/radarr.py restricted lookup --term <query>
python3 /app/media/upstream/sonarr.py restricted lookup --term <query>
python3 /app/media/upstream/radarr.py restricted configuration
python3 /app/media/upstream/sonarr.py restricted configuration
python3 /app/media/upstream/radarr.py restricted status --id <positive integer>
python3 /app/media/upstream/sonarr.py restricted status --id <positive integer>
```

The executor supplies the selected endpoint and API key through its child environment only. It does not add arbitrary arguments, scripts, URLs, methods, or payloads. Image packaging must leave `/app/media` unreadable for writes by UID/GID 1000. The runtime inspection checks these paths, Python, and the pinned `requests` installation.
