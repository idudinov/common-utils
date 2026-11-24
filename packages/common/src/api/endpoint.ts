import { Path } from '../structures/path/index.js';
import type { Mutable } from '../types/misc.js';
import type { IEndpointInfo } from './endpoint.types.js';
import { EndpointMethods } from './methods.js';

/** @import { buildApiCaller } from "./call" */

export type { IEndpointInfo };

/**
 * Defines a REST API endpoint, which a caller such as {@link buildApiCaller} uses to make a request.
 *
 * Chained builder methods set its {@link IEndpointInfo} fields.
 * An extender adds more fields and builder methods, see {@link ApiEndpoint.IBuilderExtender}.
 */
export interface ApiEndpoint extends IEndpointInfo.Base {
    /** Applies specified HTTP method */
    withMethod(method: EndpointMethods): this;
    /** Applies GET HTTP method and specifies output type */
    get<TOut>(): this & IEndpointInfo.IOut<TOut>;
    /** Applies PUT HTTP method and specifies input and output types */
    put<TIn extends object | null, TOut>(): this & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
    /** Applies PATCH HTTP method and specifies input and output types */
    patch<TIn extends object | null, TOut>(): this & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
    /** Applies POST HTTP method and specifies input and output types */
    post<TIn extends object | null, TOut>(): this & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
    /** Applies DELETE HTTP method and specifies output type */
    delete<TOut>(): this & IEndpointInfo.IOut<TOut>;

    /** Applies a type based on {@link Path.IBuilder} type by accepting arguments for {@link Path.construct} function */
    withPath<P extends readonly Path.BaseInput[]>(...path: P): this & IEndpointInfo.IPath<Path.CombineBuilders<P>>;

    /** Applies the query type, and stores the query keys, which the caller moves from the request body to the query string. */
    withQuery<TQ extends object>(...queryKeys: (string & keyof TQ)[]): this & IEndpointInfo.IQuery<TQ>;

    /** Applies error type, optionally stores error processor. */
    withErrors<TErr>(errorProcessor?: (err: TErr) => void): this & IEndpointInfo.IErrors<TErr>;

    /** Applies headers type. */
    withHeaders<THeads>(_headersMarker?: THeads): this & IEndpointInfo.IHeaders<THeads>;

    /** Returns a frozen copy of the endpoint without its builder methods, typed as {@link IEndpointInfo.Finalized}. */
    finalize(): IEndpointInfo.Finalized<this>;
}

export namespace ApiEndpoint {

    export interface IBuilder<T extends ApiEndpoint = ApiEndpoint> {
        (displayName?: string): T;

        extend<TExt>(extender: (base: T) => T & TExt): IBuilder<T & TExt>;
    }

    /**
     * Adds builder methods and data fields to an endpoint.
     *
     * Finalization:
     * - Each function the extender adds is a builder method, which {@link ApiEndpoint.finalize} drops.
     * - Every other field the extender adds is data, which `finalize()` keeps.
     * - A data field starts as `undefined` or absent, never as a function.
     */
    export type IBuilderExtender<T> = <TBase extends ApiEndpoint>(base: TBase) => TBase & T;

    const ENDPOINT_OBJ_MARKER = '_ENDPOINT_OBJ_MARKER';

    const BUILDER_METHOD_KEYS = Symbol('builderMethodKeys');

    export const create = createBuilder(createBase);

    export function isEndpoint(obj: unknown): obj is IEndpointInfo {
        return typeof obj === 'object' && obj !== null
            && (obj as Record<string, unknown>)[ENDPOINT_OBJ_MARKER] === true
            && 'method' in obj;
    }

    function getBuilderMethodKeys(endpoint: object): Set<string> {
        const holder = endpoint as { [BUILDER_METHOD_KEYS]?: Set<string> };
        let keys = holder[BUILDER_METHOD_KEYS];
        if (!keys) {
            keys = new Set();
            // non-enumerable, so Object.assign and spread leave the record behind
            Object.defineProperty(endpoint, BUILDER_METHOD_KEYS, { value: keys, enumerable: false });
        }
        return keys;
    }

    function recordBuilderMethods(endpoint: object) {
        const keys = getBuilderMethodKeys(endpoint);
        // descriptors, not values: reading a value would run an accessor before the builder methods have set its data
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(endpoint))) {
            if (typeof descriptor.value === 'function') {
                keys.add(key);
            }
        }
    }

    function createBase(displayName?: string): ApiEndpoint {

        const data = {
            displayName,
            method: EndpointMethods.GET,
        };

        Object.assign(data, { [ENDPOINT_OBJ_MARKER]: true });

        const res = data as ApiEndpoint;

        const ext: Omit<ApiEndpoint, keyof IEndpointInfo> = {
            withMethod(method: EndpointMethods) {
                data.method = method;
                return res;
            },
            get<TOut>() {
                data.method = EndpointMethods.GET;
                return res as ApiEndpoint & IEndpointInfo.IOut<TOut>;
            },
            put<TIn extends object | null, TOut>() {
                data.method = EndpointMethods.PUT;
                return res as ApiEndpoint & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
            },
            patch<TIn extends object | null, TOut>() {
                data.method = EndpointMethods.PATCH;
                return res as ApiEndpoint & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
            },
            post<TIn extends object | null, TOut>() {
                data.method = EndpointMethods.POST;
                return res as ApiEndpoint & IEndpointInfo.IIn<TIn> & IEndpointInfo.IOut<TOut>;
            },
            delete<TOut>() {
                data.method = EndpointMethods.DELETE;
                return res as ApiEndpoint & IEndpointInfo.IOut<TOut>;
            },

            withPath<P extends readonly Path.BaseInput[]>(...p: P) {
                const path = Path.construct(...p);
                return Object.assign(
                    res,
                    { path },
                );
            },

            withQuery<TQ extends object>(...queryKeys: (string & keyof TQ)[]) {
                (data as Mutable<IEndpointInfo.IQuery<TQ>>).queryKeys = queryKeys;
                return res as ApiEndpoint & IEndpointInfo.IQuery<TQ>;
            },

            withErrors<TErr>(errorProcessor?: (err: TErr) => void) {
                (data as Mutable<IEndpointInfo.IErrors<TErr>>).errorProcessor = errorProcessor;
                return res as ApiEndpoint & IEndpointInfo.IErrors<TErr>;
            },

            withHeaders<THeaders>() {
                return res as ApiEndpoint & IEndpointInfo.IHeaders<THeaders>;
            },

            finalize() {
                const methodKeys = getBuilderMethodKeys(res);
                const fields = Object.entries<unknown>(res).filter(([key, value]) => value != null && !methodKeys.has(key));
                return Object.freeze(Object.fromEntries(fields)) as IEndpointInfo.Finalized<ApiEndpoint>;
            },
        };

        Object.assign(res, ext);
        return res;
    }

    function createBuilder<TBase extends ApiEndpoint, T>(
        base: (displayName?: string) => TBase,
        extender: (base: TBase) => T,
    ): IBuilder<TBase & T>;
    function createBuilder<TBase extends ApiEndpoint>(
        base: (displayName?: string) => TBase,
    ): IBuilder<TBase>;

    function createBuilder<TBase extends ApiEndpoint, T>(
        baseFactory: (displayName?: string) => TBase,
        extender?: (base: TBase) => T,
    ): IBuilder<TBase & T> {
        const res = function (displayName?: string) {
            const baseRes = baseFactory(displayName);
            const endpoint = extender ? extender(baseRes) : baseRes;
            recordBuilderMethods(endpoint as object);
            return endpoint;
        } as IBuilder<TBase & T>;

        res.extend = (extender) => {
            return createBuilder(
                res,
                extender,
            );
        };

        return res;
    }
}
