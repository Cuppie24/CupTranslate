# CupTranslate

Tauri + React tray-popup translation app.

## Bug tracking

Every problem investigated in this project — root cause findings, log evidence,
hypotheses, fixes tried and their outcome, and current status — must be
documented in a dedicated file under `docs/`, one file per problem
(`docs/<short-kebab-case-topic>.md`). Do not let this history live only in chat.

- When starting work on a new problem, check `docs/` first for an existing file
  on the same topic and append to it (with a dated entry) rather than starting
  fresh or duplicating.
- When a problem is resolved, update the file's status and record the actual
  fix — don't just leave it as "investigating."

Known problem files:

- [docs/window-centering-bug.md](docs/window-centering-bug.md) — popup opens
  off-center on multi-monitor / mixed-DPI setups; status: investigating.
