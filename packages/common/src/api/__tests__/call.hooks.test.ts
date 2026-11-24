import { type Mock } from 'vitest';
import { buildApiCaller, type IRequestConfig } from '../call.js';
import { ApiEndpoint, type IEndpointInfo } from '../endpoint.js';
import { IEndpointBody } from '../extensions/body.js';
import { IEndpointInputContentType } from '../extensions/contentType.js';
import { IEndpointHooks } from '../extensions/endpointHooks.js';
import { IEndpointInputValidation } from '../extensions/validation.js';
import { CallerHooks } from '../hooks.js';
import { RequestMeta } from '../call.config.js';

describe('api/call/hooks', () => {
    test('beforeRequest | form', async () => {
        const request = vi.fn();
        const hook = vi.fn((config: IRequestConfig<any, any>) => {
            // clone config to test it will be correctly merged afterwards
            const result = {
                ...config,
                headers: {
                    ...config.headers,
                },
            };
            expect(config.headers).toEqual({});
            expect(result.headers).toEqual({});
            IEndpointInputContentType.tryApplyContentType(result._meta.api, result.headers);
            expect(result.headers['Content-Type']).toBe('multipart/form-data');
            return result;
        });

        const caller = buildApiCaller({
            request: async <TIn, TOut>(input: IRequestConfig<IEndpointInfo, TIn>) => {
                request(input);
                return { status: 200, data: { input: input.data } as TOut };
            },
            hooks: {
                beforeRequest: hook,
            },
        });

        const endpoint = ApiEndpoint.create.extend(IEndpointInputContentType.extender)()
            .asMultipartForm()
            .post<{ id: string }, { name: string }>();

        await expect(caller(endpoint, { id: '123' })).resolves.toEqual({ input: { id: '123' } });

        expect(hook).toHaveBeenCalled();

        expect(request).toHaveBeenCalledWith({
            _meta: expect.any(RequestMeta),
            method: 'POST',
            url: '/',
            data: { id: '123' },
            headers: { 'Content-Type': 'multipart/form-data' },
        });
    });

    describe('chaining', () => {
        test('beforeRequest | a returned config copy reaches the next hooks, and every hook gets one config object', async () => {
            const request = vi.fn();
            const seen = vi.fn();

            const caller = buildApiCaller({
                request: async <TIn, TOut>(input: IRequestConfig<IEndpointInfo, TIn>) => {
                    request(input);
                    return { data: null as TOut };
                },
                hooks: [
                    {
                        beforeRequest: config => ({ ...config, headers: { ...config.headers, 'X-Trace': '1' } }),
                    },
                    {
                        beforeRequest: config => {
                            seen(config);
                        },
                    },
                    IEndpointBody.createHooks(),
                ],
            });

            const endpoint = ApiEndpoint.create.extend(IEndpointBody.extender)()
                .post<{ tag: string }, void>()
                .withBody(input => JSON.stringify(input.tag));

            await caller(endpoint, { tag: 'news' });

            const sent = request.mock.lastCall![0] as IRequestConfig<IEndpointInfo>;
            expect(sent.data).toBe('"news"');
            expect(sent.headers).toEqual({ 'X-Trace': '1' });
            expect(seen.mock.lastCall![0]).toBe(sent);
        });

        test('afterResponse | a returned response replaces the received one for the next hook and for the caller', async () => {
            const seen = vi.fn();

            const caller = buildApiCaller({
                request: async <TIn, TOut>(_input: IRequestConfig<IEndpointInfo, TIn>) => ({ data: 'received' as TOut }),
                hooks: [
                    { afterResponse: vi.fn().mockReturnValue({ data: 'replaced' }) },
                    { afterResponse: seen },
                ],
            });

            const endpoint = ApiEndpoint.create().get<string>();

            await expect(caller(endpoint)).resolves.toBe('replaced');
            expect(seen).toHaveBeenCalledWith(expect.anything(), { data: 'replaced' });
        });
    });

    test('beforeConfig | validation', async () => {
        const request = vi.fn();
        const hook = vi.fn(async (api, body, path, query) => {

            expect(api).toEqual(endpoint);
            expect(body).toEqual({ id: 123 });
            expect(path).toEqual({});
            expect(query).toEqual({});

            await IEndpointInputValidation.tryValidate(api, body);
        });

        const validation = vi.fn((body) => {
            expect(body).toEqual({ id: 123 });
            return body;
        });

        const caller = buildApiCaller({
            request: async <TIn, TOut>(input: IRequestConfig<IEndpointInfo, TIn>) => {
                request(input);
                return { status: 200, data: { input: input.data } as TOut };
            },
            hooks: {
                beforeConfig: hook,
            },
        });

        const endpoint = ApiEndpoint.create.extend(IEndpointInputValidation.extender)()
            .post<{ id: string | number }, { name: string }>()
            .withValidation(validation);

        await expect(caller(endpoint, { id: 123 })).resolves.toEqual({ input: { id: 123 } });

        expect(hook).toHaveBeenCalled();
        expect(validation).toHaveBeenCalledWith({ id: 123 });

        expect(request).toHaveBeenCalledWith({
            _meta: expect.any(RequestMeta),
            method: 'POST',
            url: '/',
            data: { id: 123 },
            headers: {},
        });

        hook.mockClear();
        request.mockClear();

        // Test validation error

        const validation2 = vi.fn((body) => {
            expect(body).toEqual({ id: 123 });
            throw new Error('Validation error');
        });

        endpoint.withValidation(validation2);

        await expect(caller(endpoint, { id: 123 })).rejects.toThrow('Validation error');

        expect(validation2).toHaveBeenCalledWith({ id: 123 });
        expect(hook).toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    test('beforeConfig | validation on a finalized endpoint', async () => {
        const request = vi.fn();
        const validation = vi.fn((body: { id: string | number }) => {
            if (typeof body.id !== 'string') {
                throw new Error('Validation error');
            }
        });

        const caller = buildApiCaller({
            request,
            hooks: IEndpointInputValidation.createHooks(),
        });

        const endpoint = ApiEndpoint.create.extend(IEndpointInputValidation.extender)()
            .post<{ id: string | number }, { name: string }>()
            .withValidation(validation)
            .finalize();

        await expect(caller(endpoint, { id: 123 })).rejects.toThrow('Validation error');

        expect(validation).toHaveBeenCalledWith({ id: 123 });
        expect(request).not.toHaveBeenCalled();
    });

    test('merge/full', async () => {
        const request = vi.fn();

        const createHooks = (): CallerHooks<object> => ({
            beforeRequest: vi.fn(),
            beforeConfig: vi.fn(),
            afterResponse: vi.fn(),
        });

        const hooks1 = createHooks();
        const hooks2 = createHooks();

        const caller = buildApiCaller({
            request: async <TIn, TOut>(input: IRequestConfig<IEndpointInfo, TIn>) => {
                request(input);
                return { status: 200, data: { input: input.data } as TOut };
            },
            hooks: [
                hooks1,
                IEndpointInputContentType.createHooks(),
                IEndpointInputValidation.createHooks(),
                hooks2,
                IEndpointHooks.createHooks(),
            ],
        });

        const validation = vi.fn((body) => {
            expect(body).toEqual({ id: 123 });
            return body;
        });

        const endpoint = ApiEndpoint.create
            .extend(IEndpointInputValidation.extender)
            .extend(IEndpointInputContentType.extender)
            .extend(IEndpointHooks.extender)()
            .post<{ id: string | number }, { name: string }>()
            .withValidation(validation)
            .asJson();

        await expect(caller(endpoint, { id: 123 })).resolves.toEqual({ input: { id: 123 } });

        expect(validation).toHaveBeenCalledWith({ id: 123 });

        expect(request).toHaveBeenCalledWith({
            _meta: expect.any(RequestMeta),
            method: 'POST',
            url: '/',
            data: { id: 123 },
            headers: {
                'Content-Type': 'application/json',
            },
        });

        [
            ...Object.values(hooks1),
            ...Object.values(hooks2),
        ].forEach(hook => {
            expect(hook).toHaveBeenCalled();
            (hook as Mock).mockClear();
        });

        const hooks3 = createHooks();
        endpoint.withHooks(hooks3);

        await expect(caller(endpoint, { id: 123 })).resolves.toEqual({ input: { id: 123 } });

        Object.values(hooks3).forEach(hook => {
            expect(hook).toHaveBeenCalled();
            (hook as Mock).mockClear();
        });
    });

    test('merge/partial', async () => {

        const request = async <TIn, TOut>(input: IRequestConfig<IEndpointInfo, TIn>) => {
            return { status: 200, data: { input: input.data } as TOut };
        };

        const endpoint = ApiEndpoint.create()
            .post<{ id: string | number }, { name: string }>();

        {
            const caller = buildApiCaller({ request });

            await expect(caller(endpoint, { id: 123 })).resolves.not.toThrow();
        }

        {
            const caller = buildApiCaller({
                request,
                hooks: { },
            });

            await expect(caller(endpoint, { id: 123 })).resolves.not.toThrow();
        }

        {
            const fns = Array.from({ length: 3 }, () => vi.fn());

            // simulate a scattered chain of hooks
            const caller = buildApiCaller({
                request,
                hooks: [
                    { },
                    {
                        beforeRequest: fns[0],
                    },
                    { },
                    {
                        afterResponse: fns[2],
                    },
                    { },
                    {
                        beforeConfig: fns[1],
                    },
                    { },
                    {
                        afterResponse: fns[1],
                    },
                    { },
                    {
                        beforeRequest: fns[0],
                    },
                    { },
                    {
                        afterResponse: fns[2],
                    },
                    { },
                    { },
                    { },
                    { },
                ],
            });

            await expect(caller(endpoint, { id: 123 })).resolves.not.toThrow();

            fns.forEach(fn => {
                expect(fn).toHaveBeenCalledTimes(2);
                fn.mockClear();
            });
        }

    });
});
