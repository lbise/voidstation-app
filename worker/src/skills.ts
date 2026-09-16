import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type MediaService = "radarr" | "sonarr";

const MAX_SKILL_BYTES = 64 * 1024;

export class SkillReadError extends Error {
  constructor(public readonly code: "skill_unavailable" | "invalid_request" | "invalid_response", message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDigest(value: unknown): string | undefined {
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  if (isRecord(value) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sha256)) return value.sha256.toLowerCase();
  return undefined;
}

function validResource(resource: string): boolean {
  if (resource.length === 0 || resource.length > 240 || isAbsolute(resource) || resource.includes("\\") || resource.includes("\0")) return false;
  const parts = resource.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

async function regularDirectory(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new SkillReadError("skill_unavailable", "The packaged media skill is unavailable.");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SkillReadError("skill_unavailable", "The packaged media skill is unavailable.");
  return realpath(path);
}

async function manifestResources(root: string, service: MediaService): Promise<Record<string, unknown> | undefined> {
  const path = resolve(root, "manifest.json");
  let contents: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid manifest");
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid.");
  }
  if (Buffer.byteLength(contents) > MAX_SKILL_BYTES) throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid.");
  let value: unknown;
  try { value = JSON.parse(contents) as unknown; } catch { throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid."); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source) || value.source.repository !== "dotfiles" ||
      typeof value.source.revision !== "string" || !/^[0-9a-f]{40}$/i.test(value.source.revision) || !Array.isArray(value.files)) {
    throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid.");
  }
  const resources: Record<string, unknown> = {};
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sourcePath !== "string" || !validDigest(entry.sha256)) {
      throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid.");
    }
    const prefix = `${service}/`;
    if (!entry.path.startsWith(prefix)) continue;
    const resource = entry.path.slice(prefix.length);
    if (!validResource(resource) || Object.hasOwn(resources, resource)) throw new SkillReadError("skill_unavailable", "The media skill manifest is invalid.");
    resources[resource] = entry.sha256;
  }
  return resources;
}

/** Reads SKILL.md or a digest-pinned supporting file from the packaged media skills. */
export async function readApprovedSkill(service: MediaService, resource: string): Promise<{ service: MediaService; resource: string; content: string }> {
  if (!validResource(resource)) throw new SkillReadError("invalid_request", "The requested skill resource is not allowed.");

  const skillsRoot = await regularDirectory(process.env.VOIDSTATION_MEDIA_SKILLS_DIR ?? "/app/media/skills");
  const serviceRoot = resolve(skillsRoot, service);
  if (!contained(skillsRoot, serviceRoot)) throw new SkillReadError("skill_unavailable", "The packaged media skill is unavailable.");
  const root = await regularDirectory(serviceRoot);
  if (!contained(skillsRoot, root)) throw new SkillReadError("skill_unavailable", "The packaged media skill is unavailable.");

  const approved = await manifestResources(skillsRoot, service);
  const digest = approved?.[resource];
  if (resource !== "SKILL.md" && digest === undefined) throw new SkillReadError("invalid_request", "The requested skill resource is not allowed.");
  if (approved && digest === undefined && resource === "SKILL.md") throw new SkillReadError("skill_unavailable", "The media skill manifest does not include SKILL.md.");

  const path = resolve(root, resource);
  if (!contained(root, path)) throw new SkillReadError("invalid_request", "The requested skill resource is not allowed.");
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new SkillReadError("skill_unavailable", "The requested skill resource is unavailable.");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_BYTES) throw new SkillReadError("skill_unavailable", "The requested skill resource is unavailable.");
  const resolved = await realpath(path);
  if (!contained(root, resolved)) throw new SkillReadError("skill_unavailable", "The requested skill resource is unavailable.");
  const resolvedInfo = await stat(resolved);
  if (!resolvedInfo.isFile() || resolvedInfo.size > MAX_SKILL_BYTES) throw new SkillReadError("skill_unavailable", "The requested skill resource is unavailable.");
  const content = await readFile(resolved, "utf8");
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new SkillReadError("skill_unavailable", "The requested skill resource is unavailable.");

  if (approved) {
    const expected = validDigest(digest);
    if (!expected || createHash("sha256").update(content).digest("hex") !== expected) {
      throw new SkillReadError("skill_unavailable", "The requested skill resource failed package verification.");
    }
  }
  return { service, resource, content };
}
