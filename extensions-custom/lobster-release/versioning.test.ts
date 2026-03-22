import { describe, expect, it } from "vitest";
import { compareVersions, inferBumpType, parseVersion } from "./versioning.js";

describe("lobster-release versioning", () => {
  it("parses semver3 versions", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
  });

  it("compares versions correctly", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("infers bump type", () => {
    expect(inferBumpType("1.2.3", "1.2.4")).toBe("patch");
    expect(inferBumpType("1.2.3", "1.3.0")).toBe("minor");
    expect(inferBumpType("1.2.3", "2.0.0")).toBe("major");
  });

  it("rejects invalid bump shapes", () => {
    expect(() => inferBumpType("1.2.3", "1.3.1")).toThrow(/minor bump must reset patch/);
    expect(() => inferBumpType("1.2.3", "1.2.3")).toThrow(/must be greater/);
  });
});
