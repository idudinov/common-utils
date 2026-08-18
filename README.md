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

[`packages/scripts`](./packages/scripts) is a private, unpublished workspace exposing a single `task` bin (backed by TypeScript run directly via Node's built-in type stripping). Each leaf package's `scripts` block proxies to it, e.g. `"build": "task build"`, so the shell command for every task lives once in [`packages/scripts/tasks.json`](./packages/scripts/tasks.json) instead of being duplicated per package.
