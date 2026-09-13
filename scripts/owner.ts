import { bootstrapOwner, recoverOwner } from "../src/lib/auth-store.ts";

const usage = "Usage: node scripts/owner.ts bootstrap|recover [--password-stdin]";

async function readPasswordFromStdin() {
  const bytes: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > 1_026) throw new Error("Password must be between 12 and 1024 bytes.");
    bytes.push(buffer);
  }
  let password = Buffer.concat(bytes).toString("utf8");
  if (password.endsWith("\n")) password = password.slice(0, -1);
  if (password.endsWith("\r")) password = password.slice(0, -1);
  return password;
}

async function readHiddenPassword() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Use --password-stdin when standard input is not a TTY.");
  }

  process.stdin.setRawMode(true);
  return await new Promise<string>((resolve, reject) => {
    const bytes: number[] = [];
    const done = (callback: () => void) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          done(() => reject(new Error("Password entry cancelled.")));
          return;
        }
        if (byte === 10 || byte === 13) {
          done(() => resolve(Buffer.from(bytes).toString("utf8")));
          return;
        }
        if (byte === 8 || byte === 127) {
          bytes.pop();
          continue;
        }
        if (bytes.length >= 1_026) {
          done(() => reject(new Error("Password must be between 12 and 1024 bytes.")));
          return;
        }
        bytes.push(byte);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
    process.stdout.write("Password: ");
  });
}

async function main() {
  const [command, option, ...rest] = process.argv.slice(2);
  if ((command !== "bootstrap" && command !== "recover") || rest.length > 0 || (option !== undefined && option !== "--password-stdin")) {
    throw new Error(usage);
  }

  const password = option === "--password-stdin" ? await readPasswordFromStdin() : await readHiddenPassword();
  const result = command === "bootstrap" ? await bootstrapOwner(password) : await recoverOwner(password);
  if (result === "created") {
    process.stdout.write("Owner account bootstrapped.\n");
    return;
  }
  if (result === "recovered") {
    process.stdout.write("Owner account recovered. Existing sessions were revoked.\n");
    return;
  }
  if (result === "exists") throw new Error("Owner account already exists. Use recover to replace its password.");
  if (result === "missing") throw new Error("Owner account does not exist. Use bootstrap first.");
  throw new Error("Password must be between 12 and 1024 bytes.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error && error.message === "VOIDSTATION_AUTH_DB must be configured"
    ? error.message
    : error instanceof Error && (error.message === usage || error.message.startsWith("Password") || error.message.startsWith("Use --password") || error.message.startsWith("Owner account"))
      ? error.message
      : "Owner account command failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
