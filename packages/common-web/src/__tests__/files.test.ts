import { describe, expect, it } from 'vitest';
import { getFileExtension } from '../files.js';

describe('getFileExtension', () => {
    it('returns lowercased extension for a normal filename', () => {
        expect(getFileExtension(new File([], 'photo.PNG'))).toBe('png');
    });

    it('returns null when filename has no dot', () => {
        expect(getFileExtension(new File([], 'photo'))).toBeNull();
    });

    it('returns empty string when filename has a trailing dot', () => {
        expect(getFileExtension(new File([], 'photo.'))).toBe('');
    });

    it('returns null for empty filename', () => {
        expect(getFileExtension(new File([], ''))).toBeNull();
    });
});
