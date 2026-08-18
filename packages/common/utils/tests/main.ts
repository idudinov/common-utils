import fc from 'fast-check';
import { faker } from '@faker-js/faker';

export const toArbitrary = <T = any>(fakerGen: () => T) => {
    return fc.noShrink(fc.noBias(fc.integer()))
        .map(seed => {
            faker.seed(seed);
            return fakerGen();
        });
};
