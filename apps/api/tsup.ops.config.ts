import { defineConfig } from 'tsup';

/**
 * Operational scripts for the production image (`pnpm --filter @vamos/api exec tsup --config tsup.ops.config.ts`): the same
 * scripts as `pnpm db:migrate`, `db:seed`, `admin:create`, `admin:unlock` and `admin:totp-rekey`, bundled so the
 * image needs neither tsx nor the TypeScript sources. `migrate.js` reads the SQL migrations from
 * `dist/migrations` (the Dockerfile copies `packages/db/migrations` there).
 */
export default defineConfig({
  entry: {
    migrate: '../../packages/db/src/scripts/migrate.ts',
    seed: '../../packages/db/src/scripts/seed.ts',
    'admin-create': '../../packages/db/src/scripts/admin-create.ts',
    'admin-unlock': '../../packages/db/src/scripts/admin-unlock.ts',
    'admin-reset': '../../packages/db/src/scripts/admin-reset.ts',
    'totp-rekey': '../../packages/db/src/scripts/totp-rekey.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist/ops',
  clean: false,
  sourcemap: false,
  noExternal: [/^@vamos\//],
});
