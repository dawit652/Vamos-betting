import { loadConfig, loadDotEnv } from '@vamos/config';
import { setAppRolePassword } from '../app-role';
import { createDb } from '../client';
import { runMigrations } from '../migrate';

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const applied = await runMigrations(handle.db);
  console.warn(applied ? 'migrations applied' : 'no migrations to apply yet');
  // Production: the api and worker connect as the app role (migration 0030); its password comes
  // from the environment of this job only, never from a migration file.
  const appPassword = process.env.APP_DB_PASSWORD;
  if (appPassword !== undefined && appPassword !== '') {
    await setAppRolePassword(handle.db, appPassword);
    console.warn('app role vamos_app: login enabled with APP_DB_PASSWORD');
  }
} finally {
  await handle.close();
}
