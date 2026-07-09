## Migration guidelines
- When a persisted data or config format changes, write a one-shot, idempotent migration that runs at startup and upgrades old state in place — don't scatter format checks through application code.
- Application code assumes the current format only: no read-time dual-shape parsing, no legacy key aliases, no "back-compat" defaults.
- Migrations must self-check "already applied" and no-op if so; never destroy data you can't reconstruct — move it aside instead of deleting it.
- APIs with no external consumers owe no stability guarantee — change the API and its callers together instead of keeping an old shape alive "just in case."
- Exception: tolerate read-time variance only for formats owned by external tools you can't migrate (e.g. a third-party CLI's session files); everything you own gets migrated, not shimmed.
