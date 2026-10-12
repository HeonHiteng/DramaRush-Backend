import { describe, expect, it } from 'vitest';
import { orientationOf } from './videoSize';

describe('orientationOf', () => {
  it('classifies by picture size like the app player', () => {
    expect(orientationOf(1920, 1080)).toBe('landscape');
    expect(orientationOf(1080, 1920)).toBe('portrait');
    expect(orientationOf(1080, 1080)).toBe('square');
    expect(orientationOf(1000, 1040)).toBe('square');
    expect(orientationOf(null, 1080)).toBeNull();
    expect(orientationOf(0, 0)).toBeNull();
  });
});
