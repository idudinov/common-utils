# Zajno's Toolbox – MobX

Moved from [Zajno/common-mobx](https://github.com/Zajno/common-mobx). Now maintained at [idudinov/common-utils](https://github.com/idudinov/common-utils).

This library is an extension for [`@zajno/common`](../common), which adds more tools but based on [MobX](https://mobx.js.org/) library.

All runtime dependencies are peer.

## Contents

* [Localization](./src/localization/LocalizationManager.ts) – attempt to have another simple runtime i18n manager

* [ViewModels]('./src/viewModels/index.ts') – useful for MVVM pattern

* Structures for caching & observing: [`PromiseCacheObservable`](./src/structures/promiseCache.ts) — a thin `PromiseCache` preset wired to a mobx storage provider (also exported standalone as `mobxStorageProvider`, for composing custom presets), [`SubscribersMap`](./src/structures/subscribersMap.ts), [`SubscribersPromiseCache`](./src/structures/subscribersPromiseCache.ts)

* [`TransitionObserver`](./src/observing/transition.ts) – neat wrapper of mobx's `reaction`

* [`LazyObservable` & `LazyPromiseObservable`](./src/lazy/observable.ts)

* and various extends to `@zajno/common`'s tools to make them MobX-observable.

## Usage

ESM-only as of `2.1.0` (no CJS build). Subpath-only imports (no root import) by design, for tree-shaking. Requires Node `>=20`.

Install:

```
npm i @zajno/common-mobx
```

See usage & distribution notes from `@zajno/common`'s [README](../common/README.md#usage).
