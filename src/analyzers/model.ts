export interface SourceLocation {
  line: number;
  column: number;
}

export interface AssertionObservation extends SourceLocation {
  matcher: string;
  strength: number;
  expectedFailure: boolean;
}

export interface TestObservation extends SourceLocation {
  key: string;
  title: string;
  skipped: boolean;
  focused: boolean;
  empty: boolean;
  assertions: AssertionObservation[];
  timeout?: number;
}

export interface MarkerObservation extends SourceLocation {
  key: string;
}

export interface TimeoutObservation extends SourceLocation {
  key: string;
  milliseconds: number;
}

export interface TestFileAnalysis {
  tests: TestObservation[];
  skipped: MarkerObservation[];
  focused: MarkerObservation[];
  timeouts: TimeoutObservation[];
  inconclusive: string[];
}

export class SourceAnalysisError extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(
    message: string,
    options: { line?: number; column?: number } = {},
  ) {
    super(message);
    this.name = "SourceAnalysisError";
    this.line = options.line;
    this.column = options.column;
  }
}
