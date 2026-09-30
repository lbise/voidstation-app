#!/usr/bin/env python3
"""Deterministic checks for scripts/host/voidstation-host-status.py.

Runs the helper's collection and atomic write in-process against fixture
smartctl JSON, a fake apt-check, and temporary reboot files. Nothing touches
real drives, apt, or /run. Prints the written status for the Vitest wrapper,
which then validates it with the Dashboard's own collector.
"""

import importlib.util
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "scripts" / "host" / "voidstation-host-status.py"

ATA_ACTIVE = {
    "json_format_version": [1, 0],
    "smartctl": {"version": [7, 4], "exit_status": 0},
    "device": {"name": "/dev/sda", "info_name": "/dev/sda [SAT]", "type": "sat", "protocol": "ATA"},
    "model_name": "WDC WD40EFRX-68N32N0",
    "serial_number": "WD-SECRET-SERIAL",
    "smart_status": {"passed": True},
    "ata_smart_attributes": {
        "revision": 16,
        "table": [
            {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"value": 0, "string": "0"}},
            {"id": 9, "name": "Power_On_Hours", "raw": {"value": 21000, "string": "21000"}},
            {"id": 194, "name": "Temperature_Celsius", "raw": {"value": 193274150946, "string": "34 (Min/Max 20/45)"}},
            {"id": 197, "name": "Current_Pending_Sector", "raw": {"value": 2, "string": "2"}},
        ],
    },
    "power_on_time": {"hours": 21000, "minutes": 12},
    "temperature": {"current": 34},
}
ATA_STANDBY = {
    "json_format_version": [1, 0],
    "smartctl": {
        "version": [7, 4],
        "messages": [{"string": "Device is in STANDBY mode, exit(2)", "severity": "information"}],
        "exit_status": 2,
    },
    "device": {"name": "/dev/sdb", "info_name": "/dev/sdb [SAT]", "type": "sat", "protocol": "ATA"},
}
NVME = {
    "json_format_version": [1, 0],
    "smartctl": {"version": [7, 4], "exit_status": 0},
    "device": {"name": "/dev/nvme0", "info_name": "/dev/nvme0", "type": "nvme", "protocol": "NVMe"},
    "model_name": "Samsung SSD 980 1TB",
    "serial_number": "S64ASECRET",
    "smart_status": {"passed": True, "nvme": {"value": 0}},
    "nvme_smart_health_information_log": {
        "critical_warning": 0,
        "temperature": 41,
        "available_spare": 100,
        "percentage_used": 7,
        "power_on_hours": 5000,
        "media_errors": 1,
    },
    "temperature": {"current": 41},
    "power_on_time": {"hours": 5000},
}
SCAN = {
    "json_format_version": [1, 0],
    "smartctl": {"version": [7, 4], "exit_status": 0},
    "devices": [
        {"name": "/dev/sda", "info_name": "/dev/sda [SAT]", "type": "sat", "protocol": "ATA"},
        {"name": "/dev/sdb", "info_name": "/dev/sdb [SAT]", "type": "sat", "protocol": "ATA"},
        {"name": "/dev/nvme0", "info_name": "/dev/nvme0", "type": "nvme", "protocol": "NVMe"},
        {"name": "/dev/sdc", "info_name": "/dev/sdc [SAT]", "type": "sat", "protocol": "ATA"},
        {"name": "../../etc/passwd", "type": "sat"},
        {"name": "/dev/sda", "type": "sat"},
    ],
}

FAKE_SMARTCTL = r"""#!/usr/bin/env python3
import json, os, sys
arguments = sys.argv[1:]
with open(os.environ["FAKE_SMARTCTL_LOG"], "a") as log:
    log.write(json.dumps(arguments) + "\n")
fixtures = json.load(open(os.environ["FAKE_SMARTCTL_FIXTURES"]))
if arguments == ["--scan-open", "--json"]:
    print(json.dumps(fixtures["scan"]))
    sys.exit(0)
device = arguments[-1]
if device == "/dev/sdc":
    # Open failure that is not a standby skip.
    print(json.dumps({"smartctl": {"messages": [{"string": "Smartctl open device: /dev/sdc failed: No such device", "severity": "error"}], "exit_status": 2}}))
    sys.exit(2)
data = fixtures[device]
print(json.dumps(data))
sys.exit(data["smartctl"]["exit_status"])
"""

FAKE_APT_CHECK = "#!/bin/sh\nprintf 'W: cache not writable\\n12;3' >&2\n"

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def load_helper():
    spec = importlib.util.spec_from_file_location("voidstation_host_status", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)
    return str(path)


def main():
    helper = load_helper()
    empty = {
        "passed": None, "temperatureCelsius": None, "powerOnHours": None, "reallocatedSectors": None,
        "pendingSectors": None, "mediaErrors": None, "percentageUsed": None,
    }

    # Pure mappings.
    check(helper.map_drive("sda", ATA_ACTIVE, 0) == {
        "device": "sda", "model": "WDC WD40EFRX-68N32N0", "passed": True, "standby": False,
        "temperatureCelsius": 34, "powerOnHours": 21000, "reallocatedSectors": 0, "pendingSectors": 2,
        "mediaErrors": None, "percentageUsed": None,
    }, "ATA drive mapping")
    without_summary = {key: value for key, value in ATA_ACTIVE.items() if key not in ("temperature", "power_on_time")}
    fallback = helper.map_drive("sda", without_summary, 0)
    check(fallback["temperatureCelsius"] == 34 and fallback["powerOnHours"] == 21000,
          "ATA attributes 194 and 9 are used when summaries are absent")
    check(helper.map_drive("sdb", ATA_STANDBY, 2) == {"device": "sdb", "model": None, "standby": True, **empty},
          "standby drive is reported without waking it")
    check(helper.map_drive("nvme0", NVME, 0) == {
        "device": "nvme0", "model": "Samsung SSD 980 1TB", "passed": True, "standby": False,
        "temperatureCelsius": 41, "powerOnHours": 5000, "reallocatedSectors": None, "pendingSectors": None,
        "mediaErrors": 1, "percentageUsed": 7,
    }, "NVMe drive mapping")
    failing = dict(NVME, smart_status={"passed": False})
    check(helper.map_drive("nvme0", failing, 8)["passed"] is False, "failing SMART status is kept")
    check(helper.map_drive("sdc", {"smartctl": {"exit_status": 2}}, 2) == {"device": "sdc", "model": None, "standby": False, **empty},
          "open failure is not reported as standby")
    check(helper.map_drive("sdd", None, 1)["passed"] is None, "unparseable output maps to nulls")
    hot = dict(ATA_ACTIVE, temperature={"current": 900})
    hot["ata_smart_attributes"] = {"table": []}
    check(helper.map_drive("sda", hot, 0)["temperatureCelsius"] is None, "implausible temperatures are dropped")
    check(helper.map_drive("sda", dict(ATA_ACTIVE, model_name="Evil\u0007\n" + "x" * 300), 0)["model"] == "Evil" + "x" * 124,
          "model names are stripped of control characters and truncated")
    check(helper.parse_scan(SCAN) == [("/dev/sda", "sat"), ("/dev/sdb", "sat"), ("/dev/nvme0", "nvme"), ("/dev/sdc", "sat")],
          "scan keeps unique /dev paths only")
    check(helper.device_label("/dev/bus/0", "megaraid,3") == "bus/0:3", "RAID members keep distinct labels")
    check(helper.parse_apt_check("12;3") == {"total": 12, "security": 3}, "apt-check counts")
    check(helper.parse_apt_check("W: something\n4;0\n") == {"total": 4, "security": 0}, "apt-check warnings are ignored")
    for text in ("", "E: failed", "3;4", "-1;0", "1;2;3"):
        check(helper.parse_apt_check(text) is None, "invalid apt-check output: " + repr(text))

    with tempfile.TemporaryDirectory(prefix="voidstation-host-status-") as temporary:
        workspace = Path(temporary)
        bin_directory = workspace / "bin"
        bin_directory.mkdir()
        fixtures = workspace / "fixtures.json"
        fixtures.write_text(json.dumps({"scan": SCAN, "/dev/sda": ATA_ACTIVE, "/dev/sdb": ATA_STANDBY, "/dev/nvme0": NVME}))
        log = workspace / "smartctl.log"
        os.environ.update(FAKE_SMARTCTL_LOG=str(log), FAKE_SMARTCTL_FIXTURES=str(fixtures))
        smartctl = executable(bin_directory / "smartctl", FAKE_SMARTCTL)
        reboot = workspace / "reboot-required"
        packages = workspace / "reboot-required.pkgs"
        reboot.write_text("*** System restart required ***\n")
        packages.write_text("linux-base\ndbus\nlinux-base\nbad name\n" + "".join(f"pkg{index}\n" for index in range(40)))

        required, names = helper.read_reboot_status(str(reboot), str(packages))
        check(required is True and names[:2] == ["linux-base", "dbus"] and len(names) == 20,
              "reboot packages are unique, valid, and capped at 20")
        check(helper.read_reboot_status(str(workspace / "absent"), str(packages)) == (False, []),
              "no reboot file means no reboot or packages")

        check(helper.read_updates(executable(bin_directory / "apt-check", FAKE_APT_CHECK)) == {"total": 12, "security": 3},
              "apt-check stderr is parsed")
        check(helper.read_updates(executable(bin_directory / "apt-fail", "#!/bin/sh\nexit 1\n")) is None,
              "failing apt-check reports unknown updates")
        check(helper.read_updates(str(workspace / "missing-apt-check")) is None, "missing apt-check reports unknown updates")
        check(helper.read_drives(None) is None, "missing smartctl reports unavailable drives")

        drives = helper.read_drives(smartctl)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        check(calls[0] == ["--scan-open", "--json"], "scan runs first")
        check(len(calls) == 5 and all(call[:3] == ["--json", "-n", "standby"] for call in calls[1:]),
              "every device query uses -n standby")
        check([drive["device"] for drive in drives] == ["sda", "sdb", "nvme0", "sdc"], "one entry per scanned drive")

        helper.OUTPUT_DIRECTORY = str(workspace / "host-status")
        helper.REBOOT_REQUIRED_FILE = str(reboot)
        helper.REBOOT_PACKAGES_FILE = str(packages)
        helper.APT_CHECK = str(bin_directory / "apt-check")
        os.environ["PATH"] = f"{bin_directory}:{os.environ['PATH']}"
        output = workspace / "host-status"
        output.mkdir(mode=0o755)
        output.chmod(0o775)
        try:
            helper.main()
            failures.append("group-writable output directory was accepted")
        except SystemExit as error:
            check("group- or world-writable" in str(error), "unsafe directory message")
        output.chmod(0o755)
        helper.main()
        status_file = output / "status.json"
        mode = stat.S_IMODE(status_file.stat().st_mode)
        check(mode == 0o644, f"status file mode is 0644, got {oct(mode)}")
        check(sorted(entry.name for entry in output.iterdir()) == ["status.json"], "no temporary files remain")
        text = status_file.read_text()
        check(len(text.encode()) <= 64 * 1024, "status file stays under 64 KiB")
        check("SECRET" not in text, "serial numbers are never written")
        status = json.loads(text)
        check(sorted(status) == ["checkedAt", "drives", "rebootPackages", "rebootRequired", "updates", "version"],
              "status keys")
        check(status["version"] == 1 and status["rebootRequired"] is True and status["updates"] == {"total": 12, "security": 3},
              "status values")
        helper.main()
        check(sorted(entry.name for entry in output.iterdir()) == ["status.json"], "re-running replaces the file")

    if failures:
        for failure in failures:
            print("FAIL: " + failure)
        return 1
    print("STATUS " + text.strip())
    print("PASS: host-status helper maps SMART, apt-check, and reboot facts without waking drives")
    return 0


if __name__ == "__main__":
    sys.exit(main())
