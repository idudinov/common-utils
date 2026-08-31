# Zajno's Toolbox
[![Coverage Status](https://coveralls.io/repos/github/idudinov/common-utils/badge.svg)](https://coveralls.io/github/idudinov/common-utils)
[![CI](https://github.com/idudinov/common-utils/actions/workflows/ci-report-coverage.yml/badge.svg)](https://github.com/idudinov/common-utils/actions/workflows/ci-report-coverage.yml)

A monorepo for Zajno's internal tools and utilities.

1. [@zajno/common](./packages/common)
1. [@zajno/common-mobx](./packages/common-mobx)
1. [@zajno/common-firebase](./packages/common-firebase)
1. [@zajno/common-web](./packages/common-web)
1. [@zajno/eslint-config](./packages/eslint-config)

## Shared task runner

All build/test/lint commands live in one place: [`packages/scripts`](./packages/scripts), a private workspace with a single `task` bin (TypeScript, run by Node directly). Each package's npm scripts proxy to it, e.g. `"build": "task build"`.

### Usage

- Run tasks from a package dir: `npm run <task>`.
- Do not call `tsc` / `vitest` / `eslint` directly — the tasks carry the right configs.
- `npm run dev` from the repo root type-checks every package in one watching `tsc` process — sources, tests, `packages/common/utils` and `packages/scripts` (see [`tsconfig.dev.json`](./tsconfig.dev.json)). It also refreshes `dist/`, since each package's check project references the sibling `dist` projects it depends on.
- Args after `--` are passed to the underlying command. Example — run one test:

```sh
npm run test -- src/lazy/__tests__/promise.test.ts -t "test name"
```

### Tasks

Defined in [`tasks.json`](./packages/scripts/tasks.json); these forward extra args.

| Task | Command |
| --- | --- |
| `build` | `tsc -b tsconfig.dist.json` |
| `check` | `tsc -p tsconfig.json --noEmit` |
| `lint` | `eslint src/**/*.ts?(x)` |
| `test` | `vitest run --coverage` |
| `dev` (alias `build:w`) | `tsc -b --watch` |
| `clean` | `rimraf ./dist *.tsbuildinfo` |

### Actions

Implemented in [`actions.ts`](./packages/scripts/actions.ts), run in-process:

- `bundle` — copies LICENSE, package.json, and READMEs into `dist/`, then regenerates its `exports` map.
- `update-exports` — regenerates the package's `exports` map from `src/`.
- `check:versions` — checks that dependency versions match across packages.

### Composites

Sequences of the above; these do not forward args.

- `build:clean` — clean, build
- `build:full` — build:clean, lint, test
- `check:publish` — build:clean, bundle, publint, attw
- `publish:local` — build:full, bundle, yalc push from `dist/`
- `publish:from-dist` — build:full, bundle, npm publish from `dist/`
