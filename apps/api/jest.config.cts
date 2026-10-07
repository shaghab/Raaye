module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  moduleNameMapper: {
    '^firebase-admin/app$': '<rootDir>/../../libs/server/src/testing/firebase-admin-app.stub.ts',
    '^firebase-admin/auth$': '<rootDir>/../../libs/server/src/testing/firebase-admin-auth.stub.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api'
};
