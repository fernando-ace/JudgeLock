import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { parseConfig } from "../../src/config/load";

describe("JudgeLock configuration", () => {
  it("parses the generated strict defaults", () => {
    const config = parseConfig(DEFAULT_CONFIG);
    expect(config.version).toBe(1);
    expect(config.testIntegrity.existingTests).toBe("immutable");
    expect(config.validation.commands).toEqual([]);
    expect(config.receipt.directory).toBe(".judgelock/receipts");
  });

  it("rejects misspelled high-impact fields with a location", () => {
    const invalid = DEFAULT_CONFIG.replace(
      "allowNewTests: true",
      "allowNewTests: true\n  allowNewTsets: true",
    );
    expect(() => parseConfig(invalid)).toThrow(
      /line \d+, column \d+: Unrecognized key/u,
    );
  });

  it("rejects unsafe paths and invalid receipt locations", () => {
    const escape = DEFAULT_CONFIG.replace(
      '    - "tests/**"',
      '    - "../tests/**"',
    );
    expect(() => parseConfig(escape)).toThrow(/must not escape/u);
    const outside = DEFAULT_CONFIG.replace(
      'directory: ".judgelock/receipts"',
      'directory: "receipts"',
    );
    expect(() => parseConfig(outside)).toThrow(/under \.judgelock/u);
  });

  it("normalizes Windows separators", () => {
    const windows = DEFAULT_CONFIG.replace(
      '    - "tests/**"',
      '    - "tests\\\\**"',
    );
    expect(parseConfig(windows).paths.testPatterns).toContain("tests/**");
  });

  it("rejects duplicate command names", () => {
    const duplicate = DEFAULT_CONFIG.replace(
      "  commands: []",
      "  commands:\n    - name: tests\n      command: npm test\n      timeoutSeconds: 30\n    - name: TESTS\n      command: npm test\n      timeoutSeconds: 30",
    );
    expect(() => parseConfig(duplicate)).toThrow(/duplicate command name/u);
  });
});
