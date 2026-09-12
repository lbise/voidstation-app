import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_MAX_AGE_SECONDS = 28800;

const PASSWORD_MINIMUM_BYTES = 12;
const PASSWORD_MAXIMUM_BYTES = 1_024;
const SESSION_LIMIT = 32;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_LENGTH = 43;
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;

let database: DatabaseSync | undefined;
let openedDatabasePath: string | undefined;

type Account = {
  password_hash: Uint8Array;
  salt: Uint8Array;
  revision: number;
};

type Session = { expires_at_ms: number };

type OwnerAccountResult = "created" | "exists" | "recovered" | "missing" | "invalid";

function configuredDatabasePath() {
  const path = process.env.VOIDSTATION_AUTH_DB;
  if (!path) throw new Error("VOIDSTATION_AUTH_DB must be configured");
  if (!isAbsolute(path)) throw new Error("VOIDSTATION_AUTH_DB must be an absolute path");
  return path;
}

function getDatabase() {
  const path = configuredDatabasePath();
  if (database && openedDatabasePath === path) return database;
  if (database) database.close();

  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const opened = new DatabaseSync(path);
  try {
    // Keep SQLite's only state file owner-readable. DELETE journaling avoids WAL sidecars.
    chmodSync(path, 0o600);
    opened.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS owner_account (
        name TEXT PRIMARY KEY NOT NULL CHECK (name = 'owner'),
        password_hash BLOB NOT NULL CHECK (length(password_hash) = ${SCRYPT_KEY_BYTES}),
        salt BLOB NOT NULL CHECK (length(salt) = ${SCRYPT_SALT_BYTES}),
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS login_attempt (
        id INTEGER PRIMARY KEY,
        attempted_at_ms INTEGER NOT NULL CHECK (attempted_at_ms >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS login_attempt_time ON login_attempt (attempted_at_ms);
      CREATE TABLE IF NOT EXISTS owner_session (
        token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = ${SESSION_TOKEN_BYTES}),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
        account_revision INTEGER NOT NULL CHECK (account_revision >= 1)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS owner_session_expiry ON owner_session (expires_at_ms);
    `);
  } catch (error) {
    opened.close();
    throw error;
  }
  database = opened;
  openedDatabasePath = path;
  return opened;
}

function transaction<Result>(db: DatabaseSync, operation: () => Result) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
    throw error;
  }
}

function readAccount(db: DatabaseSync) {
  return db.prepare("SELECT password_hash, salt, revision FROM owner_account WHERE name = 'owner'").get() as Account | undefined;
}

function acceptsPassword(password: string) {
  const length = Buffer.byteLength(password, "utf8");
  return length >= PASSWORD_MINIMUM_BYTES && length <= PASSWORD_MAXIMUM_BYTES;
}

async function deriveHash(password: string, salt: Uint8Array) {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_BYTES, {
      cost: 32_768,
      blockSize: 8,
      parallelization: 1,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => error ? reject(error) : resolve(Buffer.from(derivedKey)));
  });
}

function sameHash(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function reserveLoginAttempt(db: DatabaseSync): { status: "reserved" } | { status: "limited"; retryAfter: number } {
  return transaction(db, () => {
    const now = Date.now();
    db.prepare("DELETE FROM login_attempt WHERE attempted_at_ms <= ?").run(now - RATE_LIMIT_WINDOW_MS);
    const attempts = db.prepare("SELECT attempted_at_ms FROM login_attempt ORDER BY attempted_at_ms ASC").all() as { attempted_at_ms: number }[];
    if (attempts.length >= RATE_LIMIT_ATTEMPTS) {
      return {
        status: "limited",
        retryAfter: Math.max(1, Math.ceil((attempts[0].attempted_at_ms + RATE_LIMIT_WINDOW_MS - now) / 1_000)),
      };
    }
    db.prepare("INSERT INTO login_attempt (attempted_at_ms) VALUES (?)").run(now);
    return { status: "reserved" };
  });
}

function createSession(db: DatabaseSync, revision: number) {
  const now = Date.now();
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();
  db.prepare("DELETE FROM owner_session WHERE expires_at_ms <= ?").run(now);
  db.prepare(`
    DELETE FROM owner_session WHERE token_hash IN (
      SELECT token_hash FROM owner_session
      ORDER BY issued_at_ms ASC, token_hash ASC
      LIMIT -1 OFFSET ${SESSION_LIMIT - 1}
    )
  `).run();
  db.prepare(`
    INSERT INTO owner_session (token_hash, expires_at_ms, issued_at_ms, account_revision)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, now + SESSION_MAX_AGE_SECONDS * 1_000, now, revision);
  return token;
}

function tokenDigest(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || token.length !== SESSION_TOKEN_LENGTH) return undefined;
  return createHash("sha256").update(token).digest();
}

export async function authenticateOwner(password: string): Promise<
  { status: "ok"; token: string } | { status: "invalid" } | { status: "limited"; retryAfter: number }
> {
  const db = getDatabase();
  const reservation = reserveLoginAttempt(db);
  if (reservation.status === "limited") return reservation;
  if (!acceptsPassword(password)) return { status: "invalid" };

  const account = readAccount(db);
  if (!account) return { status: "invalid" };
  const derivedHash = await deriveHash(password, account.salt);
  if (!sameHash(derivedHash, account.password_hash)) return { status: "invalid" };

  return transaction(db, () => {
    const currentAccount = readAccount(db);
    if (!currentAccount || currentAccount.revision !== account.revision) return { status: "invalid" };
    return { status: "ok", token: createSession(db, currentAccount.revision) };
  });
}

export function isValidSession(token: string | undefined): boolean {
  const digest = tokenDigest(token);
  if (!digest) return false;
  const db = getDatabase();
  const now = Date.now();
  db.prepare("DELETE FROM owner_session WHERE expires_at_ms <= ?").run(now);
  const session = db.prepare(`
    SELECT owner_session.expires_at_ms
    FROM owner_session
    INNER JOIN owner_account ON owner_account.name = 'owner'
      AND owner_account.revision = owner_session.account_revision
    WHERE owner_session.token_hash = ? AND owner_session.expires_at_ms > ?
  `).get(digest, now) as Session | undefined;
  return session !== undefined;
}

export function revokeSession(token: string | undefined): void {
  const digest = tokenDigest(token);
  if (!digest) return;
  getDatabase().prepare("DELETE FROM owner_session WHERE token_hash = ?").run(digest);
}

export async function bootstrapOwner(password: string): Promise<OwnerAccountResult> {
  if (!acceptsPassword(password)) return "invalid";
  const db = getDatabase();
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const passwordHash = await deriveHash(password, salt);
  return transaction(db, () => {
    if (readAccount(db)) return "exists";
    db.prepare(`
      INSERT INTO owner_account (name, password_hash, salt, revision)
      VALUES ('owner', ?, ?, 1)
    `).run(passwordHash, salt);
    db.prepare("DELETE FROM login_attempt").run();
    db.prepare("DELETE FROM owner_session").run();
    return "created";
  });
}

export async function recoverOwner(password: string): Promise<OwnerAccountResult> {
  if (!acceptsPassword(password)) return "invalid";
  const db = getDatabase();
  if (!readAccount(db)) return "missing";
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const passwordHash = await deriveHash(password, salt);
  return transaction(db, () => {
    if (!readAccount(db)) return "missing";
    db.prepare(`
      UPDATE owner_account
      SET password_hash = ?, salt = ?, revision = revision + 1
      WHERE name = 'owner'
    `).run(passwordHash, salt);
    db.prepare("DELETE FROM owner_session").run();
    db.prepare("DELETE FROM login_attempt").run();
    return "recovered";
  });
}
