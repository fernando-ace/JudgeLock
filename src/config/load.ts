import { readFile } from "node:fs/promises";
import { LineCounter, isNode, parseDocument } from "yaml";
import { ExitCode } from "../constants";
import { JudgeLockError } from "../errors";
import { JudgeLockConfigSchema, type JudgeLockConfig } from "./schema";

function locationForIssue(
  document: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
  issue: { path: PropertyKey[]; message: string },
): string {
  const node = document.getIn(issue.path, true) as unknown;
  if (isNode(node) && node.range) {
    const position = lineCounter.linePos(node.range[0]);
    return `line ${String(position.line)}, column ${String(position.col)}`;
  }
  return issue.path.length > 0
    ? issue.path.map(String).join(".")
    : "document root";
}

export function parseConfig(
  text: string,
  source = "judgelock.yml",
): JudgeLockConfig {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    const details = document.errors
      .map((error) => {
        const position = lineCounter.linePos(error.pos[0]);
        return `line ${String(position.line)}, column ${String(position.col)}: ${error.message}`;
      })
      .join("\n");
    throw new JudgeLockError(`Invalid YAML in ${source}:\n${details}`, {
      code: "CONFIG_YAML_INVALID",
      exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
      remediation: "Fix the reported YAML syntax and run JudgeLock again.",
    });
  }

  const parsed = JudgeLockConfigSchema.safeParse(
    document.toJS({ maxAliasCount: 100 }),
  );
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) =>
          `${locationForIssue(document, lineCounter, issue)}: ${issue.message}`,
      )
      .join("\n");
    throw new JudgeLockError(
      `Invalid JudgeLock configuration in ${source}:\n${details}`,
      {
        code: "CONFIG_SCHEMA_INVALID",
        exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
        remediation:
          "Correct the reported fields. Unknown or misspelled fields are rejected.",
      },
    );
  }
  return parsed.data;
}

export async function loadConfigFile(
  path: string,
): Promise<{ config: JudgeLockConfig; bytes: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new JudgeLockError(
      `Could not read JudgeLock configuration at ${path}.`,
      {
        code: "CONFIG_NOT_FOUND",
        exitCode: ExitCode.PRECONDITION_FAILED,
        remediation:
          "Run 'judgelock init', review the policy, and commit judgelock.yml.",
        cause: error,
      },
    );
  }
  return { config: parseConfig(bytes.toString("utf8"), path), bytes };
}
