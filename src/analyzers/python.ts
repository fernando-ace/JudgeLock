import type {
  AssertionObservation,
  MarkerObservation,
  TestFileAnalysis,
  TestObservation,
  TimeoutObservation,
} from "./model";

interface PythonFunction {
  name: string;
  line: number;
  column: number;
  indent: number;
  decorators: { text: string; line: number; column: number }[];
  body: { text: string; line: number; column: number }[];
}

const SKIP_DECORATOR =
  /^(?:@)?(?:pytest\.mark\.)?(?:skip|skipif|xfail)\b|^(?:@)?unittest\.(?:skip|skipIf|skipUnless)\b/u;

function indentation(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 8 - (width % 8);
    else break;
  }
  return width;
}

function collectFunctions(lines: string[]): PythonFunction[] {
  const functions: PythonFunction[] = [];
  let decorators: {
    text: string;
    line: number;
    column: number;
    indent: number;
  }[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const indent = indentation(line);
    if (trimmed.startsWith("@")) {
      decorators.push({
        text: trimmed,
        line: index + 1,
        column: line.indexOf("@") + 1,
        indent,
      });
      index += 1;
      continue;
    }

    const match = /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/u.exec(
      line,
    );
    if (!match) {
      if (trimmed && !trimmed.startsWith("#")) decorators = [];
      index += 1;
      continue;
    }

    const name = match[2];
    if (!name) {
      index += 1;
      continue;
    }
    const relevantDecorators = decorators
      .filter((decorator) => decorator.indent === indent)
      .map(({ text, line: decoratorLine, column }) => ({
        text,
        line: decoratorLine,
        column,
      }));
    decorators = [];
    const body: PythonFunction["body"] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const bodyLine = lines[cursor] ?? "";
      const bodyTrimmed = bodyLine.trim();
      const bodyIndent = indentation(bodyLine);
      if (bodyTrimmed && bodyIndent <= indent && !bodyTrimmed.startsWith("#"))
        break;
      body.push({
        text: bodyLine,
        line: cursor + 1,
        column: Math.min(bodyLine.length + 1, bodyIndent + 1),
      });
      cursor += 1;
    }
    functions.push({
      name,
      line: index + 1,
      column: indent + 1,
      indent,
      decorators: relevantDecorators,
      body,
    });
    index = cursor;
  }
  return functions;
}

function assertionStrength(matcher: string, text: string): number {
  if (
    /\b(?:assertStrictEqual|assertSequenceEqual|assertDictEqual|assertSetEqual|assertTupleEqual)\b/u.test(
      matcher,
    )
  )
    return 5;
  if (
    /\b(?:assertEqual|assertEquals|assertRaises|assertRaisesRegex)\b/u.test(
      matcher,
    )
  )
    return 4;
  if (/\b(?:assertIn|assertRegex|assertAlmostEqual)\b/u.test(matcher)) return 3;
  if (/\b(?:assertTrue|assertIsNotNone|assertIsNone)\b/u.test(matcher))
    return 1;
  if (matcher === "assert" && /(?:==|!=|\bis\b|\bin\b|<=|>=|<|>)/u.test(text))
    return 4;
  return 3;
}

function assertionsIn(function_: PythonFunction): AssertionObservation[] {
  const assertions: AssertionObservation[] = [];
  for (const line of function_.body) {
    const trimmed = line.text.trim();
    if (/^assert\b/u.test(trimmed)) {
      assertions.push({
        line: line.line,
        column: line.column,
        matcher: "assert",
        strength: assertionStrength("assert", trimmed),
        expectedFailure: false,
      });
    }

    for (const match of trimmed.matchAll(
      /(?:self\.)?(assert[A-Z][A-Za-z0-9_]*)\s*\(/gu,
    )) {
      const matcher = match[1];
      if (!matcher) continue;
      assertions.push({
        line: line.line,
        column: line.text.indexOf(matcher) + 1,
        matcher,
        strength: assertionStrength(matcher, trimmed),
        expectedFailure: matcher.startsWith("assertRaises"),
      });
    }

    for (const match of trimmed.matchAll(
      /\.(assert_(?:called|awaited)[A-Za-z0-9_]*)\s*\(/gu,
    )) {
      const matcher = match[1];
      if (!matcher) continue;
      assertions.push({
        line: line.line,
        column: line.text.indexOf(matcher) + 1,
        matcher,
        strength: 3,
        expectedFailure: false,
      });
    }

    if (/\bpytest\.raises\s*\(/u.test(trimmed)) {
      assertions.push({
        line: line.line,
        column: line.text.indexOf("pytest.raises") + 1,
        matcher: "pytest.raises",
        strength: 4,
        expectedFailure: true,
      });
    }
  }
  return assertions;
}

function functionIsEmpty(function_: PythonFunction): boolean {
  const meaningful = function_.body
    .map((line) => line.text.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (meaningful.length === 0) return true;
  return meaningful.every(
    (line) =>
      line === "pass" || line === "..." || /^([rubf]*)(?:'''|""")/iu.test(line),
  );
}

function decoratorTimeout(
  function_: PythonFunction,
): TimeoutObservation | null {
  for (const decorator of function_.decorators) {
    const match = /pytest\.mark\.timeout\s*\(\s*(\d+(?:\.\d+)?)\s*\)/u.exec(
      decorator.text,
    );
    if (!match?.[1]) continue;
    return {
      key: `test:${function_.name}`,
      milliseconds: Math.round(Number(match[1]) * 1000),
      line: decorator.line,
      column: decorator.column,
    };
  }
  return null;
}

export function analyzePython(source: string): TestFileAnalysis {
  const lines = source.split(/\r?\n/u);
  const functions = collectFunctions(lines);
  const tests: TestObservation[] = [];
  const skipped: MarkerObservation[] = [];
  const focused: MarkerObservation[] = [];
  const timeouts: TimeoutObservation[] = [];
  const inconclusive = new Set<string>();

  for (const function_ of functions) {
    const skipDecorators = function_.decorators.filter((decorator) =>
      SKIP_DECORATOR.test(decorator.text),
    );
    for (const decorator of skipDecorators) {
      skipped.push({
        key: `skip:${function_.name}`,
        line: decorator.line,
        column: decorator.column,
      });
    }
    for (const line of function_.body) {
      if (/\bpytest\.skip\s*\(/u.test(line.text)) {
        skipped.push({
          key: `skip:${function_.name}`,
          line: line.line,
          column: line.text.indexOf("pytest.skip") + 1,
        });
      }
    }
    const timeout = decoratorTimeout(function_);
    if (timeout) timeouts.push(timeout);
    const test: TestObservation = {
      key: function_.name,
      title: function_.name,
      skipped: skipDecorators.length > 0,
      focused: false,
      empty: functionIsEmpty(function_),
      assertions: assertionsIn(function_),
      line: function_.line,
      column: function_.column,
      ...(timeout === null ? {} : { timeout: timeout.milliseconds }),
    };
    tests.push(test);
    if (!test.skipped && !test.empty && test.assertions.length === 0) {
      inconclusive.add(`test '${test.title}' has no recognizable assertion`);
    }
  }

  if (tests.length === 0)
    inconclusive.add("no recognizable Python test functions were found");
  return { tests, skipped, focused, timeouts, inconclusive: [...inconclusive] };
}
