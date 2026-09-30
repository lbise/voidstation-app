#!/usr/bin/python3 -I
"""Write the Voidstation host-status file for the Dashboard.

Runs as root from voidstation-host-status.service on a timer. It collects the
facts the unprivileged Dashboard container cannot read itself: whether Ubuntu
wants a reboot, how many package updates are pending, and SMART drive health.
The result is one small JSON file, replaced atomically, that the Dashboard
reads through a read-only bind mount. The helper never runs `apt update`,
never wakes a sleeping drive, and uses only the Python standard library.
"""

import datetime
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

OUTPUT_DIRECTORY = os.environ.get(
    "VOIDSTATION_HOST_STATUS_DIRECTORY", "/var/lib/voidstation/host-status"
)
OUTPUT_NAME = "status.json"
REBOOT_REQUIRED_FILE = "/run/reboot-required"
REBOOT_PACKAGES_FILE = "/run/reboot-required.pkgs"
APT_CHECK = "/usr/lib/update-notifier/apt-check"

MAX_OUTPUT_BYTES = 64 * 1024
MAX_REBOOT_PACKAGES = 20
MAX_DRIVES = 32
MAX_MODEL_LENGTH = 128
MAX_SAFE_INTEGER = 2**53 - 1
APT_CHECK_TIMEOUT = 120
SMARTCTL_TIMEOUT = 30

PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+.:~_-]{0,127}$")
DEVICE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:,/-]{0,63}$")
DEVICE_PATH = re.compile(r"^/dev/[A-Za-z0-9][A-Za-z0-9_./-]{0,63}$")
DEVICE_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_,+-]{0,31}$")
STANDBY_MESSAGE = re.compile(r"\bin (?:STANDBY|SLEEP)\b", re.IGNORECASE)
LEADING_INTEGER = re.compile(r"^\s*(\d+)")

# smartctl exit-status bits. See smartctl(8), "RETURN VALUES".
EXIT_COMMAND_LINE = 1 << 0
EXIT_OPEN_FAILED = 1 << 1  # Also used for "-n standby" skips.


def now_iso():
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def count(value, maximum=MAX_SAFE_INTEGER):
    """Return a non-negative integer within bounds, or None."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= maximum else None


def temperature(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if -40 <= value <= 200 else None


def clean_model(value):
    if not isinstance(value, str):
        return None
    text = "".join(character for character in value if character.isprintable()).strip()
    return text[:MAX_MODEL_LENGTH] or None


def read_reboot_status(required_file, packages_file):
    required = os.path.exists(required_file)
    packages = []
    if required:
        try:
            with open(packages_file, encoding="utf-8", errors="replace") as source:
                lines = source.read(64 * 1024).splitlines()
        except OSError:
            lines = []
        for line in lines:
            name = line.strip()
            if PACKAGE_NAME.match(name) and name not in packages:
                packages.append(name)
            if len(packages) == MAX_REBOOT_PACKAGES:
                break
    return required, packages


def parse_apt_check(stderr):
    """apt-check prints "total;security" on stderr."""
    lines = [line.strip() for line in stderr.strip().splitlines() if line.strip()]
    if not lines:
        return None
    match = re.fullmatch(r"(\d+);(\d+)", lines[-1])
    if not match:
        return None
    total, security = count(int(match.group(1)), 1_000_000), count(int(match.group(2)), 1_000_000)
    if total is None or security is None or security > total:
        return None
    return {"total": total, "security": security}


def read_updates(apt_check):
    """Count pending updates from the existing package lists. Never runs apt update."""
    if not os.access(apt_check, os.X_OK):
        return None
    try:
        result = subprocess.run(
            [apt_check],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=APT_CHECK_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return parse_apt_check(result.stderr)


def parse_scan(data):
    """Map `smartctl --scan-open --json` to (device path, device type) pairs."""
    devices = []
    for entry in data.get("devices", []) if isinstance(data, dict) else []:
        if not isinstance(entry, dict):
            continue
        name, kind = entry.get("name"), entry.get("type")
        if not isinstance(name, str) or not DEVICE_PATH.match(name):
            continue
        if not isinstance(kind, str) or not DEVICE_TYPE.match(kind):
            kind = None
        if (name, kind) not in devices:
            devices.append((name, kind))
        if len(devices) == MAX_DRIVES:
            break
    return devices


def device_label(path, kind):
    label = path[len("/dev/"):]
    # RAID pass-through devices share a path; keep the member number distinct.
    if kind and "," in kind:
        label = f"{label}:{kind.split(',', 1)[1]}"
    label = label[:64]
    return label if DEVICE_NAME.match(label) else "unknown"


def is_standby(data, exit_status):
    if not exit_status & EXIT_OPEN_FAILED:
        return False
    if isinstance(data.get("power_mode"), str) and data["power_mode"].upper() in ("STANDBY", "SLEEP"):
        return True
    smartctl = data.get("smartctl")
    messages = smartctl.get("messages") if isinstance(smartctl, dict) else None
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(message, dict) and isinstance(message.get("string"), str)
        and STANDBY_MESSAGE.search(message["string"]) is not None
        for message in messages
    )


def ata_raw(data, attribute_id):
    table = data.get("ata_smart_attributes", {})
    rows = table.get("table", []) if isinstance(table, dict) else []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and row.get("id") == attribute_id:
            raw = row.get("raw")
            return raw if isinstance(raw, dict) else None
    return None


def ata_count(data, attribute_id):
    raw = ata_raw(data, attribute_id)
    return count(raw.get("value")) if raw else None


def ata_leading(data, attribute_id):
    """Temperature and power-on raw values pack extra fields; the string starts with the value."""
    raw = ata_raw(data, attribute_id)
    if not raw:
        return None
    match = LEADING_INTEGER.match(raw.get("string", "")) if isinstance(raw.get("string"), str) else None
    return int(match.group(1)) if match else None


def empty_drive(device, model=None, standby=False):
    return {
        "device": device,
        "model": model,
        "passed": None,
        "standby": standby,
        "temperatureCelsius": None,
        "powerOnHours": None,
        "reallocatedSectors": None,
        "pendingSectors": None,
        "mediaErrors": None,
        "percentageUsed": None,
    }


def map_drive(device, data, exit_status):
    """Map one `smartctl --json -n standby -H -A -i` result to the DriveHealth contract."""
    if not isinstance(data, dict):
        return empty_drive(device)
    model = clean_model(data.get("model_name") or data.get("scsi_model_name") or data.get("product"))
    if is_standby(data, exit_status):
        return empty_drive(device, model, standby=True)
    if exit_status & (EXIT_COMMAND_LINE | EXIT_OPEN_FAILED):
        return empty_drive(device, model)
    drive = empty_drive(device, model)
    smart_status = data.get("smart_status")
    if isinstance(smart_status, dict) and isinstance(smart_status.get("passed"), bool):
        drive["passed"] = smart_status["passed"]
    nvme = data.get("nvme_smart_health_information_log")
    nvme = nvme if isinstance(nvme, dict) else {}
    current = data.get("temperature", {}).get("current") if isinstance(data.get("temperature"), dict) else None
    for candidate in (current, nvme.get("temperature"), ata_leading(data, 194), ata_leading(data, 190)):
        if temperature(candidate) is not None:
            drive["temperatureCelsius"] = candidate
            break
    hours = data.get("power_on_time", {}).get("hours") if isinstance(data.get("power_on_time"), dict) else None
    for candidate in (hours, nvme.get("power_on_hours"), ata_leading(data, 9)):
        if count(candidate) is not None:
            drive["powerOnHours"] = candidate
            break
    if "ata_smart_attributes" in data:
        drive["reallocatedSectors"] = ata_count(data, 5)
        drive["pendingSectors"] = ata_count(data, 197)
    if nvme:
        drive["mediaErrors"] = count(nvme.get("media_errors"))
        drive["percentageUsed"] = count(nvme.get("percentage_used"), 255)
    return drive


def run_json(command, timeout=SMARTCTL_TIMEOUT):
    """Run a command and return (parsed JSON or None, exit status or None)."""
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None, None
    try:
        return json.loads(result.stdout[: 4 * 1024 * 1024] or b"null"), result.returncode
    except ValueError:
        return None, result.returncode


def read_drives(smartctl):
    """SMART summaries, or None when smartmontools is not installed or cannot scan."""
    if not smartctl:
        return None
    scan, _ = run_json([smartctl, "--scan-open", "--json"])
    if not isinstance(scan, dict):
        return None
    drives = []
    for path, kind in parse_scan(scan):
        command = [smartctl, "--json", "-n", "standby", "-H", "-A", "-i"]
        if kind:
            command += ["-d", kind]
        data, exit_status = run_json(command + [path])
        drives.append(map_drive(device_label(path, kind), data, exit_status if exit_status is not None else EXIT_COMMAND_LINE))
    return drives


def collect():
    reboot_required, reboot_packages = read_reboot_status(REBOOT_REQUIRED_FILE, REBOOT_PACKAGES_FILE)
    return {
        "version": 1,
        "checkedAt": now_iso(),
        "rebootRequired": reboot_required,
        "rebootPackages": reboot_packages,
        "updates": read_updates(APT_CHECK),
        "drives": read_drives(shutil.which("smartctl")),
    }


def encode(status):
    body = (json.dumps(status, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
    while len(body) > MAX_OUTPUT_BYTES and status["drives"]:
        status["drives"].pop()
        body = (json.dumps(status, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
    return body


def check_directory(directory):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"voidstation host status: {directory} must be a directory, not a link or file.")
    if os.geteuid() == 0 and info.st_uid != 0:
        raise SystemExit(f"voidstation host status: {directory} must be owned by root.")
    if info.st_mode & 0o022:
        raise SystemExit(f"voidstation host status: {directory} must not be group- or world-writable.")


def write_atomically(directory, body):
    check_directory(directory)
    descriptor, temporary = tempfile.mkstemp(prefix=".status.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o644)
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, os.path.join(directory, OUTPUT_NAME))
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def main():
    os.umask(0o022)
    status = collect()
    write_atomically(OUTPUT_DIRECTORY, encode(status))
    drives = status["drives"]
    print(
        "voidstation host status: "
        f"reboot={'yes' if status['rebootRequired'] else 'no'} "
        f"updates={'unknown' if status['updates'] is None else status['updates']['total']} "
        f"drives={'unavailable' if drives is None else len(drives)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
