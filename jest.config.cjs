module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  maxWorkers: 1,
  forceExit: true,
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: {
        ignoreCodes: [5108],
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  // Coverage is collected across the whole tree so Codecov reports the real
  // picture, but the gate applies only where it carries meaning.
  //
  // src/utils/ is the five-layer security pipeline every tool call passes
  // through — input validation, path guarding, audit logging, DLP and the
  // output size cap — and it is what the 363 tests actually target.
  //
  // A global threshold instead measured the 820 thin introspection modules in
  // src/tools/, which have no unit tests of their own, dragging the number to
  // ~1.6% and making the gate unenforceable. Scoping it keeps a real floor
  // (currently ~61% statements) that cannot silently regress.
  //
  // Floors sit just under the measured values so an accidental regression
  // fails the build, while a normal refactor that shifts a few statements
  // does not. Raise them when coverage genuinely improves.
  coverageThreshold: {
    './src/utils/': {
      branches: 85,
      functions: 96,
      lines: 96,
      statements: 96,
    },
  },
};
