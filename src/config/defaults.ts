export const DEFAULT_CONFIG = `version: 1

testIntegrity:
  existingTests: immutable
  allowNewTests: true
  blockDeletedTests: true
  blockSnapshotChanges: true
  blockSkippedTests: true
  blockFocusedTests: true
  blockAssertionRemoval: true
  blockAssertionWeakening: true
  blockTimeoutIncreases: true

coverage:
  blockThresholdReductions: true
  blockNewExclusions: true

validation:
  protectScripts: true
  allowInspectionOnlyCompletion: false
  commands: []
  # - name: lint
  #   command: npm run lint
  #   timeoutSeconds: 120
  # - name: typecheck
  #   command: npm run typecheck
  #   timeoutSeconds: 120
  # - name: tests
  #   command: npm test
  #   timeoutSeconds: 300

paths:
  testPatterns:
    - "**/*.test.{js,jsx,ts,tsx}"
    - "**/*.spec.{js,jsx,ts,tsx}"
    - "**/__tests__/**"
    - "test/**"
    - "tests/**"
    - "**/test_*.py"
    - "**/*_test.py"
  snapshotPatterns:
    - "**/__snapshots__/**"
    - "**/*.snap"
  protectedPatterns: []
  ignoredPatterns:
    - "node_modules/**"
    - "dist/**"
    - "build/**"
    - ".git/**"
    - ".judgelock/**"

receipt:
  directory: ".judgelock/receipts"
  retainCommandOutputCharacters: 8000

ci:
  allowPolicyChanges: false
`;
