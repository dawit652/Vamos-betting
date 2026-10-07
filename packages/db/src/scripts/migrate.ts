import { loadConfig, loadDotEnv } from '@vamos/config';
import { createDb } from '../client';
import { runMigrations } from '../migrate';

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const applied = await runMigrations(handle.db);
  console.warn(applied ? 'migrations applied' : 'no migrations to apply yet');
} finally {
  await handle.close();
}
