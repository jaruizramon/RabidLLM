# deps

> Resolved dependency versions, duplicate breaking majors, and symbol lookup in the installed source — answered from the lockfile and the code on disk, never from the registry head.

## Source
- Entry: `packages/coding-agent/src/tools/deps.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/deps.md`
- Registration: `packages/coding-agent/src/tools/index.ts` (`BUILTIN_TOOLS`), `tools/builtin-names.ts`, `tools/essential-tools.ts`.

## Inputs

| Field | Required | Meaning |
| --- | --- | --- |
| `op` | yes | `resolve` or `api`. |
| `path` | no | Project directory, resolved against the session cwd. Defaults to the cwd. |
| `ecosystem` | no | Force `cargo` or `npm` instead of detecting from lockfiles. |
| `package` | `api` | Package name as it appears in the lockfile. |
| `symbol` | `api` | Type, function, trait, or export name. |
| `context` | no | Source lines kept around each match, 0–6 (default 2). |
| `limit` | no | Maximum matches, 1–25 (default 8). |

## Behaviour

- **Detection.** Reads `Cargo.lock`/`Cargo.toml` and `package-lock.json`/`package.json`. At a directory with no lockfile it checks immediate children, so a monorepo root reports both `backend/Cargo.lock` and `frontend/package-lock.json`.
- **Duplicate majors.** Packages installed under more than one breaking bucket. Semver below 1.0 uses the minor as the breaking component: `0.4.13` → `0.4`, `0.6.20` → `0.6`, `1.5.0` → `1`. Ranking is: declared directly in the manifest first, then packages with the most dependents. That is what surfaces `http 0.2.12, 1.5.0` / `hyper 0.14.32, 1.12.0` / `tower 0.4.13, 0.5.3` ahead of platform-only noise such as `windows-sys`.
- **Direct dependencies** print as `declared → resolved`, so a manifest range (`axum = "0.6"`) and its lock (`0.6.20`) are visible together, and a declared package missing from the lock is labelled.
- **`api`** resolves the package's version(s) from the lockfile, then searches the installed source: `<project>/vendor/<name>/src` or `$CARGO_HOME/registry/src/*/<name>-<version>/src` for cargo, `<project>/node_modules/<name>` for npm. Multiple installed versions are each searched and labelled.
- **Definitions only.** Cargo matches `pub struct|enum|trait|type|const|static|union|fn`, `impl … <Symbol>`, and `macro_rules!`; npm matches exported declarations and `exports.<Symbol>`. A zero-match result is authoritative and says so, which is how an API that belongs to another major is caught before the build.
- Offline. No network access, no registry queries, no "latest version" lookup.
- ASCII-safe output; paths shortened to `~`; 4,000 files scanned per version, 1 MiB per file.

## Errors

- No lockfile under the path or its children → `no Cargo.lock or package-lock.json under <path>`.
- `api` for a package absent from the lockfile → `not in <lockfile>; run deps resolve`.
- `api` for a package whose source is not on disk → reported, with the hint to build once or vendor it.

## Why it exists

A model writing an API from memory against the latest documentation is wrong the moment the project pins an older major. The measured failure was an axum 0.6 project receiving 0.7/0.8 idioms (`axum::serve`, bare `Next`), 39 failed builds, and a commented-out route. `resolve` exposes the version split before the first compile; `api` answers "does this symbol exist in the version I have?" from the exact source the compiler will use.
