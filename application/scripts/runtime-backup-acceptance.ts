/** Fresh-fixture acceptance only; never points at an original Desktop profile.
 * SQLite: node --import tsx scripts/runtime-backup-acceptance.ts
 * PostgreSQL: MORPHZ_MESSAGE_SMOKE_POSTGRES_URL=<isolated test database> ...
 */
process.env.MORPHZ_MESSAGE_SMOKE_BACKUP = "1";
await import("./platform-message-runtime-smoke.js");
