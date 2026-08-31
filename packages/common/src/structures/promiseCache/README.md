# PromiseCache

A key-value cache for async data that goes well beyond a simple `Map<string, Promise>`. Provide a fetcher function, and `PromiseCache` handles the rest:

- **Deduplication** — concurrent `get()` calls for the same key share a single in-flight promise
- **Synchronous access** — `getCurrent()` returns the resolved value instantly; `getLazy()` gives a reactive `ILazyPromise<T>` handle
- **Per-key error tracking** — fetch failures are stored, logged, and forwarded to an optional callback
- **Stale-while-revalidate** — invalidated items remain readable; `refresh(key)` re-fetches without clearing the stale value
- **Invalidation** — time-based TTL, custom callback, or both; `notify`/`silent` modes for internal vs. observable removal
- **Safe `clear()`** — a version counter prevents stale in-flight fetches from silently re-populating the cache
- **Composable storage** — a `storage` provider supplies the observable primitives, so MobX, Vue, or any other reactivity system plugs in without subclassing
- **Extensible** — `extend()` wraps the fetcher, augments the instance shape, and hooks into store/invalidate/clear, mirroring `LazyPromise.extend`; batching and eviction ship as extensions

This README covers concepts and usage. The reference for individual members is the docstrings in the source, primarily [`types.ts`](types.ts) and [`extensions.ts`](extensions.ts).

## Quick Start

```ts
import { PromiseCache } from '@zajno/common/structures/promiseCache';

// 1. Create a cache with an async fetcher
const userCache = new PromiseCache<User>(async (id: string) => {
    const res = await fetch(`/api/users/${id}`);
    return res.json();
});

// 2. Fetch (deduplicates concurrent calls for the same key)
const user = await userCache.get('user-42');

// 3. Read synchronously (returns cached value or undefined; triggers fetch by default)
const current = userCache.getCurrent('user-42');

// 4. Get a lazy handle — same ILazyPromise<T, TInitial> interface as standalone LazyPromise
const lazy = userCache.getLazy('user-42');
lazy.value;         // T | TInitial (triggers fetch if not started; TInitial defaults to undefined)
lazy.currentValue;  // T | TInitial (passive, no fetch)
lazy.isLoading;     // boolean | null (null = not started)
lazy.error;         // unknown
await lazy.promise; // Promise<T | TInitial>
await lazy.refresh(); // re-fetches while keeping stale value available

// 5. Provide an initial value to eliminate undefined from the type
const typedCache = new PromiseCache<User>(fetchUser)
    .useInitialValue({ name: 'Loading...', id: '' });
const typedLazy = typedCache.getLazy('user-42');
typedLazy.value;    // User (never undefined — initial value used before fetch)
await typedLazy.promise; // Promise<User>
```

## The Contract

[`types.ts`](types.ts) defines two interfaces, mirroring `ILazyPromise` / `IControllableLazyPromise` at the collection level:

- `IPromiseCache<T, TKey, TInitial>` — consumption. Reading via `get`/`getLazy`/`getCurrent` may trigger a fetch; every other member is passive.
- `IControllablePromiseCache<T, TKey, TInitial>` — adds manipulation: `set`, `invalidate`, `clear`.

`PromiseCache` implements the controllable one; code that only reads should depend on `IPromiseCache`.

## Configuration

### Constructor options

`new PromiseCache(fetcher, options?)` takes two options:

- `storage` — a `PromiseCacheStorageProvider` supplying the observable primitives backing the cache: a keyed map, a value box, and an optional `transaction` batcher for reactivity systems that need mutations grouped into one change batch. This is what makes `PromiseCacheObservable` (`@zajno/common-mobx`) a thin preset instead of a subclass full of overrides. Default: plain `Map` and a `Model` box, no batching.
- `prepareValue` — pre-processes a value (fetched or injected via `set()`) before it's stored. Useful for wrapping it in an observable, e.g. `observable.object`.

### Fluent `use*` builders

All return `this` for chaining.

```ts
cache.useInvalidation({ expirationMs: 60_000 });          // time-based TTL
cache.useInvalidation({ invalidationCheck: (key, value, cachedAt) => value?.isStale === true });
cache.useInvalidation(null);                              // disable

cache.useOnError((key, error) => reportToSentry(error, { cacheKey: key }));

cache.useInitialValue({ name: 'Loading...', id: '' });    // static
cache.useInitialValue((key) => ({ name: 'Loading...', id: key })); // per-key factory

cache.useLoadingState({ revalidating: false });           // silence the spinner on passive re-fetch
```

`useInvalidation`'s config object is stored by reference (not destructured), so getter-based fields are re-evaluated on every access — useful for dynamic policies:

```ts
let ttl = 60_000;
cache.useInvalidation({ get expirationMs() { return ttl; } });
// later: ttl = 5_000 — takes effect immediately
```

`useInitialValue`'s value is **not** stored in the cache — it's a synthetic default (same as `LazyPromise`'s initial value); `getHasValue` stays `false` until a real fetch completes.

`useLoadingState` overrides what `getIsLoading`/`getLazy().isLoading` report for one or more pending states, cache-wide. `getLazy(key, strategy)` accepts the same shape per-handle: named states report the handle's own value, unnamed states fall through to the cache-level report.

| Pending state | Trigger | Default `isLoading` |
|---|---|---|
| `'loading'` | no usable value (first load, cold refresh, retry after error) | `true` |
| `'revalidating'` | stale value, passive `get()`/`.value` on expiry | `false` |
| `'refreshing'` | stale value, explicit `refresh()` | `false` |

### Logging

Inherited from `Loggable`: `cache.setLoggerFactory(createLogger, 'UserCache')`, or `cache.setLogger(myLoggerInstance)`.

## Invalidation & Eviction

`useInvalidation()` accepts an `InvalidationConfig<T>`: a time-based TTL (`expirationMs`), a custom check (`invalidationCheck`), or both.

Invalidated items stay readable via `getCurrent()` (stale-while-revalidate). `sanitize()` sweeps them out and returns the removed count.

`invalidate(key, mode?)` has two modes:

- `'notify'` (default) — fires `onInvalidated`.
- `'silent'` — internal housekeeping (e.g. eviction) that observers should not react to; never fires `onInvalidated`.

`onInvalidated` fires only for `'notify'` invalidation. It never fires for `'silent'` invalidation, and therefore never for evictions — the eviction extension below invalidates silently. `sanitize()` and `clear()` don't fire it either; `clear()` has its own event (`onCleared`).

Max-items eviction is not core — see `createEvictionExtension` below.

### What's core vs. an extension

Staleness policy is core: `useInvalidation()`'s `InvalidationConfig` is live-evaluated (getters re-run on every check), so per-key TTL, version counters, and external staleness signals are already covered without any extension. Access-recency LRU and refresh-ahead/soft-TTL policies are out of scope for now — they need a read-path hook (e.g. an `onAccessed` event) that doesn't exist yet.

## Extensions

`extend()` mirrors `LazyPromise.extend`: it mutates the instance in place, chaining wraps in call order, and returns `this` typed with any shape addition:

```ts
const cache = new PromiseCache<User>(fetchUser)
    .extend(createBatchingExtension(batchFetchUsers))
    .extend(createEvictionExtension({ maxItems: 500 }));
```

An `IPromiseCacheExtension<T, TKey, TExtShape>` can wrap the fetcher (`overrideFetcher`), add properties or methods to the instance (`extendShape`), hook into the lifecycle (`onStored`, `onInvalidated`, `onCleared`), and release resources (`dispose`) — each hook is documented in [`extensions.ts`](extensions.ts). Hook exceptions are caught and logged; they never break the cache operation or other hooks.

### Events

The lifecycle is also observable without `extend()`, via three `IEvent`s (`@zajno/common/observing/event`; `.on(handler)` returns the unsubscribe):

- `onStored` — `{ key, value }`; every successful store (fetch result or `set()`), with the prepared value.
- `onInvalidated` — `{ key }`; `'notify'` invalidations only.
- `onCleared` — no payload; `clear()`, including the one `dispose()` runs.

Extension hooks subscribe to these same events, so dispatch order is `extend()`/`.on()` call order.

### Batching — `createBatchingExtension`

Collects individual fetches within a delay window and dispatches one batch call:

```ts
import { createBatchingExtension } from '@zajno/common/structures/promiseCache';

cache.extend(createBatchingExtension(async (ids: string[]) => {
    const res = await fetch(`/api/users?ids=${ids.join(',')}`);
    return res.json(); // must be in the same order as ids
}, 200 /* delay ms, default 200 */));
```

### Eviction — `createEvictionExtension`

Caps the cache at `maxItems`, evicting on every store: invalid entries first, then the oldest by insertion order.

```ts
import { createEvictionExtension } from '@zajno/common/structures/promiseCache';

cache.extend(createEvictionExtension({ maxItems: 500 }));
```

### Retry — createRetryExtension

Wraps the fetcher with retry logic, backing off between attempts:

```ts
import { createRetryExtension } from '@zajno/common/structures/promiseCache';

cache.extend(createRetryExtension({ retries: 3, delay: 1000, backoffMultiplier: 2 }));
```

### Live subscriptions — createSubscriptionExtension

Adapts a live source — `(key, emit) => DisposeFunction | Promise<DisposeFunction>` — into a fetcher: the first emission resolves the fetch, later ones update the cached value. The source must emit at least once or fail; one that never does leaves the fetch pending.

```ts
import { createSubscriptionExtension } from '@zajno/common/structures/promiseCache';

const live = createSubscriptionExtension<User>(subscribeToUser, 'forever');
const users = new PromiseCache<User>(live.fetch).extend(live);
```

`policy` (default `'forever'`) sets the subscription's lifetime after the first emission:

- `'off'` — unsubscribe right away: a one-shot fetch.
- `'forever'` — keep it until `invalidate`/`clear`/`dispose`.
- `{ ttlMs }` — keep it for `ttlMs` since the last emission, then unsubscribe and invalidate the key, so the next read re-subscribes. `SHORT_SUBSCRIPTION_TTL_MS` is a ready-made 5 minutes.

It replaces the cache's fetcher instead of wrapping it and owns that cache's subscriptions, so create one instance per cache and apply it before the first fetch — `fetch` on its own rejects.

To merge an emission into the current value instead of replacing it, wrap `emit` and merge against `cache.getCurrent(key, false)`, or use `prepareValue`.

### Writing a custom extension

A read-through/write-through persistence extension, shaped like a typical retry-or-cache-backed API layer:

```ts
function createPersistenceExtension<T>(storage: Storage, prefix: string): IPromiseCacheExtension<T, string> {
    return {
        overrideFetcher: original => async (key, refreshing) => {
            if (!refreshing) {
                const raw = storage.getItem(prefix + key);
                if (raw != null) return JSON.parse(raw) as T;
            }
            return original(key, refreshing);
        },
        onStored: (key, value) => storage.setItem(prefix + key, JSON.stringify(value)),
        onInvalidated: key => storage.removeItem(prefix + key),
        onCleared: () => { /* clear this prefix's keys */ },
    };
}
```

Retry logic follows the same shape: wrap `original` in `overrideFetcher` with your own attempt/backoff loop.

## Typed Keys

`PromiseCache<T, TKey>` lets `TKey` narrow to any subtype of `string` — a branded string or a template-literal type. The fetcher and every key-taking method are typed against `TKey`; `keys()` returns `TKey[]`.

```ts
import { PromiseCache } from '@zajno/common/structures/promiseCache';

type UserKey = `user:${string}`;
const userKey = (id: string): UserKey => `user:${id}`;

const userCache = new PromiseCache<User, UserKey>(async (key) => fetchUser(key));

await userCache.get(userKey('42'));
userCache.get('42'); // compile error: `string` is not assignable to `UserKey`
```

This only narrows the key's *type* — the cache is still string-keyed at runtime. For structured (object) keys, use `KeyedPromiseCache` (below) or your app's own repository layer to translate ids to/from strings.

## KeyedPromiseCache — Non-String Keys

`PromiseCache`'s keys are strings (optionally narrowed via `TKey`, see [Typed Keys](#typed-keys)). For a non-string id type `K`, wrap it in `KeyedPromiseCache`, providing `toKey` (id → string) and, optionally, `fromKey` (string → id):

```ts
import { KeyedPromiseCache } from '@zajno/common/structures/promiseCache';

// With fromKey — ids are recovered by parsing the string key directly.
const cache = new KeyedPromiseCache<Product, number>(
    (id) => fetchProduct(id),
    (id) => id.toString(),      // toKey
    { fromKey: (key) => Number(key) },
);

await cache.get(42);
cache.keys(); // number[]
```

Without `fromKey`, `KeyedPromiseCache` keeps an internal id registry instead, populated the first time each id is passed to any of its methods:

```ts
const cache = new KeyedPromiseCache<Product, string>(
    (id) => fetchProduct(id),
    (id) => `product:${id}`,    // toKey only — no fromKey
);

await cache.get('p-1'); // registers 'product:p-1' → 'p-1'
cache.keys();           // ['p-1']
```

In registry mode, memory grows with the number of distinct ids ever used to fetch or store — the registry is only emptied by `clear()`. A `getLazy()` handle obtained before a `clear()` needs its id passed to a public method again before it can resolve. For large or unbounded id spaces, prefer `fromKey` — it avoids the registry entirely.

`KeyedPromiseCache` implements `IControllablePromiseCache<T, K, TInitial>` — the full contract translated to take `id: K`, with `keys()` returning ids. Anything beyond the contract — invalidation policy, `extend()`, logging — is reached via the `cache` getter, which works with the inner string keys:

```ts
cache.cache.useInvalidation({ expirationMs: 60_000 });
cache.cache.keys(); // ['product:p-1']
```

Pass a `cacheFactory` to change the inner cache flavor, e.g. to get the `@zajno/common-mobx` observable variant:

```ts
import { PromiseCacheObservable } from '@zajno/common-mobx/structures/promiseCache';

const cache = new KeyedPromiseCache<Product, number>(
    (id) => fetchProduct(id),
    (id) => id.toString(),
    { cacheFactory: (fetcher) => new PromiseCacheObservable(fetcher) },
);
```

## Unified `ILazyPromise<T>` Interface

`getLazy(key)` returns an `ILazyPromise<T>` — the same interface implemented by standalone `LazyPromise` instances. Consumers can use a single interface regardless of whether the data comes from a single lazy value or a keyed cache:

```ts
import type { ILazyPromise } from '@zajno/common/lazy';

function renderItem(data: ILazyPromise<User>) {
    if (data.isLoading) return <Spinner />;
    if (data.error) return <Error error={data.error} />;
    return <UserCard user={data.value} />;
}

// Works with standalone LazyPromise
const singleUser = new LazyPromise(() => fetchCurrentUser());
renderItem(singleUser);

// Works with PromiseCache entry
const cache = new PromiseCache<User>(fetchUser);
renderItem(cache.getLazy('user-42'));
```

### `PromiseCacheLazyHandle` — for adapter authors

`getLazy()` returns a `PromiseCacheLazyHandle<T, TInitial>` instance. Its getters are one-line delegations to the cache's public methods, with no state of its own — subclass it and override individual getters to build a custom adapter without reimplementing the rest:

```ts
import { PromiseCacheLazyHandle } from '@zajno/common/structures/promiseCache';

class UpperCaseHandle extends PromiseCacheLazyHandle<string> {
    get value() { return super.value?.toUpperCase(); }
}
```

## Error Handling

When a fetcher throws, the error is:
1. Stored per-key (accessible via `getLastError(key)` or `getLazy(key).error`)
2. Logged via the attached logger
3. Forwarded to the `useOnError()` callback, if set

The failed fetch resolves to the initial value for a first fetch, or to the stale cached value for a refresh (stale-while-revalidate). The error is cleared on the next successful store, and by `invalidate()`, `sanitize()`, and `clear()`.

## Concurrency & Version Safety

When `clear()` is called while fetches are in-flight, the internal `_version` counter is incremented. A fetch that started before the clear still resolves its promise (so callers aren't left hanging), but the result is not stored. This prevents stale data from silently reappearing after a reset.

`refresh(key)` re-fetches without clearing the stale cached value. Multiple concurrent refreshes for the same key use "latest wins" semantics — all awaiting promises resolve to the value from the most recent refresh.

```ts
// Stale-while-revalidate pattern
const stale = cache.getCurrent('user-42'); // returns stale value immediately
const fresh = await cache.refresh('user-42'); // re-fetches, stale value stays readable during fetch

// Via ILazyPromise handle
const lazy = cache.getLazy('user-42');
const refreshed = await lazy.refresh(); // same behavior
```
