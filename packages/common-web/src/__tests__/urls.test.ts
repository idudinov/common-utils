import { describe, it, expect } from 'vitest';
import { parseSearchQuery, createSearchQuery, createSearchParams, addParamsToUrl } from '../urls.js';

describe('parseSearchQuery', () => {
    it('parses key-value pairs', () => {
        expect(parseSearchQuery('?a=1&b=2')).toEqual({ a: '1', b: '2' });
    });

    it('treats valueless keys as true', () => {
        expect(parseSearchQuery('?flag')).toEqual({ flag: true });
    });

    it('handles empty search string', () => {
        expect(parseSearchQuery('')).toEqual({});
    });
});

describe('createSearchParams', () => {
    it('returns null for null args', () => {
        expect(createSearchParams(null)).toBeNull();
    });

    it('builds params from an object', () => {
        const res = createSearchParams({ a: '1', flag: true });
        expect(res?.toString()).toBe('a=1&flag=');
    });
});

describe('createSearchQuery', () => {
    it('returns empty string for null args', () => {
        expect(createSearchQuery(null)).toBe('');
    });

    it('optionally prefixes with a question mark', () => {
        expect(createSearchQuery({ a: '1' }, true)).toBe('?a=1');
    });
});

describe('addParamsToUrl', () => {
    it('appends params to a valid url', () => {
        const params = new Map([['a', '1']]);
        expect(addParamsToUrl('http://example.com', params)).toBe('http://example.com/?a=1');
    });

    it('returns original url on parse error', () => {
        expect(addParamsToUrl('::not a url::')).toBe('::not a url::');
    });
});
