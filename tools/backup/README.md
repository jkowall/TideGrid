# Backup tooling (W3-OPS-6)

Scripts for TideGrid's daily encrypted logical backup and its restore drills. The [backup and restore runbook](../../docs/runbooks/backup-and-restore.md) says when and how to use them; the [hosting plan](../../docs/v2/08-build-hosting-and-operations.md#backup-and-disaster-recovery) says why.

| Script | What it does |
|---|---|
| `backup.sh` | `pg_dump` (custom format) of the whole database from one exported snapshot, checks that the dump reads back, encrypts it to an age public key, and writes a manifest: migrations, each table's row count and row digest, roles, checksums, sizes, timings |
| `restore.sh` | Restores one backup into an empty database only (`--throwaway`, and it refuses a target with tables), creates missing roles without login, then runs `verify.py` |
| `verify.py` | Compares a database with a manifest: migrations, every table's rows (exactly, or present only for a point-in-time branch), row-level security still forced, the runtime role sees nothing with no tenant set, and only its own tenant's rows with one set |
| `backup-age.sh` | Lists the backup bucket and fails when the newest manifest is older than a limit (26 hours by default) |
| `install-tools.sh` | Installs the PostgreSQL 17 client and age on a GitHub Ubuntu runner |

Rules the scripts keep:

- The private key never meets the backup side. `backup.sh` takes only the age public key. Whoever holds the database or the Cloudflare account cannot read a backup.
- Plaintext dumps live only in a private temporary directory and are removed on exit.
- Nothing prints a row's contents, a host, or a connection string. In GitHub Actions, `tg_mask_url` in `lib.sh` hides the host too, because this repository's logs are public.
- Every check query is read-only. The tenant probes run as `tidegrid_app` inside a transaction that is always rolled back.
- `backup.sh` needs the direct (unpooled) endpoint: a pooled connection cannot share its snapshot with `pg_dump`. It refuses a role that cannot bypass row-level security, which would otherwise dump empty tables without complaint.

On a Mac: `brew install libpq age`, put libpq's `bin` on `PATH`, and use `bash` 3.2 or later (the system one works). `backup-age.sh` uses GNU `date`; run it in CI or with `coreutils`.
