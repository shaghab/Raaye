import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env automatically. Local development keeps DATABASE_URL in
// .env (copied from .env.example); Docker and CI pass it through the environment.
if (!process.env['DATABASE_URL'] && existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'pnpm db:seed',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://raaye:raaye@127.0.0.1:5432/raaye',
  },
});
