import { loadConfig, loadDotEnv } from '@vamos/config';
import { createDb } from '../client';
import { seed } from '../seed/index';

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const summary = await seed(handle.db);
  console.warn(`seed complete: ${JSON.stringify(summary)}`);
} finally {
  await handle.close();
}
