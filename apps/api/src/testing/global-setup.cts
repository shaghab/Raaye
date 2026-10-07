const { execSync } = require('node:child_process');
const path = require('node:path');

/** Apply checked-in migrations to the test database before integration tests run. */
module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, '../../../..');
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgresql://raaye:raaye@127.0.0.1:5432/raaye_test';
  execSync('pnpm exec prisma migrate deploy', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
};
