import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRootFromCwd } from "../../src/git/client";

describe("Git client path discovery", () => {
  it("preserves the caller's path spelling when resolving the repository root", () => {
    const nested = resolve("runner-profile-alias", "judgelock", "outside");

    expect(repositoryRootFromCwd(nested, "..")).toBe(
      resolve("runner-profile-alias", "judgelock").replaceAll("\\", "/"),
    );
  });
});
