#!/usr/bin/env python3
"""Issue, verify, install, and trust the dedicated Voidstation LAN CA."""

import argparse
import ctypes
import fcntl
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time

MIN_LEAF_SECONDS = 30 * 24 * 60 * 60
LEAF_SECONDS = 365 * 24 * 60 * 60
DEFAULT_STATE = Path.home() / ".local/share/voidstation-lan-ca"
DEFAULT_DESTINATION = Path("/var/lib/voidstation/lan-tls")
REPOSITORY = Path(__file__).resolve().parent.parent


class CertificateError(RuntimeError):
    pass


def fail(message):
    raise CertificateError(message)


def run_openssl(arguments, description, input_bytes=None, capture=True):
    """Run OpenSSL without exposing stdin data in argv, environment, or errors."""
    try:
        result = subprocess.run(
            ["openssl", *arguments],
            input=input_bytes,
            stdin=subprocess.DEVNULL if input_bytes is None else None,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        fail(f"OpenSSL {description} could not start: {error.strerror}.")
    if result.returncode:
        # OpenSSL may repeat file names or implementation-specific diagnostics.
        # None is useful to the owner here, and it must never echo a passphrase.
        fail(f"OpenSSL {description} failed.")
    return result.stdout if capture else b""


def private_key_material(path):
    try:
        contents = path.read_bytes()
    except OSError as error:
        fail(f"Cannot read {path.name}: {error.strerror}.")
    return b"PRIVATE KEY-----" in contents


def parse_ip(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        fail("IP must be an IPv4 address.")
    if not address.is_private or address.is_loopback or address.is_link_local:
        fail("IP must be an RFC1918 IPv4 address.")
    # IPv4Address.is_private includes ranges other than RFC1918.
    if not any(address in ipaddress.IPv4Network(network) for network in
               ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
        fail("IP must be an RFC1918 IPv4 address.")
    return str(address)


def no_symlink_directory(path, description, create=False, mode=0o700, owner=None):
    """Create/check a directory after checking every existing ancestor."""
    path = Path(path)
    if not path.is_absolute():
        fail(f"{description} must be an absolute path.")
    parts = path.parts
    current = Path(parts[0])
    for component in parts[1:]:
        current /= component
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if not create:
                fail(f"{description} is absent.")
            try:
                os.mkdir(current, mode if current == path else 0o700)
            except FileExistsError:
                pass
            info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            fail(f"{description} must not contain symbolic links or non-directories.")
        # /tmp is a root-owned sticky directory. Its sticky bit prevents another
        # user replacing a name they do not own, which keeps test state usable too.
        unsafe = info.st_mode & 0o022 and not (
            info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        )
        if unsafe:
            fail(f"{description} has a group- or world-writable ancestor.")
        if owner is not None and current == path and info.st_uid != owner:
            fail(f"{description} must be owned by UID {owner}.")
    try:
        resolved = Path(os.path.realpath(path))
    except OSError:
        fail(f"{description} cannot be resolved.")
    if resolved != path:
        fail(f"{description} must not resolve through a symbolic link.")
    return path


def checked_regular(path, description):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        fail(f"{description} is absent.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail(f"{description} must be a regular non-symbolic-link file.")
    return info


def state_directory(value):
    state = Path(value).expanduser()
    if not state.is_absolute():
        state = Path.cwd() / state
    state = Path(os.path.normpath(state))
    if state == REPOSITORY or REPOSITORY in state.parents or state in REPOSITORY.parents:
        fail("State directory must be outside, and not contain, the application repository.")
    no_symlink_directory(state, "State directory", create=True, mode=0o700,
                         owner=os.geteuid())
    os.chmod(state, 0o700)
    if stat.S_IMODE(os.lstat(state).st_mode) != 0o700:
        fail("State directory must have mode 0700.")
    return state


def locked_state(state):
    lock_path = state / ".lock"
    checked_regular_or_create(lock_path, 0o600)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def checked_regular_or_create(path, mode):
    try:
        checked_regular(path, path.name)
    except CertificateError as error:
        if "is absent" not in str(error):
            raise
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        os.close(descriptor)


def read_passphrase(fd, new_ca):
    if fd is not None:
        if fd < 3:
            fail("--passphrase-fd must name an inherited descriptor of at least 3.")
        chunks = []
        remaining = 4097
        try:
            while remaining:
                chunk = os.read(fd, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        except OSError as error:
            fail(f"Cannot read --passphrase-fd: {error.strerror}.")
        value = b"".join(chunks)
        if len(value) > 4096:
            fail("CA passphrase from --passphrase-fd exceeds 4096 bytes.")
        if b"\n" in value or b"\r" in value:
            fail("CA passphrase from --passphrase-fd must not contain a newline.")
        if not value:
            fail("CA passphrase is empty.")
        return value
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        fail("CA passphrase requires a controlling terminal or --passphrase-fd.")
    first = getpass.getpass("LAN CA passphrase: ", stream=sys.stderr).encode()
    if new_ca:
        second = getpass.getpass("Confirm LAN CA passphrase: ", stream=sys.stderr).encode()
        if first != second:
            fail("CA passphrases did not match.")
    if not first:
        fail("CA passphrase is empty.")
    return first


def extension(path, name):
    return run_openssl(["x509", "-in", str(path), "-noout", "-ext", name],
                       f"reading {name}").decode(errors="replace")


def check_expiry(path, seconds, description):
    run_openssl(["x509", "-in", str(path), "-noout", "-checkend", str(seconds)],
                f"checking {description} expiry")


def public_key_from_certificate(path):
    return run_openssl(["x509", "-in", str(path), "-noout", "-pubkey"],
                       "reading certificate public key").strip()


def certificate_text(path):
    return run_openssl(["x509", "-in", str(path), "-noout", "-text"],
                       "reading certificate details").decode(errors="replace")


def require_rsa_size(path, bits, description):
    details = certificate_text(path)
    if "rsaEncryption" not in details or f"Public-Key: ({bits} bit)" not in details:
        fail(f"{description} must use an RSA-{bits} public key.")


def public_key_from_key(path):
    return run_openssl(["pkey", "-in", str(path), "-pubout"], "reading key public key").strip()


def public_key_from_encrypted_key(path, passphrase):
    checked_regular(path, "CA private key")
    try:
        encoded = path.read_bytes()
    except OSError as error:
        fail(f"Cannot read CA private key: {error.strerror}.")
    if b"-----BEGIN ENCRYPTED PRIVATE KEY-----" not in encoded:
        fail("CA private key must use encrypted PKCS#8 PEM.")
    return run_openssl(["pkey", "-in", str(path), "-passin", "stdin", "-pubout"],
                       "opening CA private key", passphrase).strip()


def fingerprint(path):
    der = run_openssl(["x509", "-in", str(path), "-outform", "DER"], "reading certificate")
    return "SHA256:" + hashlib.sha256(der).hexdigest().upper()


def validate_ca(ca, passphrase=None, minimum_lifetime=LEAF_SECONDS):
    checked_regular(ca, "CA certificate")
    if private_key_material(ca):
        fail("CA certificate must not contain private-key material.")
    if not re.fullmatch(rb"\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*", ca.read_bytes()):
        fail("CA file must contain exactly one PEM CA certificate.")
    constraints = extension(ca, "basicConstraints")
    usage = extension(ca, "keyUsage")
    if not ("CA:TRUE" in constraints.replace(" ", "") and "pathlen:0" in constraints.replace(" ", "")):
        fail("CA certificate must have CA:TRUE and pathlen:0.")
    if "Certificate Sign" not in usage:
        fail("CA certificate must permit certificate signing.")
    require_rsa_size(ca, 3072, "CA certificate")
    if minimum_lifetime is not None:
        check_expiry(ca, minimum_lifetime, "CA certificate")
    if passphrase is not None:
        if public_key_from_certificate(ca) != public_key_from_encrypted_key(ca.parent / "ca-key.pem", passphrase):
            fail("CA certificate and private key do not match.")


def validate_bundle(bundle, address, strict_expiry=True):
    bundle = Path(bundle)
    no_symlink_directory(bundle, "Bundle directory")
    try:
        names = sorted(item.name for item in bundle.iterdir())
    except OSError as error:
        fail(f"Cannot inspect bundle directory: {error.strerror}.")
    if names != ["ca.pem", "cert.pem", "key.pem"]:
        fail("Bundle directory must contain exactly cert.pem, key.pem, and ca.pem.")
    cert, key, ca = (bundle / "cert.pem", bundle / "key.pem", bundle / "ca.pem")
    for path, description in ((cert, "Leaf certificate"), (key, "Leaf key"), (ca, "CA certificate")):
        checked_regular(path, description)
    if private_key_material(cert) or private_key_material(ca):
        fail("Certificate and CA files must not contain private-key material.")
    validate_ca(ca, minimum_lifetime=LEAF_SECONDS if strict_expiry else None)
    constraints = extension(cert, "basicConstraints")
    usage = extension(cert, "extendedKeyUsage")
    if "CA:TRUE" in constraints.replace(" ", "") or "CA:FALSE" not in constraints.replace(" ", ""):
        fail("Leaf certificate must have CA:FALSE.")
    if "TLS Web Server Authentication" not in usage:
        fail("Leaf certificate must permit server authentication.")
    require_rsa_size(cert, 2048, "Leaf certificate")
    verify_arguments = ["verify"]
    if not strict_expiry:
        verify_arguments.append("-no_check_time")
    verify_arguments.extend(["-CAfile", str(ca), "-purpose", "sslserver", "-verify_ip", address, str(cert)])
    run_openssl(verify_arguments, "verifying certificate chain and IP")
    if strict_expiry:
        check_expiry(cert, MIN_LEAF_SECONDS, "leaf certificate")
    if public_key_from_certificate(cert) != public_key_from_key(key):
        fail("Leaf certificate and key do not match.")
    return fingerprint(ca)


def atomic_write(path, contents, mode):
    temporary = path.parent / f".{path.name}.{secrets.token_hex(8)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def create_ca(state, passphrase):
    temporary = Path(tempfile.mkdtemp(prefix=".ca-", dir=state))
    try:
        key, certificate = temporary / "ca-key.pem", temporary / "ca.pem"
        run_openssl(["genpkey", "-algorithm", "RSA", "-aes-256-cbc", "-pass", "stdin",
                     "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(key)], "creating CA key", passphrase)
        run_openssl(["req", "-new", "-x509", "-sha256", "-days", "3650", "-key", str(key),
                     "-passin", "stdin", "-out", str(certificate), "-subj", "/CN=Voidstation production LAN CA",
                     "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                     "-addext", "keyUsage=critical,keyCertSign,cRLSign"], "creating CA certificate", passphrase)
        os.chmod(key, 0o600)
        os.chmod(certificate, 0o644)
        validate_ca(certificate, passphrase)
        target = state / "ca"
        if target.exists():
            fail("CA state appeared during issuance; retry.")
        os.replace(temporary, target)
        temporary = None
        return target
    finally:
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)


def issue(arguments):
    if os.geteuid() == 0:
        fail("Issuing requires a normal non-root user.")
    address = parse_ip(arguments.ip)
    state = state_directory(arguments.state_dir)
    lock = locked_state(state)
    try:
        pin = state / "ip"
        ca_dir = state / "ca"
        if ca_dir.exists() or ca_dir.is_symlink():
            no_symlink_directory(ca_dir, "CA state")
            key, certificate = ca_dir / "ca-key.pem", ca_dir / "ca.pem"
            checked_regular(key, "CA private key")
            checked_regular(certificate, "CA certificate")
            passphrase = read_passphrase(arguments.passphrase_fd, False)
            validate_ca(certificate, passphrase)
            if not pin.exists():
                fail("Existing CA state has no pinned IP; refusing to guess.")
            checked_regular(pin, "Pinned IP")
            if pin.read_text(encoding="ascii").strip() != address:
                fail("IP differs from this CA state's pinned IP.")
        else:
            if any(entry.name != ".lock" for entry in state.iterdir()):
                fail("CA state is incomplete; refusing to regenerate it.")
            passphrase = read_passphrase(arguments.passphrase_fd, True)
            ca_dir = create_ca(state, passphrase)
            atomic_write(pin, (address + "\n").encode(), 0o600)
        publish_bundle(state, ca_dir, address, passphrase)
    finally:
        os.close(lock)


def publish_bundle(state, ca_dir, address, passphrase):
    bundles = state / "bundles"
    no_symlink_directory(bundles, "Bundle state", create=True, mode=0o700, owner=os.geteuid())
    temporary = Path(tempfile.mkdtemp(prefix=".bundle-", dir=bundles))
    try:
        key, csr, cert, extension_file, serial = (temporary / "key.pem", temporary / "server.csr",
                                                   temporary / "cert.pem", temporary / "server.ext", temporary / "serial")
        ca = ca_dir / "ca.pem"
        run_openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key)],
                    "creating leaf key")
        run_openssl(["req", "-new", "-key", str(key), "-out", str(csr), "-subj", "/CN=Voidstation LAN"],
                    "creating leaf request")
        extension_file.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:" + address + "\n", encoding="ascii")
        run_openssl(["x509", "-req", "-sha256", "-days", "365", "-in", str(csr), "-CA", str(ca),
                     "-CAkey", str(ca_dir / "ca-key.pem"), "-passin", "stdin", "-CAserial", str(serial),
                     "-CAcreateserial", "-extfile", str(extension_file), "-out", str(cert)],
                    "signing leaf certificate", passphrase)
        for unwanted in (csr, extension_file, serial):
            unwanted.unlink(missing_ok=True)
        os.chmod(key, 0o600)
        os.chmod(cert, 0o644)
        shutil.copyfile(ca, temporary / "ca.pem")
        os.chmod(temporary / "ca.pem", 0o644)
        validate_bundle(temporary, address)
        identifier = f"{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(8)}"
        destination = bundles / identifier
        os.replace(temporary, destination)
        temporary = None
        public = state / "public"
        no_symlink_directory(public, "Public certificate directory", create=True, mode=0o700, owner=os.geteuid())
        atomic_write(public / "ca.pem", ca.read_bytes(), 0o644)
        der = run_openssl(["x509", "-in", str(ca), "-outform", "DER"], "converting Android certificate")
        atomic_write(public / "voidstation-ca.crt", der, 0o644)
        print(json.dumps({"bundle": str(destination), "ca_certificate": str(public / "ca.pem"),
                          "android_certificate": str(public / "voidstation-ca.crt"), "fingerprint": fingerprint(ca)}, separators=(",", ":")))
    finally:
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)


def destination_path(value):
    destination = Path(value)
    if not destination.is_absolute() or destination != Path(os.path.normpath(destination)):
        fail("Destination must be a normalized absolute path.")
    if destination == REPOSITORY or REPOSITORY in destination.parents:
        fail("Destination must not be in the application repository.")
    forbidden = (Path("/var/lib/voidstation"), Path("/var/lib/voidstation/conversations"),
                 Path("/var/lib/voidstation/credentials"))
    if destination in forbidden or any(destination in path.parents for path in forbidden):
        fail("Destination must not be an auth or worker-state directory.")
    if destination.name != "lan-tls":
        fail("Destination must be a dedicated lan-tls directory.")
    return destination


def trusted_destination_parent(destination):
    parent = destination.parent
    # Do not create deployment paths. The server administrator must provision
    # root-owned ancestors before this owner-authorized install.
    no_symlink_directory(parent, "Destination parent", owner=0)
    current = Path("/")
    for part in parent.parts[1:]:
        current /= part
        info = os.lstat(current)
        if info.st_uid != 0 or info.st_mode & 0o022:
            fail("Destination ancestors must be root-owned and not writable by group or others.")
    return parent


def rename_exchange(source, destination):
    # Linux renameat2 is the only way to replace an active bind-mounted directory
    # without a missing path or a mixed certificate/key pair.
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        fail("Linux renameat2 is required to replace an existing TLS directory.")
    result = renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 2)
    if result != 0:
        error = ctypes.get_errno()
        fail(f"Atomic TLS directory exchange failed: {os.strerror(error)}.")


def open_directory_no_follow(path, description):
    path = Path(path)
    if not path.is_absolute() or path != Path(os.path.normpath(path)):
        fail(f"{description} must be a normalized absolute path.")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
    except OSError as error:
        os.close(descriptor)
        fail(f"{description} cannot be opened without following symbolic links: {error.strerror}.")
    return descriptor


def copy_bundle_snapshot(bundle, staging):
    """Copy exactly three files from directory/file descriptors into private staging."""
    descriptor = open_directory_no_follow(bundle, "Bundle directory")
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            fail("Bundle directory must be a directory.")
        names = sorted(os.listdir(descriptor))
        if names != ["ca.pem", "cert.pem", "key.pem"]:
            fail("Bundle directory must contain exactly cert.pem, key.pem, and ca.pem.")
        for name in names:
            source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            try:
                if not stat.S_ISREG(os.fstat(source).st_mode):
                    fail(f"Bundle {name} must be a regular non-symbolic-link file.")
                target = os.open(staging / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    while True:
                        chunk = os.read(source, 1024 * 1024)
                        if not chunk:
                            break
                        remaining = memoryview(chunk)
                        while remaining:
                            written = os.write(target, remaining)
                            if written <= 0:
                                fail("Cannot copy bundle snapshot safely.")
                            remaining = remaining[written:]
                    os.fsync(target)
                finally:
                    os.close(target)
            finally:
                os.close(source)
    except OSError as error:
        fail(f"Cannot copy bundle snapshot safely: {error.strerror}.")
    finally:
        os.close(descriptor)


def require_owner_mode(path, uid, gid, mode, description, directory=False):
    try:
        info = os.lstat(path)
    except OSError as error:
        fail(f"Cannot inspect {description}: {error.strerror}.")
    expected_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if stat.S_ISLNK(info.st_mode) or not expected_type:
        fail(f"{description} must be a regular non-symbolic-link {'directory' if directory else 'file'}.")
    if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        fail(f"{description} must be owned by UID/GID {uid}/{gid} with mode {mode:04o}.")


def validate_installed_bundle(destination, address):
    require_owner_mode(destination, 0, 1000, 0o750, "Destination directory", directory=True)
    require_owner_mode(destination / "cert.pem", 0, 1000, 0o644, "Installed leaf certificate")
    require_owner_mode(destination / "ca.pem", 0, 1000, 0o644, "Installed CA certificate")
    require_owner_mode(destination / "key.pem", 1000, 1000, 0o600, "Installed leaf key")
    return validate_bundle(destination, address, strict_expiry=False)


def locked_install_parent(parent):
    lock_path = parent / ".lan-tls.install.lock"
    try:
        info = os.lstat(lock_path)
    except FileNotFoundError:
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    else:
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            fail("Install lock must be a regular non-symbolic-link file.")
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
            fail("Install lock must be owned by root with mode 0600.")
        descriptor = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def install(arguments):
    address = parse_ip(arguments.ip)
    bundle = Path(arguments.bundle)
    if arguments.check_only:
        candidate_fingerprint = validate_bundle(bundle, address)
        print(json.dumps({"bundle": str(bundle), "fingerprint": candidate_fingerprint}, separators=(",", ":")))
        return
    destination = destination_path(arguments.destination)
    if os.geteuid() != 0:
        fail("Installing requires root. Use install --check-only to verify without writes.")
    parent = trusted_destination_parent(destination)
    lock = locked_install_parent(parent)
    temporary = None
    try:
        existing = destination.exists() or destination.is_symlink()
        backup = None
        if existing:
            no_symlink_directory(destination, "Destination")
            try:
                existing_fingerprint = validate_installed_bundle(destination, address)
            except CertificateError as error:
                fail(f"Existing destination is not a valid LAN bundle: {error}")
        prefix = ".lan-tls.previous-" if existing else ".lan-tls.new-"
        temporary = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
        os.chmod(temporary, 0o700)
        copy_bundle_snapshot(bundle, temporary)
        # The snapshot stays root-only until all cryptographic checks pass.
        candidate_fingerprint = validate_bundle(temporary, address, strict_expiry=True)
        if existing:
            if all((destination / name).read_bytes() == (temporary / name).read_bytes()
                   for name in ("cert.pem", "key.pem", "ca.pem")):
                print(json.dumps({"destination": str(destination), "fingerprint": candidate_fingerprint,
                                  "installed": False, "backup": None}, separators=(",", ":")))
                print("No restart was performed. After owner approval, run ./deploy.sh; it force-recreates the dashboard to load TLS files.", file=sys.stderr)
                return
            if existing_fingerprint != candidate_fingerprint and not arguments.replace_ca:
                fail(f"CA replacement refused. Existing fingerprint {existing_fingerprint}; candidate fingerprint {candidate_fingerprint}. Review both, then rerun with --replace-ca.")
        os.chown(temporary, 0, 1000)
        os.chmod(temporary, 0o750)
        for name in ("cert.pem", "ca.pem"):
            os.chown(temporary / name, 0, 1000)
            os.chmod(temporary / name, 0o644)
        os.chown(temporary / "key.pem", 1000, 1000)
        os.chmod(temporary / "key.pem", 0o600)
        if existing:
            # temporary's preselected name becomes the preserved old directory.
            rename_exchange(temporary, destination)
            backup = temporary
            temporary = None
        else:
            os.replace(temporary, destination)
            temporary = None
        print(json.dumps({"destination": str(destination), "fingerprint": candidate_fingerprint,
                          "installed": True, "backup": str(backup) if backup else None}, separators=(",", ":")))
        print("No restart was performed. After owner approval, run ./deploy.sh; it force-recreates the dashboard to load TLS files.", file=sys.stderr)
    finally:
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)
        os.close(lock)


def verify(arguments):
    address = parse_ip(arguments.ip)
    value = validate_bundle(Path(arguments.bundle), address)
    print(json.dumps({"bundle": str(Path(arguments.bundle)), "fingerprint": value}, separators=(",", ":")))


def normalized_fingerprint(value):
    text = value.strip().upper().replace("SHA256 FINGERPRINT=", "SHA256:").replace("SHA256=", "SHA256:")
    if text.startswith("SHA256:") and len(text[7:]) == 64 and all(char in "0123456789ABCDEF" for char in text[7:]):
        return text
    fail("Fingerprint must use SHA256: followed by 64 hexadecimal characters.")


def trust_arch(arguments):
    if os.geteuid() == 0:
        fail("trust-arch requires a normal user; it invokes sudo only after confirmation.")
    ca = Path(arguments.ca)
    # sudo must import the same bytes we validated, not a source file that can
    # change while the owner reads the prompt or enters their sudo password.
    with tempfile.TemporaryDirectory(prefix="voidstation-trust-") as temporary:
        snapshot = Path(temporary) / "ca.pem"
        try:
            descriptor = os.open(ca, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    fail("CA certificate must be a regular file.")
                contents = source.read(131073)
        except OSError as error:
            fail(f"Cannot read CA certificate: {error.strerror}.")
        if len(contents) > 131072:
            fail("CA certificate exceeds the size limit.")
        atomic_write(snapshot, contents, 0o600)
        validate_ca(snapshot, minimum_lifetime=MIN_LEAF_SECONDS)
        actual = fingerprint(snapshot)
        if actual != normalized_fingerprint(arguments.fingerprint):
            fail("CA fingerprint does not match the trusted-channel fingerprint.")
        if not shutil.which("trust"):
            fail("trust was not found. Run trust-arch on an Arch system with p11-kit installed.")
        if not arguments.yes:
            try:
                with open("/dev/tty", "r+", encoding="utf8") as terminal:
                    terminal.write(f"Trust {actual} system-wide? Type yes to continue: ")
                    terminal.flush()
                    if terminal.readline().strip().lower() != "yes":
                        fail("Trust installation cancelled.")
            except OSError:
                fail("Trust installation requires a controlling terminal; use --yes only after owner review.")
        try:
            result = subprocess.run(["sudo", "trust", "anchor", "--store", str(snapshot)], check=False)
        except OSError as error:
            fail(f"Cannot start sudo trust anchor: {error.strerror}.")
        if result.returncode:
            fail("sudo trust anchor failed.")
        print(json.dumps({"ca_certificate": str(ca), "fingerprint": actual, "trusted": True}, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    issue_parser = commands.add_parser("issue")
    issue_parser.add_argument("--ip", required=True)
    issue_parser.add_argument("--state-dir", default=str(DEFAULT_STATE))
    issue_parser.add_argument("--passphrase-fd", type=int)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--ip", required=True)
    install_parser.add_argument("--bundle", required=True)
    install_parser.add_argument("--destination", default=str(DEFAULT_DESTINATION))
    install_parser.add_argument("--replace-ca", action="store_true")
    install_parser.add_argument("--check-only", action="store_true")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--ip", required=True)
    verify_parser.add_argument("--bundle", required=True)
    trust_parser = commands.add_parser("trust-arch")
    trust_parser.add_argument("--ca", required=True)
    trust_parser.add_argument("--fingerprint", required=True)
    trust_parser.add_argument("--yes", action="store_true")
    arguments = parser.parse_args()
    try:
        {"issue": issue, "install": install, "verify": verify, "trust-arch": trust_arch}[arguments.command](arguments)
    except CertificateError as error:
        print(f"lan-certificates: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
