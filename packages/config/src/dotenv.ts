import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the repository-root `.env` file (if any) into `process.env` without
 * overriding variables that are already set. Walks up from `startDir` until
 * it finds the workspace root (the directory containing pnpm-workspace.yaml).
 */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (existsSync(file)) {
        process.loadEnvFile(file);
        return file;
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
