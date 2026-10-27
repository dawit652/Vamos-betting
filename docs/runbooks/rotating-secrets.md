# Rotating secrets

Rotate on a schedule (at least yearly for application secrets), when staff with access leave, and at once on
any suspected exposure (leaked `.env`, backup, log or screenshot). The source of truth for what each secret
protects is [deployment.md](../deployment.md#5-configuration-reference). General steps for every secret:

1. Announce a window; take a dump first (`infra/scripts/backup.sh dump`).
2. Generate the new value (`openssl rand -hex 32`), store it in the secret manager, update `infra/.env.prod`.
3. Apply: `docker compose up -d` recreates only the services whose environment changed.
4. Verify (`scripts/smoke.sh`, the specific check below), record who/when/why, destroy the old value.

## ADMIN_TOTP_KEY (staff authenticator secrets)

The key encrypts each staff member's TOTP secret at rest (AES-256-GCM, stored as `v1.<iv>.<ciphertext>.<tag>`
and bound to the staff account id). A rotation re-encrypts the stored secrets with `totp-rekey`, so nobody
re-enrols. Losing the key is different: nothing decrypts any more and every staff member must re-enrol
(below). That is why the key is kept in the secret manager and sealed with the backups' keys.

**Scheduled rotation (the old key is still known):**

1. Agree a short window (staff sign-in fails between steps 2 and 3; open sessions keep working).
2. Re-encrypt every secret under the new key, in one transaction (every secret moves or none does):
   ```bash
   docker compose run --rm -T -e ADMIN_TOTP_KEY_PREVIOUS='<old key>' -e ADMIN_TOTP_KEY='<new key>' \
     migrate node dist/ops/totp-rekey.js
   ```
   It prints the count and is audited as `staff.totp_rekeyed`. A repeat changes nothing. If one secret
   decrypts with neither key, it stops, names the account and changes nothing.
3. Set the new `ADMIN_TOTP_KEY` in the secret store and `infra/.env.prod`; recreate `api` and `worker`
   (`docker compose up -d api worker`). Ask one staff member to sign in to verify.

**Lost key, or the old key leaked together with a database copy:**

1. List active staff (`GET /admin/staff`, or the back office) and agree a window; tell them to expect to
   re-enrol. Sessions already open keep working until they expire (30 min idle / 12 h absolute).
2. Set the new `ADMIN_TOTP_KEY` and recreate `api` and `worker` (the key is also read by the ops scripts).
3. Create a break-glass admin **under the new key** (the old admins cannot sign in):
   ```bash
   docker compose run --rm -T -e ADMIN_PASSWORD='<12+ chars>' migrate node dist/ops/admin-create.js \
     --email breakglass@example.et --name "Break glass" --role admin
   ```
   Scan the printed `otpauth://` URI into an authenticator; sign in at the admin site.
4. For every other staff account: `POST /admin/staff/:id/reset-totp` (permission `staff.manage`; audited
   as `staff.totp_reset`). The response carries the new secret **once**; hand it to the person over a
   secure channel; they sign in with their password and the new code.
5. Verify every staff member signed in; then disable the break-glass account (or keep it sealed, with its
   own TOTP, for emergencies) and note it in the log.
6. If the old key leaked together with a database copy, treat the TOTP secrets as compromised (this
   procedure covers it) **and** force password changes for all staff.

Never reuse the published development key (production and licensed mode refuse it).

## SESSION_SECRET

Despite its name it does not sign sessions (session tokens live in the database). It keys the HMACs of
**OTP codes** and of the **Fayda ID number hash** that enforces one account per person. Effects of rotating:
OTP codes in flight stop working (players request a new one; harmless), and existing ID hashes no longer
match new ones, so the duplicate-ID check will not catch IDs verified before the rotation. The plain numbers
are not stored (only the last four digits), so the hashes cannot be recomputed.

Rotate only on a suspected leak. Accept the duplicate-check gap, or re-run KYC verification for active players
afterwards (compliance decides). Set the new value, recreate `api` and `worker`, and ask a test player to
register (OTP) to verify.

## PASSWORD_PEPPER (password hashes)

The pepper is argon2's secret key for every player and staff password hash (stored as `pepper1:$argon2id$…`;
ASVS 2.4.5). It never leaves the secret store and the database alone cannot be cracked offline. **There is
one active pepper and no re-hashing tool**: changing or losing it makes every peppered password unusable.

- Rotate only on a suspected leak of the pepper **together with** a database copy (the pepper alone is
  useless). Set a new value and recreate `api` and `worker`: every player then resets the password with an
  SMS code (the login page offers it), and staff passwords are reset by an admin (`POST
/admin/staff/:id/reset-password`) or with `admin-create` for a break-glass account. Announce it first.
- Hashes made before a pepper was first set keep working and are replaced at the next successful sign-in.
- Keep a sealed copy with `ADMIN_TOTP_KEY` and the backup keys: a restore needs the same pepper.

## Database and Redis passwords

- **Postgres owner** (`POSTGRES_USER`, used only by the migrate job and the ops scripts):
  `docker compose exec postgres psql -U vamos -d vamos -c "ALTER USER vamos PASSWORD '<new hex>'"`, then
  set `POSTGRES_PASSWORD` and run `docker compose run --rm migrate` to confirm the new URL works (the
  `postgres` container keeps the password in its data directory; the environment value only matters for
  first initialisation and for the migrate job's URL).
- **App role** (`vamos_app`, the api and worker): set a new `APP_DB_PASSWORD`, then
  `docker compose run --rm migrate` (it sets the role's password) and `docker compose up -d api worker`.
  Connections already open keep working until the restart.
- **Redis:** set `REDIS_PASSWORD`, then `docker compose up -d redis api worker` (a short outage; queues are
  rebuilt from the outbox).

## Provider and channel secrets

Coordinate both sides, because there is one active secret at a time:

- **Chapa** (`CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, 32+ chars) and **telebirr** (`TELEBIRR_*` keys): create
  the new credentials in the provider dashboard, update the environment, recreate `api` and `worker`. Webhooks
  signed with the old secret during the switch are retried by the provider, and intents with a reference are
  polled for 24 h, so nothing is lost; watch the payments for 30 minutes.
- **`SMS_WEBHOOK_SECRET` / `USSD_SHARED_SECRET`** (only while a channel is on): agree a time with the
  aggregator; inbound messages fail authentication between the two changes.
- **`MOCK_PAYMENT_WEBHOOK_SECRET`**: demo only.

## Backup encryption (age) and TLS

- New backups use a new `BACKUP_AGE_RECIPIENT`; **keep the old identity** for as long as the old backups are
  retained (up to 7 years). Test with the [restore drill](../backups.md#5-restore-drill).
- TLS certificates: automatic with the Caddy profile; with your own balancer, follow its renewal process and
  alert 14 days before expiry.

## Staff passwords

Self-service in the back office (Account); an admin can reset TOTP (above) and unlock lockouts
(`docker compose run --rm migrate node dist/ops/admin-unlock.js --email <address>`). Generated passwords must
be changed at first sign-in.
