import { parse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import type {
  AssertionObservation,
  MarkerObservation,
  SourceLocation,
  TestFileAnalysis,
  TestObservation,
  TimeoutObservation,
} from "./model";
import { SourceAnalysisError } from "./model";

interface CalleeDescription {
  base: string;
  members: string[];
}

const TEST_BASES = new Set(["it", "test", "specify"]);
const SUITE_BASES = new Set(["describe", "context", "suite"]);
const SKIPPED_BASES = new Set([
  "xit",
  "xtest",
  "xspecify",
  "xdescribe",
  "xcontext",
]);
const FOCUSED_BASES = new Set(["fit", "fdescribe", "fcontext"]);
const SKIP_MEMBERS = new Set(["skip", "todo", "pending", "disable"]);
const FOCUS_MEMBERS = new Set(["only", "exclusive"]);
const EXPECTED_FAILURE_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
  "throws",
  "rejects",
  "doesNotThrow",
  "doesNotReject",
]);

const MATCHER_STRENGTH: Readonly<Record<string, number>> = {
  strictEqual: 5,
  deepStrictEqual: 5,
  toStrictEqual: 5,
  toBe: 5,
  equal: 4,
  deepEqual: 4,
  toEqual: 4,
  match: 3,
  toMatch: 3,
  toMatchObject: 3,
  includes: 2,
  contains: 2,
  toContain: 2,
  toContainEqual: 2,
  ok: 1,
  assert: 1,
  truthy: 1,
  toBeTruthy: 1,
  toBeDefined: 1,
  toBePresent: 1,
  anything: 0,
  any: 0,
};

function pluginsFor(path: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = [
    "jsx",
    "decorators-legacy",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "dynamicImport",
    "importAssertions",
    "importAttributes",
    "explicitResourceManagement",
    "topLevelAwait",
  ];
  if (/\.[cm]?tsx?$/iu.test(path)) plugins.push("typescript");
  return plugins;
}

function locationOf(node: t.Node): SourceLocation {
  return {
    line: node.loc?.start.line ?? 1,
    column: (node.loc?.start.column ?? 0) + 1,
  };
}

function walk(node: t.Node, visitor: (node: t.Node) => void): void {
  visitor(node);
  const keys = t.VISITOR_KEYS[node.type] ?? [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) walk(item, visitor);
      }
    } else if (isNode(value)) {
      walk(value, visitor);
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function staticPropertyName(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value);
  return null;
}

function describeCallee(
  node: t.Node | null | undefined,
): CalleeDescription | null {
  if (!node) return null;
  if (t.isIdentifier(node)) return { base: node.name, members: [] };
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const described = describeCallee(node.object);
    const property = staticPropertyName(node.property);
    if (
      !described ||
      !property ||
      (node.computed && !t.isStringLiteral(node.property))
    )
      return null;
    return { base: described.base, members: [...described.members, property] };
  }
  if (
    t.isCallExpression(node) ||
    t.isOptionalCallExpression(node) ||
    t.isNewExpression(node)
  ) {
    return describeCallee(node.callee);
  }
  if (t.isTaggedTemplateExpression(node)) return describeCallee(node.tag);
  return null;
}

function literalNumber(node: t.Node | null | undefined): number | null {
  if (t.isNumericLiteral(node) && Number.isFinite(node.value))
    return node.value;
  if (
    t.isUnaryExpression(node, { operator: "-" }) &&
    t.isNumericLiteral(node.argument)
  ) {
    return -node.argument.value;
  }
  return null;
}

function testTitle(node: t.Node | null | undefined): string {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
      .join("");
  }
  return `<dynamic@${String(node?.loc?.start.line ?? 1)}:${String((node?.loc?.start.column ?? 0) + 1)}>`;
}

function callbackFrom(
  arguments_: (
    t.Expression | t.SpreadElement | t.JSXNamespacedName | t.ArgumentPlaceholder
  )[],
): t.ArrowFunctionExpression | t.FunctionExpression | null {
  for (let index = arguments_.length - 1; index >= 1; index -= 1) {
    const argument = arguments_[index];
    if (
      t.isArrowFunctionExpression(argument) ||
      t.isFunctionExpression(argument)
    )
      return argument;
  }
  return null;
}

function assertionFromCall(
  node: t.CallExpression | t.OptionalCallExpression,
): AssertionObservation | null {
  const callee = describeCallee(node.callee);
  if (!callee) return null;
  const matcher = callee.members.at(-1) ?? callee.base;
  const expectBased = callee.base === "expect" && callee.members.length > 0;
  const assertBased = callee.base === "assert";
  const shouldBased =
    callee.members.includes("should") || callee.members.includes("expect");
  if (!expectBased && !assertBased && !shouldBased) return null;
  return {
    ...locationOf(node),
    matcher,
    strength: MATCHER_STRENGTH[matcher] ?? 3,
    expectedFailure:
      EXPECTED_FAILURE_MATCHERS.has(matcher) ||
      callee.members.includes("rejects"),
  };
}

function callbackIsEmpty(
  callback: t.ArrowFunctionExpression | t.FunctionExpression | null,
): boolean {
  if (!callback) return false;
  if (t.isBlockStatement(callback.body)) {
    return callback.body.body.length === 0;
  }
  return false;
}

function observationsInCallback(
  callback: t.ArrowFunctionExpression | t.FunctionExpression | null,
): AssertionObservation[] {
  if (!callback) return [];
  const assertions: AssertionObservation[] = [];
  walk(callback.body, (node) => {
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      const assertion = assertionFromCall(node);
      if (assertion) assertions.push(assertion);
    }
  });
  return assertions;
}

function isTestDescription(description: CalleeDescription): boolean {
  return (
    TEST_BASES.has(description.base) ||
    SKIPPED_BASES.has(description.base) ||
    description.base === "fit"
  );
}

function isSuiteDescription(description: CalleeDescription): boolean {
  return (
    SUITE_BASES.has(description.base) ||
    ["xdescribe", "xcontext", "fdescribe", "fcontext"].includes(
      description.base,
    )
  );
}

function markerKey(
  kind: string,
  title: string,
  location: SourceLocation,
): string {
  void location;
  return `${kind}:${title}`;
}

function testTimeout(
  node: t.CallExpression | t.OptionalCallExpression,
): number | undefined {
  for (let index = node.arguments.length - 1; index >= 2; index -= 1) {
    const value = literalNumber(node.arguments[index]);
    if (value !== null) return value;
  }
  return undefined;
}

function globalTimeout(
  node: t.CallExpression | t.OptionalCallExpression,
): TimeoutObservation | null {
  const callee = describeCallee(node.callee);
  if (!callee) return null;
  const member = callee.members.at(-1);
  if (
    member === "setTimeout" &&
    ["jest", "vi", "vitest"].includes(callee.base)
  ) {
    const milliseconds = literalNumber(node.arguments[0]);
    if (milliseconds !== null)
      return {
        key: `${callee.base}.setTimeout`,
        milliseconds,
        ...locationOf(node),
      };
  }
  if (member === "timeout" && callee.base === "this") {
    const milliseconds = literalNumber(node.arguments[0]);
    if (milliseconds !== null)
      return { key: "mocha.this.timeout", milliseconds, ...locationOf(node) };
  }
  if (member === "setConfig" && ["vi", "vitest"].includes(callee.base)) {
    const first = node.arguments[0];
    if (t.isObjectExpression(first)) {
      for (const property of first.properties) {
        if (!t.isObjectProperty(property)) continue;
        const name = staticPropertyName(property.key);
        const milliseconds = literalNumber(property.value);
        if (
          (name === "testTimeout" || name === "hookTimeout") &&
          milliseconds !== null
        ) {
          return {
            key: `${callee.base}.setConfig.${name}`,
            milliseconds,
            ...locationOf(property),
          };
        }
      }
    }
  }
  return null;
}

function normalizeParserError(error: unknown): SourceAnalysisError {
  if (error instanceof Error) {
    const candidate = error as Error & {
      loc?: { line?: number; column?: number };
    };
    return new SourceAnalysisError(error.message, {
      ...(candidate.loc?.line === undefined
        ? {}
        : { line: candidate.loc.line }),
      ...(candidate.loc?.column === undefined
        ? {}
        : { column: candidate.loc.column + 1 }),
    });
  }
  return new SourceAnalysisError(String(error));
}

export function analyzeJavaScript(
  path: string,
  source: string,
): TestFileAnalysis {
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: pluginsFor(path),
    });
  } catch (error) {
    throw normalizeParserError(error);
  }

  const tests: TestObservation[] = [];
  const skipped: MarkerObservation[] = [];
  const focused: MarkerObservation[] = [];
  const timeouts: TimeoutObservation[] = [];
  const inconclusive = new Set<string>();

  walk(ast, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const description = describeCallee(node.callee);
    if (!description) return;

    const timeout = globalTimeout(node);
    if (timeout) timeouts.push(timeout);

    if (description.base === "pending" && description.members.length === 0) {
      const location = locationOf(node);
      skipped.push({
        key: markerKey("pending", "pending()", location),
        ...location,
      });
      return;
    }

    if (!isTestDescription(description) && !isSuiteDescription(description))
      return;
    const location = locationOf(node);
    const title = testTitle(node.arguments[0]);
    if (title.startsWith("<dynamic@"))
      inconclusive.add("a test has a dynamic title");
    const isSkipped =
      SKIPPED_BASES.has(description.base) ||
      description.members.some((member) => SKIP_MEMBERS.has(member));
    const isFocused =
      FOCUSED_BASES.has(description.base) ||
      description.members.some((member) => FOCUS_MEMBERS.has(member));

    if (isSkipped)
      skipped.push({ key: markerKey("skip", title, location), ...location });
    if (isFocused)
      focused.push({ key: markerKey("focus", title, location), ...location });
    if (!isTestDescription(description)) return;

    const callback = callbackFrom(node.arguments);
    if (!callback && description.members.at(-1) === "each") return;
    if (!callback && !isSkipped)
      inconclusive.add(`test '${title}' uses a non-inline callback`);
    const observedTimeout = testTimeout(node);
    const test: TestObservation = {
      key: title,
      title,
      skipped: isSkipped,
      focused: isFocused,
      empty: callbackIsEmpty(callback),
      assertions: observationsInCallback(callback),
      ...location,
      ...(observedTimeout === undefined ? {} : { timeout: observedTimeout }),
    };
    tests.push(test);
    if (!isSkipped && !test.empty && test.assertions.length === 0) {
      inconclusive.add(`test '${title}' has no recognizable inline assertion`);
    }
    if (observedTimeout !== undefined) {
      timeouts.push({
        key: `test:${title}`,
        milliseconds: observedTimeout,
        ...location,
      });
    }
  });

  if (tests.length === 0)
    inconclusive.add("no recognizable test cases were found");
  return { tests, skipped, focused, timeouts, inconclusive: [...inconclusive] };
}

export function assertionStrength(matcher: string): number {
  return MATCHER_STRENGTH[matcher] ?? 3;
}
