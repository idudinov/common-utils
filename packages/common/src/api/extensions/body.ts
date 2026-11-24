import type { ApiEndpoint, IEndpointInfo } from '../endpoint.js';
import type { CallerHooks } from '../hooks.js';

/**
 * Request body serializer extension for endpoint.
 *
 * Replaces the request body with the serializer's result before sending.
 *
 * @example
 * ```typescript
 * const Endpoint = ApiEndpoint.create.extend(IEndpointInputContentType.extender).extend(IEndpointBody.extender);
 *
 * const setDefaultTag = Endpoint('Set default tag')
 *     .post<{ tag: string }, void>()
 *     .asJson()
 *     .withBody(input => JSON.stringify(input.tag));
 * ```
 */
export interface IEndpointBody {
    /** Serializer set by {@link IEndpointBody.withBody}. */
    readonly serializeBody?: (input: never) => unknown;

    /**
     * Sets the serializer of this endpoint's request body.
     *
     * Usage rules:
     * - A string body needs its content type on the endpoint, through `asJson()` or `withContentType()`.
     *   Without one, transports send it differently.
     * - `withBody` comes after {@link ApiEndpoint.withPath} and {@link ApiEndpoint.withQuery}, so its input type has their keys removed.
     *
     * @param serialize - Builds the request body from {@link IEndpointBody.BodyOf}.
     */
    withBody(serialize: (input: IEndpointBody.BodyOf<this>) => unknown): this;
}

export namespace IEndpointBody {
    /** The body a caller sends to endpoint `T`: its input without the path and query keys, for each member of a union input. */
    export type BodyOf<T> = DistOmit<
        NonNullable<IEndpointInfo.ExtractIn<T>>,
        keyof IEndpointInfo.ExtractPath<T> | keyof IEndpointInfo.ExtractQuery<T>
    >;

    type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

    export const extender: ApiEndpoint.IBuilderExtender<IEndpointBody> = <T extends ApiEndpoint>(base: T) => {
        const ext = {
            serializeBody: undefined,
            withBody(this: { serializeBody?: unknown }, serialize: unknown) {
                this.serializeBody = serialize;
                return this;
            },
        } as IEndpointBody;
        return Object.assign(base, ext);
    };

    export function guard(api: IEndpointInfo): api is (IEndpointInfo & IEndpointBody) {
        return 'serializeBody' in api && typeof api.serializeBody === 'function';
    }

    /**
     * Creates caller hooks that replace `config.data` with the result of the endpoint's serializer.
     *
     * The serializer runs only when the request has a body.
     */
    export function createHooks(): CallerHooks<object> {
        return {
            beforeRequest: (config) => {
                const api = config._meta.api;
                if (!guard(api) || config.data == null) {
                    return;
                }

                const serialize = api.serializeBody as (input: unknown) => unknown;
                Object.assign(config, { data: serialize(config.data) });
            },
        };
    }
}
