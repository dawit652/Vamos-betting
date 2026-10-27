import { loadConfig, loadDotEnv } from '@vamos/config';
import { createPasswordHasher } from '../backoffice/argon2';
import { seedDemoStaff } from '../backoffice/demo-staff';
import { createDb } from '../client';
import { seed } from '../seed/index';

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const summary = await seed(handle.db, { mode: config.mode });
  // DEMO ONLY (never in licensed mode or with NODE_ENV=production): one staff account per role.
  const staff = await seedDemoStaff(
    {
      db: handle.db,
      clock: () => new Date(),
      totpKey: config.admin.totpKey,
      passwords: createPasswordHasher(config.passwordPepper),
    },
    { mode: config.mode, nodeEnv: config.nodeEnv },
  );
  console.warn(
    `seed complete: ${JSON.stringify({ ...summary, demoStaffCreated: staff.created })}` +
      (staff.skipped === null ? '' : ` (demo staff skipped: ${staff.skipped})`),
  );
} finally {
  await handle.close();
}
