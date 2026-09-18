# Packaged media integration contract

The worker image packages the fixed media adapters at these paths:

- `/app/media/upstream/radarr.py`
- `/app/media/upstream/sonarr.py`
- `/app/media/upstream/media_restricted.py`
- `/app/media/requirements.txt`

`requirements.txt` pins `requests` with an exact `==` version. The adapters expose only the restricted JSON commands used by the four media tools. There are no Radarr or Sonarr agent skills in the worker image.

The restricted executor invokes Python without a shell. It constructs these command families with validated arguments:

```text
python3 /app/media/upstream/radarr.py restricted find|details|configuration|status|configure|search ...
python3 /app/media/upstream/sonarr.py restricted find|details|configuration|status|configure|search ...
```

The executor supplies the selected endpoint and API key through its child environment only. It does not add arbitrary arguments, scripts, URLs, methods, or payloads. Image packaging leaves `/app/media` unwritable by UID/GID 1000. Runtime inspection checks these adapters, Python, and the pinned `requests` installation.
