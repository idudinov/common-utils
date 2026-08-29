# PromiseCache

A key-value cache for async data that goes well beyond a simple `Map<string, Promise>`. Provide a fetcher function, and `PromiseCache` handles the rest:

- **Deduplication** — concurrent `get()` calls for the same key share a single in-flight promise
- **Synchronous access** — `getCurrent()` returns the resolved value instantly; `getLazy()` gives a reactive `ILazyPromise<T>` handle
- **Per-key error tracking** — fetch failures are stored, logged, and forwarded to an optional callback
- **Stale-while-revalidate** — invalidated items remain readable; `refresh(key)` re-fetches without clearing the stale value
- **Invalidation** — time-based TTL, custom callback, or both
- **Max-items eviction** — LRU-like eviction that removes invalid items first, then oldest; never evicts in-flight fetches
- **Request batching** — collects keys in a time window and dispatches a single batch call, with automatic per-key fallback on failure
- **Safe `clear()`** — a version counter prevents stale in-flight fetches from silently re-populating the cache
- **Extensible** — internal storage is created via overridable factory methods, making it easy to integrate with MobX, Vue, or other reactivity systems

## Module Structure

| File | Description |
|---|---|
| [`types.ts`](types.ts) | Type definitions — `InvalidationCallback<T>`, `ErrorCallback<K>`, `InvalidationConfig<T>`; re-exports `PendingLoadState`, `LoadingStateStrategy`, `DEFAULT_LOADING_STATE` from `@zajno/common/lazy` |
| [`core.ts`](core.ts) | Abstract base class `PromiseCacheCore<T, K>` — storage, state tracking, hooks, `pure_create*` factory methods |
| [`cache.ts`](cache.ts) | Concrete implementation `PromiseCache<T, K>` — fetching, batching, invalidation, error handling, max-items eviction |
| [`index.ts`](index.ts) | Barrel re-export of all public API |

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

## Non-String Keys

When the cache key type `K` is not `string`, provide a **key adapter** (serialize) and optionally a **key parser** (deserialize):

```ts
const cache = new PromiseCache<Product, number>(
    async (id) => fetchProduct(id),
    (id) => id.toString(),   // keyAdapter: K → string
    (str) => Number(str),    // keyParser: string → K
);

await cache.get(42);
cache.keysParsed(); // number[]
```

## Configuration (Fluent API)

All configuration methods return `this` for chaining.

### Batching — `useBatching()`

Collects individual `get()` calls within a short window and dispatches them as a single batch request. If the batch fails, each item falls back to the individual fetcher.

```ts
cache.useBatching(async (ids: string[]) => {
    const res = await fetch(`/api/users?ids=${ids.join(',')}`);
    return res.json(); // must return results in the same order as ids
}, 200 /* delay ms, default 200 */);
```

> **Important:** The resolved array **must** have the same order as the input `ids` array.

### Invalidation — `useInvalidation()` / `useInvalidationTime()`

```ts
// Simple time-based expiration
cache.useInvalidationTime(60_000); // 60 seconds

// Advanced config
cache.useInvalidation({
    expirationMs: 60_000,                          // time-based
    invalidationCheck: (key, value, cachedAt) => {  // callback-based
        return value?.isStale === true;
    },
    maxItems: 100,       // LRU-like eviction (invalid first, then oldest)
});

// Disable invalidation
cache.useInvalidation(null);
```

The config object is stored **by reference** (not destructured), so getter-based fields are re-evaluated on every access — enabling dynamic invalidation policies:

```ts
let ttl = 60_000;
cache.useInvalidation({
    get expirationMs() { return ttl; },
});
// later: ttl = 5_000; — takes effect immediately
```

### Initial Value — `useInitialValue()`

Provides a default value returned before the fetch completes or on error when no stale value exists. Eliminates `undefined` from the return types.

```ts
// Static value for all keys
const cache = new PromiseCache<User>(fetchUser)
    .useInitialValue({ name: 'Loading...', id: '' });

// Per-key factory
const cache = new PromiseCache<User>(fetchUser)
    .useInitialValue((key) => ({ name: 'Loading...', id: key }));
```

The initial value is **not** stored in the cache — it's a synthetic default (same as `LazyPromise`'s initial value). `hasValue` remains `false` until a real fetch completes.

### Error Callback — `useOnError()`

```ts
cache.useOnError((key, error) => {
    reportToSentry(error, { cacheKey: key });
});
```

### Loading State Strategy — `useLoadingState()`

Every fetch is classified into a **pending state** — trigger × has-stale-value, shared with `LazyPromise`:

| Pending state | Trigger | Default `isLoading` |
|---|---|---|
| `'loading'` | no usable value (first load, cold refresh, retry after error) | `true` |
| `'revalidating'` | stale value, passive `get()`/`.value` on expiry | `false` |
| `'refreshing'` | stale value, explicit `refresh()` | `false` |

The default is one rule: show a spinner only when there's nothing usable to show.

`useLoadingState()` overrides what `getIsLoading(id)` / `getLazy(id).isLoading` report for one or more of these states, cache-wide. Missing keys keep the default; each call replaces the previous strategy rather than merging with it:

```ts
// Silence the spinner during a passive re-fetch of stale data (stale-while-revalidate UX)
cache.useLoadingState({ revalidating: false });

// Surface a background refresh() as loading
cache.useLoadingState({ refreshing: true });
```

The strategy only affects `isLoading` — `hasValue`, `value`, `currentValue`, and `error` are unaffected and always reflect the cached value/error independently of loading state.

`getLazy(id, strategy)` accepts an optional **per-handle** strategy for a presentation-local fork: named pending states report the handle's own value; unnamed states fall through to the cache-level report (not to the library defaults), so it composes on top of `useLoadingState()`:

```ts
const cache = new PromiseCache<User>(fetchUser); // cache-level: defaults
const loudHandle = cache.getLazy('user-42', { refreshing: true }); // this handle alone surfaces refresh()
```

### Logging

Inherited from `Loggable`. Attach a logger to see internal cache operations:

```ts
cache.setLoggerFactory(createLogger, 'UserCache');
// or
cache.setLogger(myLoggerInstance);
```

## API Reference

### Reading

| Method / Property | Return Type | Description |
|---|---|---|
| `get(id)` | `Promise<T \| TInitial>` | Returns cached value or starts a fetch. Concurrent calls for the same key share one promise. `TInitial` defaults to `undefined`; use `useInitialValue()` to narrow it. |
| `refresh(id)` | `Promise<T \| TInitial>` | Re-fetches the value while keeping the stale cached value available. On error, preserves the stale value. Multiple concurrent refreshes use "latest wins" semantics. |
| `getCurrent(id, initiateFetch?)` | `T \| TInitial` | Returns the cached value synchronously. When `initiateFetch` is `true` (default), also triggers `get()`. Falls back to the initial value if no cached value exists. |
| `getLazy(id, strategy?)` | `ILazyPromise<T, TInitial>` | Returns an `ILazyPromise<T, TInitial>` handle — the same interface used by standalone `LazyPromise`. Supports `value`, `currentValue`, `promise`, `isLoading`, `pendingState`, `error`, `hasValue`, and `refresh()`. The optional per-handle `strategy` overrides `isLoading` for named pending states; unnamed states fall through to the cache-level report. |
| `getIsLoading(id)` | `boolean \| null` | Derived from the pending kind (see [Loading State Strategy](#loading-state-strategy)) while a fetch is in flight; `false` once settled and valid; `null` if never started, or after an explicit `invalidate()`. |
| `getIsValid(id)` | `boolean` | `true` if the item is cached **and** not invalidated. |
| `getLastError(id)` | `unknown` | Last fetch error for the key, or `null`. |
| `hasKey(id)` | `boolean` | `true` if the item is cached or a fetch was initiated. Does **not** trigger a fetch. |
| `keys()` | `string[]` | Array of all cached string keys. |
| `keys(true)` | `MapIterator<string>` | Iterator over cached string keys. |
| `keysParsed()` | `K[] \| null` | Parsed keys via `keyParser`, or `null` if no parser was provided. |
| `keysParsed(true)` | `Generator<K> \| null` | Lazy iterator of parsed keys. |

### Counts

| Property | Type | Description |
|---|---|---|
| `loadingCount` | `number` | Number of items currently being fetched. |
| `cachedCount` | `number` | Number of resolved items in cache. |
| `promisesCount` | `number` | Number of in-flight promises. |
| `invalidCount` | `number` | Number of cached items that are currently invalid/expired. |

### Mutation

| Method | Description |
|---|---|
| `invalidate(id)` | Removes the cached item, its error, and timestamp — as if it was never fetched. |
| `set(id, value)` | Injects a value into the cache as if it had been fetched. Sets the timestamp and clears any previous error. |
| `sanitize()` | Removes all currently-invalid items. Returns the count of removed items. |
| `clear()` | Resets **all** state: items, statuses, promises, errors, timestamps, loading count, and batch queue. |

## Invalidation & Eviction

`InvalidationConfig<T>` controls when cached items are considered stale:

| Field | Type | Default | Description |
|---|---|---|---|
| `expirationMs` | `number \| null` | `undefined` | Time-to-live in ms. `null`/`undefined` disables time-based expiration. |
| `invalidationCheck` | `(key, value, cachedAt) => boolean` | `undefined` | Custom callback; return `true` to mark the item invalid. |
| `maxItems` | `number \| null` | `undefined` | Maximum cache size. Eviction order: invalid items first, then oldest by timestamp. In-flight items are never evicted. |

> **Note:** Invalidated items always remain readable via `getCurrent()` (stale-while-revalidate). To fully clear a value before re-fetching, use `invalidate(id)` followed by `get(id)`.

## Error Handling

When a fetcher throws, the error is:
1. Stored per-key in the errors map (accessible via `getLastError(id)` or `getLazy(id).error`)
2. Logged via the attached logger
3. Forwarded to the `useOnError()` callback (if set)

The failed fetch resolves to `undefined` for initial fetches, or to the **stale cached value** for refreshes (stale-while-revalidate). The error is recorded per-key. On a subsequent successful fetch, the error is cleared by `storeResult()`.

Errors are also cleared by `invalidate()`, `sanitize()`, and `clear()`.

## Unified `ILazyPromise<T>` Interface

`getLazy(key)` returns an `ILazyPromise<T>` — the same interface implemented by standalone `LazyPromise` instances. This means consumers can use a single interface regardless of whether the data comes from a single lazy value or a keyed cache:

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

### `InvalidationCallback<T>`

```ts
type InvalidationCallback<T> = (key: string, value: T | undefined, cachedAt: number) => boolean;
```

### `ErrorCallback<K>`

```ts
type ErrorCallback<K> = (key: K, error: unknown) => void;
```

## Extensibility

`PromiseCacheCore` is designed for subclassing. The `pure_create*` factory methods allow replacing internal storage with observable variants:

| Factory Method | Creates |
|---|---|
| `pure_createLoadingCount()` | `IValueModel<number>` for the loading counter |
| `pure_createMap<TK, TV>()` | `IMapModel<TK, TV>` used for all internal keyed storage (resolved items, loading status, in-flight promises, errors) |

> ⚠️ These methods are called from the constructor and **must not** reference `this` or `super` — they must be pure/const functions.

For example, the `@zajno/common-mobx` package provides `PromiseCacheObservable`, which overrides these factories with MobX observable maps and wraps mutations in MobX actions. The same pattern can be applied for Vue reactivity or any other system.

## Concurrency & Version Safety

When `clear()` is called while fetches are in-flight, the internal `_version` counter is incremented. Any fetch that started before the clear will still resolve its promise (so callers aren't left hanging), but the result is **not** stored into the cache. This prevents stale data from silently reappearing after a reset.

### Refresh & "Latest Wins"

`refresh(key)` re-fetches the value for a key without clearing the stale cached value. Multiple concurrent refreshes for the same key use "latest wins" semantics — all awaiting promises resolve to the value from the most recent refresh. This mirrors the behavior of `LazyPromise.refresh()`.

Each `refresh()` call records its pending state (`'refreshing'` if a value already exists, `'loading'` otherwise — see [Loading State Strategy](#loading-state-strategy)) so `getIsLoading()` / `getLazy()` can report it; `getCurrent()` / `getLazy().value` keep returning the stale value regardless of what's reported as loading.

```ts
// Stale-while-revalidate pattern
const stale = cache.getCurrent('user-42'); // returns stale value immediately
const fresh = await cache.refresh('user-42'); // re-fetches, stale value stays readable during fetch

// Via ILazyPromise handle
const lazy = cache.getLazy('user-42');
const refreshed = await lazy.refresh(); // same behavior
```
