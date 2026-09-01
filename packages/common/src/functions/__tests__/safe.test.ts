import { formatError } from '../safe.js';

describe('formatError', () => {

    it('returns a string as-is', () => {
        expect(formatError('oops')).toBe('oops');
    });

    it('returns the message of an Error instance', () => {
        expect(formatError(new Error('oops'))).toBe('oops');
    });

    it('returns the message of an Error subclass instance', () => {
        expect(formatError(new TypeError('type mismatch'))).toBe('type mismatch');
    });

    it('stringifies non-string, non-Error values', () => {
        expect(formatError(42)).toBe('42');
        expect(formatError(null)).toBe('null');
        expect(formatError(undefined)).toBe('undefined');
    });
});
