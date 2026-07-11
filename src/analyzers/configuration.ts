import { parse as parseJavaScript } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import { parse as parseToml } from "smol-toml";
import type { JudgeLockConfig } from "../config/schema";
import type { Finding } from "../types";
import { createFinding } from "../policy/violations";

type StaticPrimitive = string | number | boolean | null;
type StaticValue =
  StaticPrimitive | StaticValue[] | { [key: string]: StaticValue };

interface StaticResult {
  ok: boolean;
  value?: StaticValue;
}

interface ConfigFacts {
  thresholds: Map<string, number>;
  exclusions: Set<string>;
  discoveryIncludes: Map<string, Set<string>>;
  discoveryExcludes: Map<string, Set<string>>;
  scripts: Map<string, string>;
  timeouts: Map<string, number>;
  dynamic: boolean;
}

const CONFIG_BASENAME =
  /^(?:(?:jest|vitest|mocha|karma|ava|nyc|c8|coverage)(?:\.[^.]+)?\.config\.[cm]?[jt]s|\.nycrc(?:\.json)?|pyproject\.toml|pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/iu;
const COVERAGE_DIRECTIVE =
  /(?:istanbul|c8|v8)\s+ignore(?:\s+next|\s+file|\s+start|\s+stop)?|pragma:\s*no\s+cover/giu;
const THRESHOLD_LEAVES = new Set([
  "branches",
  "branch",
  "functions",
  "function",
  "lines",
  "line",
  "statements",
  "statement",
  "fail_under",
]);
const INCLUDE_KEYS = new Set([
  "testmatch",
  "testregex",
  "include",
  "projects",
  "testpaths",
  "python_files",
  "python_classes",
  "python_functions",
]);
const EXCLUDE_KEYS = new Set([
  "exclude",
  "excludes",
  "ignore",
  "ignored",
  "omit",
  "testpathignorepatterns",
  "coveragerpathignorepatterns",
  "coveragepathignorepatterns",
  "norecursedirs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function staticKey(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value);
  return null;
}

function unwrapExpression(node: t.Node): t.Node {
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTypeCastExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  if (t.isParenthesizedExpression(node))
    return unwrapExpression(node.expression);
  return node;
}

function staticValue(
  node: t.Node,
  bindings: ReadonlyMap<string, t.Node>,
  seen = new Set<string>(),
): StaticResult {
  const unwrapped = unwrapExpression(node);
  if (
    t.isStringLiteral(unwrapped) ||
    t.isNumericLiteral(unwrapped) ||
    t.isBooleanLiteral(unwrapped)
  ) {
    return { ok: true, value: unwrapped.value };
  }
  if (t.isNullLiteral(unwrapped)) return { ok: true, value: null };
  if (t.isRegExpLiteral(unwrapped))
    return { ok: true, value: `/${unwrapped.pattern}/${unwrapped.flags}` };
  if (t.isTemplateLiteral(unwrapped) && unwrapped.expressions.length === 0) {
    return {
      ok: true,
      value: unwrapped.quasis
        .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
        .join(""),
    };
  }
  if (
    t.isUnaryExpression(unwrapped) &&
    ["-", "+"].includes(unwrapped.operator) &&
    t.isNumericLiteral(unwrapped.argument)
  ) {
    return {
      ok: true,
      value:
        unwrapped.operator === "-"
          ? -unwrapped.argument.value
          : unwrapped.argument.value,
    };
  }
  if (t.isIdentifier(unwrapped)) {
    if (unwrapped.name === "undefined") return { ok: false };
    if (seen.has(unwrapped.name)) return { ok: false };
    const binding = bindings.get(unwrapped.name);
    if (!binding) return { ok: false };
    return staticValue(binding, bindings, new Set([...seen, unwrapped.name]));
  }
  if (t.isCallExpression(unwrapped) && unwrapped.arguments.length > 0) {
    const calleeName = t.isIdentifier(unwrapped.callee)
      ? unwrapped.callee.name
      : null;
    if (
      ["defineConfig", "config", "defineProject"].includes(calleeName ?? "")
    ) {
      const first = unwrapped.arguments[0];
      if (
        first &&
        !t.isSpreadElement(first) &&
        !t.isArgumentPlaceholder(first) &&
        !t.isJSXNamespacedName(first)
      ) {
        return staticValue(first, bindings, seen);
      }
    }
    return { ok: false };
  }
  if (t.isArrayExpression(unwrapped)) {
    const result: StaticValue[] = [];
    for (const element of unwrapped.elements) {
      if (!element || t.isSpreadElement(element)) return { ok: false };
      const item = staticValue(element, bindings, seen);
      if (!item.ok || item.value === undefined) return { ok: false };
      result.push(item.value);
    }
    return { ok: true, value: result };
  }
  if (t.isObjectExpression(unwrapped)) {
    const result: Record<string, StaticValue> = {};
    for (const property of unwrapped.properties) {
      if (!t.isObjectProperty(property) || property.computed)
        return { ok: false };
      const key = staticKey(property.key);
      if (!key) return { ok: false };
      const item = staticValue(property.value, bindings, seen);
      if (!item.ok || item.value === undefined) return { ok: false };
      result[key] = item.value;
    }
    return { ok: true, value: result };
  }
  return { ok: false };
}

function parseStaticJavaScript(source: string, path: string): StaticResult {
  const plugins: ParserPlugin[] = ["jsx", "decorators-legacy"];
  if (/\.[cm]?tsx?$/iu.test(path)) plugins.push("typescript");
  let ast: t.File;
  try {
    ast = parseJavaScript(source, { sourceType: "unambiguous", plugins });
  } catch {
    return { ok: false };
  }
  const bindings = new Map<string, t.Node>();
  for (const statement of ast.program.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (t.isIdentifier(declaration.id) && declaration.init)
        bindings.set(declaration.id.name, declaration.init);
    }
  }
  for (const statement of ast.program.body) {
    if (
      t.isExportDefaultDeclaration(statement) &&
      !t.isDeclaration(statement.declaration)
    ) {
      return staticValue(statement.declaration, bindings);
    }
    if (
      !t.isExpressionStatement(statement) ||
      !t.isAssignmentExpression(statement.expression, { operator: "=" })
    )
      continue;
    const left = statement.expression.left;
    if (
      t.isMemberExpression(left) &&
      t.isIdentifier(left.object, { name: "module" }) &&
      t.isIdentifier(left.property, { name: "exports" })
    ) {
      return staticValue(statement.expression.right, bindings);
    }
  }
  return { ok: false };
}

function parseIni(source: string): StaticValue {
  const result: Record<string, StaticValue> = {};
  let section = "root";
  result[section] = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\n]+)\]$/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      result[section] ??= {};
      continue;
    }
    const separator = line.search(/[=:]/u);
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const numeric = Number(rawValue);
    const value: StaticValue =
      rawValue && Number.isFinite(numeric) ? numeric : rawValue;
    const target = result[section];
    if (isRecord(target)) target[key] = value;
  }
  return result;
}

function parseConfig(path: string, source: string): StaticResult {
  try {
    if (path === "package.json" || /(?:\.json|\.nycrc)$/iu.test(path)) {
      return { ok: true, value: JSON.parse(source) as StaticValue };
    }
    if (path.endsWith(".toml"))
      return { ok: true, value: parseToml(source) as StaticValue };
    if (/\.(?:ini|cfg)$/iu.test(path) || path.endsWith(".coveragerc")) {
      return { ok: true, value: parseIni(source) };
    }
    if (/\.[cm]?[jt]s$/iu.test(path))
      return parseStaticJavaScript(source, path);
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

function valuesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[\r\n,]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "number" || typeof value === "boolean")
    return [String(value)];
  if (Array.isArray(value)) return value.flatMap(valuesOf);
  return [];
}

function addMapValues(
  target: Map<string, Set<string>>,
  key: string,
  values: string[],
): void {
  const existing = target.get(key) ?? new Set<string>();
  for (const value of values) existing.add(value);
  target.set(key, existing);
}

function factsFrom(
  path: string,
  value: StaticValue | undefined,
  dynamic: boolean,
): ConfigFacts {
  const facts: ConfigFacts = {
    thresholds: new Map(),
    exclusions: new Set(),
    discoveryIncludes: new Map(),
    discoveryExcludes: new Map(),
    scripts: new Map(),
    timeouts: new Map(),
    dynamic,
  };
  if (value === undefined) return facts;

  function visit(current: unknown, trail: string[]): void {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...trail, String(index)]));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const nextPath = [...trail, key];
      const normalizedKey = key.toLowerCase();
      const pathText = nextPath.join(".");
      const ancestors = nextPath.map((part) => part.toLowerCase());
      const basename =
        path.split("/").at(-1)?.toLowerCase() ?? path.toLowerCase();
      const coverageConfigFile =
        basename.startsWith(".nycrc") || basename === ".coveragerc";
      const testConfigFile =
        /^(?:jest|vitest|mocha|karma|ava|pytest|tox)(?:\.|$)/u.test(basename);
      const isCoverageContext =
        coverageConfigFile ||
        ancestors.some(
          (part) =>
            part.includes("coverage") || part === "nyc" || part === "c8",
        );
      const isTestContext =
        testConfigFile ||
        ancestors.some((part) =>
          /(?:^|_)(?:jest|vitest|mocha|pytest|test)(?:_|$)/u.test(part),
        );
      const isThresholdContext =
        ancestors.some((part) => part.includes("threshold")) ||
        normalizedKey === "fail_under";
      if (
        typeof child === "number" &&
        (isThresholdContext ||
          (isCoverageContext && THRESHOLD_LEAVES.has(normalizedKey)))
      ) {
        facts.thresholds.set(pathText, child);
      }
      if (
        isCoverageContext &&
        (EXCLUDE_KEYS.has(normalizedKey) ||
          /(?:exclude|ignore|omit)(?:patterns?|files?)?$/iu.test(normalizedKey))
      ) {
        for (const excluded of valuesOf(child))
          facts.exclusions.add(`${pathText}=${excluded}`);
      }
      if (isTestContext && INCLUDE_KEYS.has(normalizedKey)) {
        addMapValues(facts.discoveryIncludes, pathText, valuesOf(child));
      }
      if (isTestContext && EXCLUDE_KEYS.has(normalizedKey)) {
        addMapValues(facts.discoveryExcludes, pathText, valuesOf(child));
      }
      if (
        typeof child === "number" &&
        isTestContext &&
        ["testtimeout", "hooktimeout", "timeout"].includes(normalizedKey)
      ) {
        facts.timeouts.set(pathText, child);
      }
      if (
        trail.length === 1 &&
        trail[0] === "scripts" &&
        typeof child === "string"
      )
        facts.scripts.set(key, child);
      visit(child, nextPath);
    }
  }

  visit(value, []);
  return facts;
}

function sourceFacts(path: string, source: string | null): ConfigFacts {
  if (source === null) return factsFrom(path, undefined, false);
  const parsed = parseConfig(path, source);
  return factsFrom(path, parsed.value, !parsed.ok);
}

function protectedScriptNames(
  config: JudgeLockConfig,
  baselineScripts: ReadonlyMap<string, string>,
): Set<string> {
  const names = new Set<string>([
    "test",
    "lint",
    "typecheck",
    "check",
    "validate",
    "coverage",
    "ci",
  ]);
  const commandPattern =
    /(?:npm|pnpm)\s+(?:run\s+)?([A-Za-z0-9._:-]+)|yarn\s+(?:run\s+)?([A-Za-z0-9._:-]+)/gu;
  for (const validation of config.validation.commands) {
    for (const match of validation.command.matchAll(commandPattern)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
  }
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) continue;
    for (const implicit of [`pre${name}`, `post${name}`]) {
      if (baselineScripts.has(implicit) && !names.has(implicit)) {
        names.add(implicit);
        queue.push(implicit);
      }
    }
    const script = baselineScripts.get(name);
    if (!script) continue;
    for (const match of script.matchAll(commandPattern)) {
      const dependency = match[1] ?? match[2];
      if (dependency && !names.has(dependency)) {
        names.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return names;
}

function narrowingTokens(command: string): Set<string> {
  const tokens = new Set<string>();
  const pattern =
    /(?:--(?:testNamePattern|testPathPattern|grep|fgrep|ignore|exclude|testPathIgnorePatterns)(?:=|\s+)\S+|(?:^|\s)-(?:t|k|m)\s+\S+|(?:^|\s)(?:test|tests)\/[A-Za-z0-9_./\\-]+)/giu;
  for (const match of command.matchAll(pattern)) tokens.add(match[0].trim());
  return tokens;
}

function compareFacts(
  path: string,
  baseline: ConfigFacts,
  current: ConfigFacts,
  config: JudgeLockConfig,
): Finding[] {
  const findings: Finding[] = [];
  if (config.coverage.blockThresholdReductions) {
    for (const [key, before] of baseline.thresholds) {
      const after = current.thresholds.get(key);
      if (after === undefined || after < before) {
        findings.push(
          createFinding("COVERAGE_THRESHOLD_REDUCED", path, {
            explanation: `Coverage threshold '${key}' changed from ${String(before)} to ${after === undefined ? "missing" : String(after)}.`,
          }),
        );
      }
    }
  }
  if (config.coverage.blockNewExclusions) {
    for (const exclusion of current.exclusions) {
      if (!baseline.exclusions.has(exclusion)) {
        findings.push(
          createFinding("COVERAGE_EXCLUSION_ADDED", path, {
            explanation: `Coverage exclusion '${exclusion}' was added.`,
          }),
        );
      }
    }
  }
  for (const [key, before] of baseline.discoveryIncludes) {
    const after = current.discoveryIncludes.get(key) ?? new Set<string>();
    for (const pattern of before) {
      if (!after.has(pattern)) {
        findings.push(
          createFinding("TEST_DISCOVERY_NARROWED", path, {
            explanation: `Test discovery pattern '${key}=${pattern}' was removed.`,
          }),
        );
      }
    }
  }
  for (const [key, after] of current.discoveryExcludes) {
    const before = baseline.discoveryExcludes.get(key) ?? new Set<string>();
    for (const pattern of after) {
      if (!before.has(pattern)) {
        findings.push(
          createFinding("TEST_DISCOVERY_NARROWED", path, {
            explanation: `Test exclusion '${key}=${pattern}' was added.`,
          }),
        );
      }
    }
  }
  if (path === "package.json" && config.validation.protectScripts) {
    for (const name of protectedScriptNames(config, baseline.scripts)) {
      const before = baseline.scripts.get(name);
      if (before === undefined) continue;
      const after = current.scripts.get(name);
      if (after !== before) {
        findings.push(
          createFinding("VALIDATION_SCRIPT_CHANGED", path, {
            explanation: `Protected package script '${name}' changed from its trusted baseline value.`,
          }),
        );
        if (after !== undefined) {
          const beforeNarrowing = narrowingTokens(before);
          for (const token of narrowingTokens(after)) {
            if (!beforeNarrowing.has(token)) {
              findings.push(
                createFinding("TEST_DISCOVERY_NARROWED", path, {
                  explanation: `Protected script '${name}' introduced the test selector '${token}'.`,
                }),
              );
            }
          }
        }
      }
    }
  }
  if (config.testIntegrity.blockTimeoutIncreases) {
    for (const [key, before] of baseline.timeouts) {
      const after = current.timeouts.get(key);
      if (after !== undefined && after > before) {
        findings.push(
          createFinding("TIMEOUT_INCREASED", path, {
            explanation: `Test timeout '${key}' increased from ${String(before)} to ${String(after)}.`,
          }),
        );
      }
    }
  }
  if (baseline.dynamic || current.dynamic) {
    findings.push(
      createFinding("ANALYSIS_INCONCLUSIVE", path, {
        explanation:
          "The changed test or coverage configuration is dynamic or could not be parsed as static data.",
      }),
    );
  }
  return findings;
}

export function isAnalyzedConfigPath(path: string): boolean {
  const basename = path.split("/").at(-1) ?? path;
  return path === "package.json" || CONFIG_BASENAME.test(basename);
}

export function analyzeConfigurationChange(
  path: string,
  baselineSource: string | null,
  currentSource: string | null,
  config: JudgeLockConfig,
): Finding[] {
  return compareFacts(
    path,
    sourceFacts(path, baselineSource),
    sourceFacts(path, currentSource),
    config,
  );
}

export function findNewCoverageDirectives(
  path: string,
  baselineSource: string | null,
  currentSource: string | null,
): Finding[] {
  if (currentSource === null) return [];
  const baselineCounts = new Map<string, number>();
  for (const match of (baselineSource ?? "").matchAll(COVERAGE_DIRECTIVE)) {
    const key = match[0].toLowerCase().replace(/\s+/gu, " ");
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const findings: Finding[] = [];
  for (const match of currentSource.matchAll(COVERAGE_DIRECTIVE)) {
    const key = match[0].toLowerCase().replace(/\s+/gu, " ");
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count <= (baselineCounts.get(key) ?? 0)) continue;
    const prefix = currentSource.slice(0, match.index);
    const line = prefix.split(/\r?\n/u).length;
    const lastBreak = Math.max(
      prefix.lastIndexOf("\n"),
      prefix.lastIndexOf("\r"),
    );
    findings.push(
      createFinding("COVERAGE_EXCLUSION_ADDED", path, {
        line,
        column: prefix.length - lastBreak,
        explanation: `A new coverage ignore directive '${match[0]}' was added.`,
      }),
    );
  }
  return findings;
}
