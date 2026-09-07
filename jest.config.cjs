module.exports = {
  // Jest defaults its cache to /tmp, which on this machine is a 15 GB tmpfs —
  // i.e. RAM. A full coverage run over 43 suites grew it past 1 GB and pushed
  // the filesystem to its limit, at which point unrelated writes started
  // failing with EDQUOT and runs failed for reasons that looked like code
  // errors. Keeping the cache on disk costs nothing and removes the trap.
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',

  preset: 'ts-jest',
  testEnvironment: 'node',
  maxWorkers: 1,
  // The sweep imports all 820 tool modules, and with coverage instrumentation
  // the worker grows past 3 GB, which on a workstation is the difference
  // between a run in the background and a machine that cannot open anything
  // else. Recycling the worker when it goes over keeps the peak bounded.
  workerIdleMemoryLimit: '900MB',
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
      // Every branch in src/utils is either taken by a test or marked as
      // unreachable with the reason; the margin is for the handful that only
      // the failing-filesystem sweep reaches, so a partial run still passes.
      branches: 99,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './src/transport/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
