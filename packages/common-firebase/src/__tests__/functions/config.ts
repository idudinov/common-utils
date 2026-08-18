import FFT from 'firebase-functions-test';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { FunctionFactory } from '../../server/functions/index.js';
import type { AnyObject, ObjectOrPrimitive } from '@zajno/common/types/misc';

const FFTest = FFT({ });

export type EndpointTestContext = {
    auth?: { uid: string };
};
export type EndpointTestFunction<T, TOut> = (data: Partial<T>, context?: EndpointTestContext) => Promise<TOut>;

export function wrapEndpoint<A extends AnyObject, R extends AnyObject, C extends ObjectOrPrimitive>(fn: FunctionFactory<A, R, C>) {
    const wrapped = FFTest.wrap(fn.Endpoint);
    // v2 WrappedV2CallableFunction takes a CallableRequest, adapt to our test interface
    return ((data: Partial<A>, context?: EndpointTestContext) => {
        const request = {
            data,
            auth: context?.auth,
            rawRequest: {} as any,
            acceptsStreaming: false,
        } as CallableRequest<Partial<A>>;
        return wrapped(request);
    }) as EndpointTestFunction<A, R>;
}

type Nested<T, K extends keyof T> = T[K] extends never ? never : Required<NonNullable<T[K]>>;

export function getNestedFunction<A, R, K extends (string & keyof A & keyof R)>(fn: EndpointTestFunction<A, R>, key: K): EndpointTestFunction<Nested<A, K>, Nested<R, K>> {
    return async (data, ctx) => {
        const parentArg = { [key]: data } as any as A;
        const result = await fn(parentArg, ctx);
        return result && result[key] as Nested<R, K>;
    };
}

afterAll(() => FFTest.cleanup());
