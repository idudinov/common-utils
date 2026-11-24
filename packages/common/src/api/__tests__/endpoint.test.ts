import { createLazy } from '../../lazy/light.js';
import { extendObject } from '../../structures/extendObject.js';
import { Path } from '../../structures/path/index.js';
import { type Mutable } from '../../types/misc.js';
import { buildApiCaller } from '../call.js';
import { ApiEndpoint, type IEndpointInfo } from '../endpoint.js';
import { IEndpointInputContentType } from '../extensions/contentType.js';
import { IEndpointFormData } from '../extensions/formData.js';
import { IEndpointInputValidation } from '../extensions/validation.js';
import { EndpointMethods } from '../methods.js';

describe('api/endpoint', () => {

    function testOutput<T extends IEndpointInfo>(_endpoint: T, out: IEndpointInfo.ExtractOut<T>) {
        return out;
    }

    it('constructs', () => {

        const endpoint = ApiEndpoint.create('Get User')
            .post<{ id: string }, { name: string }>()
            .withPath(Path.build`/user/${'id'}`)
            .withQuery<{ full?: boolean }>('full')
            .withErrors<{ message: string }>()
            .withHeaders({ 'x-token': '123' })
            .finalize();

        expect(endpoint.displayName).toBe('Get User');
        expect(endpoint.method).toBe('POST');
        expect(endpoint.queryKeys).toEqual(['full']);

        type TOut = IEndpointInfo.ExtractOut<typeof endpoint>;
        const out: TOut = { name: '123' };
        testOutput(endpoint, out);

        expect(endpoint.path.template(':', { addStart: true })).toBe('/user/:id');
        expect(endpoint.path.build()).toBe('user');

        // @ts-expect-error extraneous argument
        expect(endpoint.path.build(['123', 123])).toBe('user/123');

        expect(endpoint.method).toBe('POST');
        expect(endpoint.displayName).toBe('Get User');
        expect(endpoint.queryKeys).toEqual(['full']);

        expect(ApiEndpoint.create().get().method).toBe('GET');
        expect(ApiEndpoint.create().delete().method).toBe('DELETE');
        expect(ApiEndpoint.create().put().method).toBe('PUT');
        expect(ApiEndpoint.create().patch().method).toBe('PATCH');
        expect(ApiEndpoint.create().method).toBe('GET');
        expect(ApiEndpoint.create().put().post().method).toBe('POST');

        expect(ApiEndpoint.create().withMethod(EndpointMethods.PUT).method).toBe('PUT');
        expect(ApiEndpoint.create().withMethod(EndpointMethods.OPTIONS).method).toBe('OPTIONS');

        expect(ApiEndpoint.create().delete().method).toBe('DELETE');
    });

    it('isEndpoint', () => {
        expect(ApiEndpoint.isEndpoint(ApiEndpoint.create())).toBe(true);
        expect(ApiEndpoint.isEndpoint(ApiEndpoint.create().finalize())).toBe(true);

        expect(ApiEndpoint.isEndpoint(null)).toBe(false);
        expect(ApiEndpoint.isEndpoint('GET')).toBe(false);
        expect(ApiEndpoint.isEndpoint({ method: 'GET' })).toBe(false);
    });

    describe('extends', () => {
        it('basic/contentType', () => {
            const create = ApiEndpoint.create.extend(IEndpointInputContentType.extender);

            const endpointExtended = create('Get User');
            expect(endpointExtended.contentType).toBeUndefined();

            endpointExtended.asUrlEncoded();
            expect(endpointExtended.contentType).toBe('application/x-www-form-urlencoded');
            expect(endpointExtended.withContentType('text/plain').contentType).toBe('text/plain');
            expect(endpointExtended.asMultipartForm().contentType).toBe('multipart/form-data');
            expect(endpointExtended.asJson().contentType).toBe('application/json');
        });

        it('basic/validation', () => {
            const create = ApiEndpoint.create.extend(IEndpointInputValidation.extender);

            const endpointExtended = create('Get User')
                .post<{ id: string }, { name: string }>();

            expect(endpointExtended.validate).toBeUndefined();

            endpointExtended.withValidation(input => {
                type BanAny<T, Y, N> = 0 extends (1 & T) ? Y : N;
                const i: BanAny<typeof input.id, never, typeof input> = input;
                // no-op usage of input.id to check its type is not 'any'
                // eslint-disable-next-line no-console
                console.log(i.id);
            });

             buildApiCaller({
                request: async () => null!,
                hooks: {
                    beforeConfig: async (api, body) => {
                        // just type checking here
                        await IEndpointInputValidation.tryValidate(api, body);
                    },
                },
            });
        });

        it('custom', () => {

            interface ICustomExtension {
                readonly customField: string | undefined;
                withCustomField(value: string): this;
            }

            const create = ApiEndpoint.create.extend<ICustomExtension>(base => {
                const ext = {
                    customField: undefined,
                    withCustomField(this: Mutable<ICustomExtension>, value: string) {
                        this.customField = value;
                        return this;
                    },
                } as ICustomExtension;
                return Object.assign(base, ext);
            });

            const e1 = create();
            e1.withCustomField('123');

            const endpoint = create().post<{ id: string }, { name: string }>()
                .withCustomField('123')
                .withPath(Path.build`/user/${'id'}`)
                ;

            expect(endpoint.customField).toBe('123');
            expect(endpoint.path.template(':', { addStart: true })).toBe('/user/:id');

            const finalized = endpoint.finalize();
            expect((finalized as unknown as typeof endpoint).withCustomField).toBeUndefined();
            expect(finalized.customField).toBe('123');
            expect(finalized.path.template(':', { addStart: true })).toBe('/user/:id');
        });
    });

    describe('finalize', () => {
        it('keeps function fields, drops builder methods and stays repeatable', () => {
            const validate = vi.fn();
            const errorProcessor = vi.fn();
            const serializer = vi.fn();

            const endpoint = ApiEndpoint.create
                .extend(IEndpointInputValidation.extender)
                .extend(IEndpointFormData.extender)('Upload')
                .post<{ id: string }, { name: string }>()
                .withPath(Path.build`/upload/${'id'}`)
                .withErrors<{ message: string }>(errorProcessor)
                .withValidation(validate)
                .asFormData(serializer);

            const functionKeys = (finalized: object) => Object.entries(finalized)
                .filter(([, value]) => typeof value === 'function')
                .map(([key]) => key)
                .sort();

            const finalized = endpoint.finalize();

            expect(finalized.validate).toBe(validate);
            expect(finalized.errorProcessor).toBe(errorProcessor);
            expect(finalized.formData).toBe(serializer);
            expect(functionKeys(finalized)).toEqual(['errorProcessor', 'formData', 'validate']);
            expect(Object.isFrozen(finalized)).toBe(true);
            expect(ApiEndpoint.isEndpoint(finalized)).toBe(true);

            const second = endpoint.finalize();

            expect(second).not.toBe(finalized);
            expect(second).toEqual(finalized);
        });

        it('copies an extender accessor by the value it has after the path is set', () => {
            interface IPathTemplate {
                readonly pathTemplate: string;
            }

            const create = ApiEndpoint.create.extend<IPathTemplate>(base => {
                const lazyTemplate = createLazy(
                    () => (base as IEndpointInfo.IPathAbstract).path?.template(':', { addStart: true }) ?? '',
                );
                return extendObject<ApiEndpoint, IPathTemplate>(base, {
                    pathTemplate: { get: () => lazyTemplate.value, enumerable: true },
                });
            });

            const finalized = create()
                .get<string>()
                .withPath(Path.build`/user/${'id'}`)
                .finalize();

            expect(finalized.pathTemplate).toBe('/user/:id');
        });
    });

});
