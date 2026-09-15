import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";

const workspaces: string[] = [];
const cli = ["python3", "scripts/lan-certificates.py"];
const passphrase = "synthetic test passphrase";
const ip = "192.168.50.10";

type Result = { code: number; stdout: string; stderr: string };
type Issue = { bundle: string; ca_certificate: string; android_certificate: string; fingerprint: string };

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-lan-certificates-"));
  workspaces.push(directory);
  return directory;
}

function run(args: string[], options: { passphrase?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], {
      cwd: process.cwd(),
      timeout: 10_000,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", options.passphrase === undefined ? "ignore" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    (child.stdout as Readable).on("data", (chunk) => { stdout += chunk; });
    (child.stderr as Readable).on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.passphrase !== undefined) {
      const secret = child.stdio[3] as Writable;
      secret.on("error", (error: NodeJS.ErrnoException) => {
        // Validation may reject the request before it reads the secret pipe.
        if (error.code !== "EPIPE" && error.code !== "ECONNRESET") reject(error);
      });
      secret.write(options.passphrase);
      secret.end();
    }
  });
}

async function issue(state: string, secret = passphrase): Promise<{ result: Result; value?: Issue }> {
  const result = await run(["issue", "--ip", ip, "--state-dir", state, "--passphrase-fd", "3"], { passphrase: secret });
  return { result, value: result.code === 0 ? JSON.parse(result.stdout) : undefined };
}

async function copyBundle(bundle: string, target: string) {
  await cp(bundle, target, { recursive: true });
  return target;
}

async function rootBoundarySandbox(directory: string) {
  const shim = join(directory, "root-boundary");
  await mkdir(shim, { recursive: true });
  await writeFile(join(shim, "sitecustomize.py"), `import os
_original_lstat = os.lstat
class Metadata:
    def __init__(self, value, path): self.value, self.path = value, os.fspath(path)
    def __getattr__(self, name): return getattr(self.value, name)
    @property
    def st_mode(self): return self.value.st_mode & ~0o022
    @property
    def st_uid(self): return 1000 if self.path.endswith('/key.pem') else 0
    @property
    def st_gid(self): return 0 if self.path.endswith('.install.lock') else 1000
def lstat(path, *args, **kwargs): return Metadata(_original_lstat(path, *args, **kwargs), path)
os.lstat = lstat
os.geteuid = lambda: 0
os.chown = lambda *args, **kwargs: None
`);
  return shim;
}

async function rootInstall(directory: string, args: string[]) {
  const shim = await rootBoundarySandbox(directory);
  return run(args, {
    env: { ...process.env, PYTHONPATH: `${shim}${process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : ""}` },
  });
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("issues a real encrypted CA and a fresh, verifiable leaf on renewal through the CLI", async () => {
  const directory = await workspace();
  const state = join(directory, "state");
  const first = await issue(state);
  expect(first.result).toMatchObject({ code: 0, stderr: "" });
  expect(first.result.stdout).not.toContain(passphrase);
  const one = first.value!;
  expect(one.fingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
  expect(await readdir(one.bundle)).toEqual(["ca.pem", "cert.pem", "key.pem"]);
  expect(await readdir(join(state, "ca"))).toEqual(["ca-key.pem", "ca.pem"]);
  expect(existsSync(one.android_certificate)).toBe(true);
  expect((await run(["verify", "--ip", ip, "--bundle", one.bundle])).code).toBe(0);

  const second = await issue(state);
  expect(second.result.code).toBe(0);
  const two = second.value!;
  expect(two.bundle).not.toBe(one.bundle);
  expect(two.fingerprint).toBe(one.fingerprint);
  expect(await readFile(join(one.bundle, "cert.pem"))).not.toEqual(await readFile(join(two.bundle, "cert.pem")));
  expect(await readFile(join(state, "ca", "ca.pem"))).toEqual(await readFile(one.ca_certificate));
});

it("keeps the existing CA and releases unchanged after a wrong passphrase or pinned-IP request", async () => {
  const directory = await workspace();
  const state = join(directory, "state");
  const created = (await issue(state)).value!;
  const beforeCa = await readFile(join(state, "ca", "ca.pem"));
  const beforeBundles = await readdir(join(state, "bundles"));

  const wrongPassword = await issue(state, "wrong synthetic passphrase");
  expect(wrongPassword.result.code).toBe(1);
  expect(wrongPassword.result.stderr).toContain("opening CA private key failed");
  expect(wrongPassword.result.stdout + wrongPassword.result.stderr).not.toContain(passphrase);

  const wrongIp = await run(["issue", "--ip", "192.168.50.11", "--state-dir", state, "--passphrase-fd", "3"], { passphrase });
  expect(wrongIp.code).toBe(1);
  expect(wrongIp.stderr).toContain("pinned IP");
  expect(await readFile(join(state, "ca", "ca.pem"))).toEqual(beforeCa);
  expect(await readdir(join(state, "bundles"))).toEqual(beforeBundles);
  expect(created.bundle).toBeTruthy();
});

it("does not silently create a new trust identity when the CA and IP pin are missing from existing state", async () => {
  const directory = await workspace();
  const state = join(directory, "state");
  await mkdir(join(state, "bundles"), { recursive: true, mode: 0o700 });
  const result = await issue(state);
  expect(result.result.code).toBe(1);
  expect(result.result.stderr).toContain("incomplete");
  expect(existsSync(join(state, "ca"))).toBe(false);
});

it("rejects newline-delimited passphrase descriptors and unencrypted existing CA keys", async () => {
  const directory = await workspace();
  const rejectedNewline = await issue(join(directory, "newline-state"), `${passphrase}\n`);
  expect(rejectedNewline.result.code).toBe(1);
  expect(rejectedNewline.result.stderr).toContain("must not contain a newline");
  expect(existsSync(join(directory, "newline-state", "ca"))).toBe(false);

  const state = join(directory, "state");
  await issue(state);
  execFileSync("openssl", ["pkey", "-in", join(state, "ca", "ca-key.pem"), "-passin", "stdin", "-out", join(state, "ca", "plain-key.pem")], {
    input: passphrase,
    stdio: ["pipe", "ignore", "ignore"],
  });
  await rm(join(state, "ca", "ca-key.pem"));
  await writeFile(join(state, "ca", "ca-key.pem"), await readFile(join(state, "ca", "plain-key.pem")), { mode: 0o600 });
  const unencrypted = await issue(state);
  expect(unencrypted.result.code).toBe(1);
  expect(unencrypted.result.stderr).toContain("encrypted PKCS#8 PEM");
});

it("rejects a mismatched key, an invalid CA, and symbolic-link bundle input through verify", async () => {
  const directory = await workspace();
  const value = (await issue(join(directory, "state"))).value!;
  const badKey = await copyBundle(value.bundle, join(directory, "bad-key"));
  await writeFile(join(badKey, "key.pem"), "not a private key\n");
  const keyResult = await run(["verify", "--ip", ip, "--bundle", badKey]);
  expect(keyResult.code).toBe(1);
  expect(keyResult.stderr).toContain("OpenSSL reading key public key failed");

  const badCa = await copyBundle(value.bundle, join(directory, "bad-ca"));
  await writeFile(join(badCa, "ca.pem"), "not a certificate\n");
  const caResult = await run(["verify", "--ip", ip, "--bundle", badCa]);
  expect(caResult.code).toBe(1);
  expect(caResult.stderr).toContain("exactly one PEM CA certificate");

  const linked = join(directory, "linked");
  await symlink(value.bundle, linked);
  const linkResult = await run(["verify", "--ip", ip, "--bundle", linked]);
  expect(linkResult.code).toBe(1);
  expect(linkResult.stderr).toContain("must not contain symbolic links");
});

it("requires root for writes while install --check-only verifies without writing", async () => {
  const directory = await workspace();
  const value = (await issue(join(directory, "state"))).value!;
  const destination = join(directory, "lan-tls");
  const checked = await run(["install", "--ip", ip, "--bundle", value.bundle, "--destination", destination, "--check-only"]);
  expect(checked.code).toBe(0);
  expect(existsSync(destination)).toBe(false);
  if (process.getuid?.() !== 0) {
    const install = await run(["install", "--ip", ip, "--bundle", value.bundle, "--destination", destination]);
    expect(install.code).toBe(1);
    expect(install.stderr).toContain("Installing requires root");
  }
  const broadDestination = await run(["install", "--ip", ip, "--bundle", value.bundle, "--destination", "/var/lib/voidstation"]);
  expect(broadDestination.code).toBe(1);
  expect(broadDestination.stderr).toContain("must not be an auth or worker-state directory");
});

it("replaces a near-expiry installed leaf from a descriptor-copied snapshot and preserves it as a backup", async () => {
  const directory = await workspace();
  const state = join(directory, "state");
  const old = (await issue(state)).value!;
  const renewal = (await issue(state)).value!;
  const destination = join(directory, "lan-tls");
  const installed = await rootInstall(directory, ["install", "--ip", ip, "--bundle", old.bundle, "--destination", destination]);
  expect(installed.code).toBe(0);

  const request = join(directory, "expiring.csr");
  const extensions = join(directory, "expiring.ext");
  const serial = join(directory, "expiring.serial");
  await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`);
  await writeFile(serial, "01\n");
  execFileSync("openssl", ["req", "-new", "-key", join(destination, "key.pem"), "-out", request, "-subj", "/CN=Voidstation LAN"]);
  execFileSync("openssl", ["x509", "-req", "-days", "1", "-in", request, "-CA", join(state, "ca", "ca.pem"),
    "-CAkey", join(state, "ca", "ca-key.pem"), "-passin", "stdin", "-CAserial", serial,
    "-extfile", extensions, "-out", join(destination, "cert.pem")], { input: passphrase, stdio: ["pipe", "ignore", "ignore"] });
  const expiringCertificate = await readFile(join(destination, "cert.pem"));

  const badCandidate = await copyBundle(renewal.bundle, join(directory, "bad-candidate"));
  await writeFile(join(badCandidate, "key.pem"), "not a private key\n");
  const rejected = await rootInstall(directory, ["install", "--ip", ip, "--bundle", badCandidate, "--destination", destination]);
  expect(rejected.code).toBe(1);
  expect(await readFile(join(destination, "cert.pem"))).toEqual(expiringCertificate);

  const replaced = await rootInstall(directory, ["install", "--ip", ip, "--bundle", renewal.bundle, "--destination", destination]);
  expect(replaced.code).toBe(0);
  const output = JSON.parse(replaced.stdout) as { backup: string; installed: boolean };
  expect(output.installed).toBe(true);
  expect(output.backup).toMatch(/\.lan-tls\.previous-/);
  expect(await readFile(join(output.backup, "cert.pem"))).toEqual(expiringCertificate);
  expect(await readFile(join(destination, "cert.pem"))).not.toEqual(expiringCertificate);
});

it("rejects a FIFO input to the root installer without waiting for a writer", async () => {
  const directory = await workspace();
  const value = (await issue(join(directory, "state"))).value!;
  const candidate = await copyBundle(value.bundle, join(directory, "fifo-bundle"));
  await rm(join(candidate, "key.pem"));
  execFileSync("mkfifo", [join(candidate, "key.pem")]);
  const result = await rootInstall(directory, ["install", "--ip", ip, "--bundle", candidate, "--destination", join(directory, "lan-tls")]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("regular");
  expect(existsSync(join(directory, "lan-tls"))).toBe(false);
});

it("checks a public CA fingerprint before using the explicitly requested trust command", async () => {
  if (process.getuid?.() === 0) return;
  const directory = await workspace();
  const value = (await issue(join(directory, "state"))).value!;
  const bin = join(directory, "bin");
  const audit = join(directory, "trust-arguments");
  await mkdir(bin);
  const originalCa = await readFile(value.ca_certificate);
  await writeFile(join(bin, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(audit)}\nprintf 'changed after validation' > ${JSON.stringify(value.ca_certificate)}\nexec "$@"\n`);
  await writeFile(join(bin, "trust"), `#!/bin/sh\ncp "$3" ${JSON.stringify(audit + ".pem")}\n`);
  await chmod(join(bin, "sudo"), 0o755);
  await chmod(join(bin, "trust"), 0o755);
  const trusted = await run(["trust-arch", "--ca", value.ca_certificate, "--fingerprint", value.fingerprint, "--yes"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(trusted.code).toBe(0);
  expect(await readFile(audit, "utf8")).toContain("trust anchor --store ");
  expect(await readFile(audit + ".pem")).toEqual(originalCa);
  await writeFile(value.ca_certificate, originalCa);
  const rejected = await run(["trust-arch", "--ca", value.ca_certificate, "--fingerprint", "SHA256:" + "0".repeat(64), "--yes"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("does not match");
});
