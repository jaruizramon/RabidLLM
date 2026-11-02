Answer API questions from the version this project actually installed — never from the latest release notes.

`resolve` reads the lockfile (`Cargo.lock`, `package-lock.json`; at a monorepo root it also checks immediate children) and reports:

- **duplicate majors** first: the same package installed under two breaking generations at once, e.g. `http 0.2.12, 1.5.0` or `tower 0.4.13, 0.5.3`. This is the single most useful signal that a dependency pair cannot interoperate.
- **direct dependencies** as `declared → resolved`, so a manifest range (`axum = "0.6"`) and the locked version (`0.6.20`) are visible together.

`api` locates a symbol in the installed source on disk (cargo registry, `vendor/`, or `node_modules`) and prints the definition with a little context. It is offline and version-exact. A zero-match answer is authoritative: that symbol does not exist in that version, which is how a 0.7/0.8 idiom is caught before it becomes a build error. When two versions of the package are installed, both are searched and labelled.

Workflow:
1. Before writing an unfamiliar API, `deps resolve` — note the resolved version and any duplicate majors.
2. Then `deps api` for the exact symbol, or `read` the crate's own docs/examples under the printed source root.
3. Treat the compiler as confirmation, not as the first source of truth.

Do not fetch "the latest" documentation for a pinned project: latest is a different major, and its signatures will not compile here. Upgrade decisions are explicit, not implied by looking up docs.

Limits: `context` 0–6 lines (default 2), `limit` 1–25 matches (default 8), 4,000 files scanned per version.
