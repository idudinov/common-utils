import type { Nullable } from '../types/misc.js';
import type { CallerResponse, IRequestConfig } from './call.types.js';
import type { IEndpointInfo } from './endpoint.types.js';

export type CallerHooks<TExtra extends object = object> = {
    /**
    * Called before config is created, to validate result input data.
    * May throw to abort request. Use for input validation if needed.
    * Objects are cloned to avoid mutation.
    */
    beforeConfig?: <T extends IEndpointInfo = IEndpointInfo>(
        api: T,
        body: IEndpointInfo.ExtractIn<T, object>,
        pathParams: IEndpointInfo.ExtractPath<T, object>,
        queryParams: IEndpointInfo.ExtractQuery<T, object>,
    ) => CallerHooks.HookReturnType;

    /**
     * Called before request is sent, to add headers or modify request data.
     *
     * Config:
     * - a hook may mutate it
     * - a returned object is copied onto it with `Object.assign` before the next hook runs, so every hook gets the same config object
     */
    beforeRequest?: <
        T extends IEndpointInfo = IEndpointInfo,
        TIn = IEndpointInfo.ExtractIn<T>,
    >(config: IRequestConfig<T, TIn, TExtra>) => CallerHooks.HookReturnType<void | IRequestConfig<T, TIn, TExtra>>;

    /**
     * Called after response is received.
     *
     * Response:
     * - a returned response replaces the received one, for the next hook and for the caller
     * - a hook that returns nothing leaves it as it is
     */
    afterResponse?: <
        T extends IEndpointInfo = IEndpointInfo,
        TIn = IEndpointInfo.ExtractIn<T>,
        TOut = IEndpointInfo.ExtractOut<T>,
        TResponse extends CallerResponse<TOut> = CallerResponse<TOut>,
    >(config: IRequestConfig<T, TIn, TExtra>, response: TResponse) => CallerHooks.HookReturnType<void | TResponse>;
};

export namespace CallerHooks {

    export type HookReturnType<T = void> = T | Promise<T>;

    type HookAdapter<TExtra extends object, K extends keyof CallerHooks<TExtra>, H extends NonNullable<CallerHooks<TExtra>[K]> = NonNullable<CallerHooks<TExtra>[K]>> = (prev: ReturnType<H>, nextFn: H, ...args: Parameters<H>) => ReturnType<H>;

    type HookAdaptersMap<TExtra extends object> = {
        [K in keyof CallerHooks<TExtra>]?: HookAdapter<TExtra, K>;
    };

    // by default, no adapter, previous value is not affecting the next one
    const Adapters: HookAdaptersMap<object> = {
        beforeRequest: async (prev, next, config) => {
            const changed = await prev;
            if (changed) {
                Object.assign(config, changed);
            }
            return next(config);
        },
        afterResponse: async (prev, next, config, response) => {
            const received = await prev ?? response;
            return await next(config, received as any) ?? received;
        },
    };

    /**
     * Merges hooks into one set, running the hooks of each kind in the order given.
     *
     * Chaining:
     * - each {@link CallerHooks.beforeRequest} and {@link CallerHooks.afterResponse} hook gets what the previous one changed or returned
     * - each other hook gets the original arguments
     */
    export function merge<TExtra extends object>(items: Nullable<CallerHooks<TExtra> | CallerHooks<TExtra>[]>): CallerHooks<TExtra> {
        const result: CallerHooks<TExtra> = { };
        if (!items) {
            return result;
        }

        if (!Array.isArray(items)) {
            Object.assign(result, items);
            return result;
        }

        type CH = CallerHooks<TExtra>;


        const mergeOne = <K extends keyof CH, H extends NonNullable<CH[K]>>(
            key: K,
            value: Nullable<H>,
            adapter?: (prev: ReturnType<H>, nextFn: H, ...args: Parameters<H>) => ReturnType<H>,
        ) => {
            if (!value) {
                return;
            }

            const current = result[key];
            if (!current) {
                result[key] = value;
                return;
            }

            type HookType = (...args: Parameters<H>) => ReturnType<H>;

            const prevHook = current as HookType;
            const nextHook = value as HookType;

            const res = async (...args: Parameters<H>) => {
                const prev = await prevHook(...args);
                if (!adapter) {
                    return nextHook(...args);
                }

                return adapter(
                    prev,
                    value,
                    ...args,
                );
            };

            result[key] = res as CH[K];
        };

        items.forEach(item => {
            Object.entries(item).forEach(([k, value]) => {
                if (!value) {
                    return;
                }

                const key = k as keyof CH;
                mergeOne(key, value as CH[typeof key], Adapters[key] as HookAdapter<TExtra, typeof key>);
            });
        });

        return result;
    }
}
