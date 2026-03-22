import type { ReleaseBumpType } from "./types.js";

export type ParsedVersion = {
  raw: string;
  major: number;
  minor: number;
  patch: number;
};

const SEMVER3_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(raw: string): ParsedVersion {
  const trimmed = raw.trim();
  const match = SEMVER3_RE.exec(trimmed);
  if (!match) {
    throw new Error(`invalid version format: ${raw}`);
  }
  return {
    raw: trimmed,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(
  left: ParsedVersion | string,
  right: ParsedVersion | string,
): number {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export function inferBumpType(
  previousVersion: ParsedVersion | string | undefined,
  nextVersion: ParsedVersion | string,
): ReleaseBumpType {
  const next = typeof nextVersion === "string" ? parseVersion(nextVersion) : nextVersion;
  if (!previousVersion) {
    return next.patch > 0 ? "patch" : next.minor > 0 ? "minor" : "major";
  }
  const prev =
    typeof previousVersion === "string" ? parseVersion(previousVersion) : previousVersion;
  const cmp = compareVersions(prev, next);
  if (cmp >= 0) {
    throw new Error(`version ${next.raw} must be greater than ${prev.raw}`);
  }
  if (next.major !== prev.major) {
    if (next.minor !== 0 || next.patch !== 0) {
      throw new Error(`major bump must reset minor and patch: ${prev.raw} -> ${next.raw}`);
    }
    return "major";
  }
  if (next.minor !== prev.minor) {
    if (next.patch !== 0) {
      throw new Error(`minor bump must reset patch: ${prev.raw} -> ${next.raw}`);
    }
    return "minor";
  }
  return "patch";
}

export function toCommitShort(commit?: string): string | undefined {
  if (!commit) {
    return undefined;
  }
  return commit.slice(0, 7);
}
