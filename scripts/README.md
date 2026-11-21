# Scripts

These tools are grouped here to keep application modules and runtime data separate.

- `misty-*.mjs`, relay workers and gateway launchers implement the connected services.
- `install-*.ps1`, `start-*.ps1` and service templates support a configured installation.
- `deploy-*`, `activate-*`, `migrate-*`, `prepare-*`, `finish-*`, `rollback-*` and dated scripts are historical maintenance references. Review and adapt them before use; they are not a fresh-install sequence.
- `check-*`, `verify-*`, `benchmark-*` and `audit-*` contain optional diagnostics. Some require a deliberately configured live installation.
- Database backups, server inventories, linked-device sessions and generated reports belong in ignored local data directories.

The private Discord server list is not distributed. Configure `MISTY_DISCORD_SERVER_IDS` or `MISTY_DISCORD_SERVER_IDS_FILE` for an explicitly selected allowlist. An absent list permits no Discord server through that legacy composer.