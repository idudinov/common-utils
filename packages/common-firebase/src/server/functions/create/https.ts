import { onCall, onRequest, type HttpsFunction, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import type { EndpointContext, EndpointFunction, FirebaseEndpointRunnable } from '../interface.js';
import type { EndpointSettings } from '../../../functions/interface.js';
import { mergeOptions, mergeCallableOptions } from './helpers.js';

export type RequestEndpointFunction<TRes = any> = (req: Request, resp: Response<TRes>) => void | Promise<void>;

export function createHttpsCallFunction<T = any, TOut = void>(
    worker: EndpointFunction<T, TOut>,
    options: EndpointSettings | null = null,
): FirebaseEndpointRunnable {
    return onCall(mergeCallableOptions(options), (request) => {
        // Extract data separately — CallableRequest.data is the request payload,
        // but EndpointContext.data is the custom context field. We must not let
        // the payload leak into the context's .data slot.
        const { data, ...ctx } = request;
        const eCtx = ctx as unknown as EndpointContext;
        return worker(data as T, eCtx);
    }) as unknown as FirebaseEndpointRunnable;
}

export function createHttpsRequestFunction<TRes = any>(worker: RequestEndpointFunction<TRes>, options: EndpointSettings | null = null): HttpsFunction {
    return onRequest(mergeOptions(options), worker);
}
