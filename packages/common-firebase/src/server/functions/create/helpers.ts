import type { EndpointHandler } from '../interface.js';
import { GlobalRuntimeOptions } from '../globalSettings.js';
import type { EndpointSettings } from '../../../functions/interface.js';
import type { HttpsOptions, CallableOptions } from 'firebase-functions/v2/https';

export function mergeOptions(runtimeOptions: EndpointSettings | undefined | null): HttpsOptions {
    return Object.assign({}, GlobalRuntimeOptions.value, runtimeOptions);
}

export function mergeCallableOptions(runtimeOptions: EndpointSettings | undefined | null): CallableOptions {
    return Object.assign({}, GlobalRuntimeOptions.value, runtimeOptions);
}

/** Merges global + local settings, picking only the fields compatible with all option types (no region array). */
export function mergeEndpointSettings(runtimeOptions: EndpointSettings | undefined | null): EndpointSettings {
    return Object.assign({}, GlobalRuntimeOptions.value, runtimeOptions);
}

const DefaultAllowMethods = ['POST'];

export const FilterRequestMethod = (methods: string[] = DefaultAllowMethods) => {
    const middleware: EndpointHandler<any, any, any> = (ctx, next) => {
        if (ctx?.rawRequest && !methods.includes(ctx.rawRequest.method)) {
            ctx.logger?.log('Request has been skipped because HTTP method =', ctx.rawRequest.method);
            return Promise.resolve();
        }

        return next();
    };
    return middleware;
};
