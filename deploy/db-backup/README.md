# Daily database backup

The database server dumps every database and the roles, packs the configuration listed in `config_paths`
(PostgreSQL, PgBouncer, job settings), encrypts, verifies, and sends the files to a backup server.
Not included: the passphrase and SSH key, other servers (GeoServer data, application `.env`, web server).

| File | Runs on |
|---|---|
| `backup.py`, `urida-db-backup.service`, `urida-db-backup.timer` | database server, as root, daily at 18:30 UTC |
| `receive.py` | backup server, as the only command the database server's key may run |
| `policy.py`, `test_policy.py` | retention and disk rules, used by both |

Each server has the script folder `/opt/db-backup` and stores backups in `/var/backups/urida-db`.
Config: `backup.json` / `receive.json` (see the examples).

## Rules

- Kept: the newest 7 daily sets and the newest set of each of the last 4 weeks; at most 30 GB, oldest removed first;
  the newest 2 sets are never removed. Old sets are removed only after a new one is complete.
- The backup server refuses a file if less than 50 GB would stay free (database server: 100 GB).
- Only files matching the backup name pattern are ever removed.
- The database server's key can store files and finish a set. It cannot read, overwrite, delete or run commands.

## Restore

The passphrase is in `/root/.urida_backup_passphrase` on the database server. **Keep a copy elsewhere**: without
it the backups cannot be opened.

    gpg -d --passphrase-file KEY <stamp>_<database>.gpg > database.dump
    pg_restore -d <new empty database> database.dump      # same PostgreSQL major version or newer
    gpg -d --passphrase-file KEY <stamp>_globals.gpg      # roles
    gpg -d --passphrase-file KEY <stamp>_serverconfig.gpg | tar -xzf - -C <empty folder>   # configuration

## Checks

    systemctl status urida-db-backup      journalctl -u urida-db-backup
    systemctl list-timers urida-db-backup.timer

Not included: alerts to a person on failure, point-in-time recovery, a scheduled restore test.
