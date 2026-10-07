module.exports = {
  displayName: 'api-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.int-spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^firebase-admin/app$': '<rootDir>/../../libs/server/src/testing/firebase-admin-app.stub.ts',
    '^firebase-admin/auth$': '<rootDir>/../../libs/server/src/testing/firebase-admin-auth.stub.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  globalSetup: '<rootDir>/src/testing/global-setup.cts',
  maxWorkers: 1,
  testTimeout: 90000,
  coverageDirectory: '../../coverage/apps/api-integration',
};
