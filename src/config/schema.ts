import micromatch from "micromatch";
import { z } from "zod";

const normalizedPath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//, "");

function validateRepositoryPattern(
  value: string,
  context: z.RefinementCtx,
): void {
  if (value.includes("\0"))
    context.addIssue({ code: "custom", message: "must not contain NUL bytes" });
  if (value.startsWith("!"))
    context.addIssue({
      code: "custom",
      message: "leading negation is not supported",
    });
  if (/^(?:[A-Za-z]:\/|\/|\/\/)/u.test(value)) {
    context.addIssue({
      code: "custom",
      message: "must be repository-relative",
    });
  }
  if (value.split("/").includes("..")) {
    context.addIssue({
      code: "custom",
      message: "must not escape the repository with '..'",
    });
  }
  try {
    micromatch.makeRe(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: `invalid glob: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const globSchema = z
  .string()
  .min(1)
  .transform(normalizedPath)
  .superRefine(validateRepositoryPattern);

const validationCommandSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    command: z.string().trim().min(1).max(10_000),
    timeoutSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();

export const JudgeLockConfigSchema = z
  .object({
    version: z.literal(1),
    testIntegrity: z
      .object({
        existingTests: z.enum(["immutable", "guarded", "allowed"]),
        allowNewTests: z.boolean(),
        blockDeletedTests: z.boolean(),
        blockSnapshotChanges: z.boolean(),
        blockSkippedTests: z.boolean(),
        blockFocusedTests: z.boolean(),
        blockAssertionRemoval: z.boolean(),
        blockAssertionWeakening: z.boolean(),
        blockTimeoutIncreases: z.boolean(),
      })
      .strict(),
    coverage: z
      .object({
        blockThresholdReductions: z.boolean(),
        blockNewExclusions: z.boolean(),
      })
      .strict(),
    validation: z
      .object({
        protectScripts: z.boolean(),
        allowInspectionOnlyCompletion: z.boolean().default(false),
        commands: z.array(validationCommandSchema).max(100),
      })
      .strict()
      .superRefine((value, context) => {
        const seen = new Set<string>();
        value.commands.forEach((command, index) => {
          const key = command.name.toLowerCase();
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              message: `duplicate command name '${command.name}'`,
              path: ["commands", index, "name"],
            });
          }
          seen.add(key);
        });
      }),
    paths: z
      .object({
        testPatterns: z.array(globSchema).min(1).max(500),
        snapshotPatterns: z.array(globSchema).max(500),
        protectedPatterns: z.array(globSchema).max(500),
        ignoredPatterns: z.array(globSchema).max(500),
      })
      .strict(),
    receipt: z
      .object({
        directory: z
          .string()
          .min(1)
          .transform(normalizedPath)
          .superRefine((value, context) => {
            validateRepositoryPattern(value, context);
            if (!value.startsWith(".judgelock/")) {
              context.addIssue({
                code: "custom",
                message: "must be located under .judgelock/",
              });
            }
          }),
        retainCommandOutputCharacters: z.number().int().min(0).max(1_000_000),
      })
      .strict(),
    ci: z
      .object({
        allowPolicyChanges: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type JudgeLockConfig = z.infer<typeof JudgeLockConfigSchema>;
export type ValidationCommand =
  JudgeLockConfig["validation"]["commands"][number];
