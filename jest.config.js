/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          // Override TS module settings for Jest's CommonJS runtime.
          // `isolatedModules: true` already lives in the root tsconfig.json,
          // so we don't need to repeat it here (and ts-jest deprecates the
          // duplicated option in v30).
          module: 'CommonJS',
          moduleResolution: 'node',
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/__tests__/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/vendor/',
    '<rootDir>/src/__tests__/setup.ts',
    '<rootDir>/src/__tests__/__mocks__/',
  ],
};
