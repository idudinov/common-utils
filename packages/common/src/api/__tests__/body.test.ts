import { Path } from '../../structures/path/index.js';
import { buildApiCaller, type IRequestConfig } from '../call.js';
import { ApiEndpoint, type IEndpointInfo } from '../endpoint.js';
import { IEndpointBody } from '../extensions/body.js';
import { IEndpointInputContentType } from '../extensions/contentType.js';

describe('api/body', () => {
    const Endpoint = ApiEndpoint.create
        .extend(IEndpointInputContentType.extender)
        .extend(IEndpointBody.extender);

    const createCaller = () => {
        const request = vi.fn();
        const caller = buildApiCaller({
            request: async <TIn, TOut>(config: IRequestConfig<IEndpointInfo, TIn>) => {
                request(config);
                return { data: null as TOut };
            },
            hooks: [
                IEndpointInputContentType.createHooks(),
                IEndpointBody.createHooks(),
            ],
        });
        const sent = () => request.mock.lastCall![0] as IRequestConfig<IEndpointInfo>;
        return { caller, request, sent };
    };

    describe('serializer input type', () => {
        test('is the endpoint input without path and query keys', async () => {
            const { caller, sent } = createCaller();

            const bodyKey = Endpoint()
                .post<{ tag: string }, void>()
                .withBody(input => input.tag.toUpperCase());

            const misspelt = Endpoint()
                .post<{ tag: string }, void>()
                // @ts-expect-error the serializer sees the endpoint's input, so a misspelt key fails to compile
                .withBody(input => input.tga);

            const pathKey = Endpoint()
                .put<{ userId: string, privilege: string }, void>()
                .withPath('/users/:userId')
                // @ts-expect-error a path key never reaches the body, so the serializer cannot read it
                .withBody(input => input.userId);

            const pathRest = Endpoint()
                .put<{ userId: string, privilege: string }, void>()
                .withPath('/users/:userId')
                .withBody(input => input.privilege);

            const queryKey = Endpoint()
                .post<{ name: string, page: number }, void>()
                .withQuery<{ page: number }>('page')
                // @ts-expect-error a query key never reaches the body, so the serializer cannot read it
                .withBody(input => input.page);

            const queryRest = Endpoint()
                .post<{ name: string, page: number }, void>()
                .withQuery<{ page: number }>('page')
                .withBody(input => input.name);

            await caller(bodyKey, { tag: 'news' });
            expect(sent().data).toBe('NEWS');

            await caller(misspelt, { tag: 'news' });
            expect(sent().data).toBeUndefined();

            await caller(pathKey, { userId: '1', privilege: 'admin' });
            expect(sent().data).toBeUndefined();

            await caller(pathRest, { userId: '1', privilege: 'admin' });
            expect(sent().data).toBe('admin');

            await caller(queryKey, { name: 'a', page: 2 });
            expect(sent().data).toBeUndefined();

            await caller(queryRest, { name: 'a', page: 2 });
            expect(sent().data).toBe('a');
        });

        test('drops the keys of a query type declared as an interface', async () => {
            const { caller, sent } = createCaller();

            interface IPage { page: number }

            const queryKey = Endpoint()
                .post<{ name: string, page: number }, void>()
                .withQuery<IPage>('page')
                // @ts-expect-error a query key never reaches the body, whether its type is a literal or an interface
                .withBody(input => input.page);

            const queryRest = Endpoint()
                .post<{ name: string, page: number }, void>()
                .withQuery<IPage>('page')
                .withBody(input => input.name);

            await caller(queryKey, { name: 'a', page: 2 });
            expect(sent().data).toBeUndefined();

            await caller(queryRest, { name: 'a', page: 2 });
            expect(sent().data).toBe('a');
        });

        test('keeps each member of a union input, and ignores a null member', async () => {
            const { caller, sent } = createCaller();

            type Shape =
                | { kind: 'circle', radius: number, page: number }
                | { kind: 'square', side: number, page: number };

            const union = Endpoint()
                .post<Shape, void>()
                .withQuery<{ page: number }>('page')
                .withBody(input => input.kind === 'circle' ? input.radius : input.side);

            const nullable = Endpoint()
                .post<{ name: string } | null, void>()
                .withBody(input => input.name);

            await caller(union, { kind: 'circle', radius: 3, page: 1 });
            expect(sent().data).toBe(3);

            await caller(union, { kind: 'square', side: 4, page: 1 });
            expect(sent().data).toBe(4);

            await caller(nullable, { name: 'a' });
            expect(sent().data).toBe('a');
        });
    });

    describe('createHooks', () => {
        test('sends the serialized body with the endpoint content type', async () => {
            const { caller, sent } = createCaller();

            const endpoint = Endpoint()
                .post<{ tag: string }, void>()
                .asJson()
                .withBody(input => JSON.stringify(input.tag));

            await caller(endpoint, { tag: 'news' });

            expect(sent().data).toBe('"news"');
            expect(sent().headers?.['Content-Type']).toBe('application/json');
        });

        test('sends the body unchanged for an endpoint without a serializer', async () => {
            const { caller, sent } = createCaller();

            const endpoint = Endpoint()
                .post<{ tag: string }, void>()
                .asJson();

            await caller(endpoint, { tag: 'news' });

            expect(sent().data).toEqual({ tag: 'news' });
        });

        test('does not call the serializer when the whole input goes to the path', async () => {
            const { caller, sent } = createCaller();
            const serialize = vi.fn(() => 'body');

            const endpoint = Endpoint()
                .post<{ id: string }, void>()
                .withPath(Path.build`${'id'}`)
                .withBody(serialize);

            await caller(endpoint, { id: '123' });

            expect(serialize).not.toHaveBeenCalled();
            expect(sent().data).toBeUndefined();
        });

        test('sends the serialized body for a finalized endpoint', async () => {
            const { caller, sent } = createCaller();

            const endpoint = Endpoint()
                .post<{ tag: string }, void>()
                .asJson()
                .withBody(input => JSON.stringify(input.tag))
                .finalize();

            await caller(endpoint, { tag: 'news' });

            expect(sent().data).toBe('"news"');
            expect(sent().headers?.['Content-Type']).toBe('application/json');
        });
    });
});
