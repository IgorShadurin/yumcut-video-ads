import { describe, expect, it } from 'vitest';
import { __private__ } from '../../src/audio-mixer.js';

describe('audio stereo conversion', () => {
  it('returns silence when a decoded sample has no channels', () => {
    expect(__private__.stereoAt([], 0, 1, 0.5)).toEqual([0, 0]);
  });

  it('duplicates mono audio and linearly interpolates source frames', () => {
    const mono = Float32Array.from([0, 1]);

    expect(__private__.stereoAt([mono], 0, 1, 0.25)).toEqual([0.25, 0.25]);
  });

  it('preserves and independently interpolates stereo channels', () => {
    const left = Float32Array.from([0, 1]);
    const right = Float32Array.from([1, -1]);

    expect(__private__.stereoAt([left, right], 0, 1, 0.25)).toEqual([0.25, 0.5]);
  });

  it('holds the final value when interpolation reaches beyond a plane', () => {
    const mono = Float32Array.of(0.75);

    expect(__private__.stereoAt([mono], 0, 1, 0.5)).toEqual([0.75, 0.75]);
  });

  it('downmixes center and surround channels while excluding LFE', () => {
    const planes = [
      Float32Array.of(1),
      Float32Array.of(2),
      Float32Array.of(4),
      Float32Array.of(100),
      Float32Array.of(6),
      Float32Array.of(8),
    ];

    const [left, right] = __private__.stereoAt(planes, 0, 0, 0);
    expect(left).toBeCloseTo(1 + 4 * Math.SQRT1_2 + 6 * 0.5);
    expect(right).toBeCloseTo(2 + 4 * Math.SQRT1_2 + 8 * 0.5);
  });

  it('maps quad surrounds to their corresponding stereo sides', () => {
    const planes = [1, 2, 6, 8].map((value) => Float32Array.of(value));
    expect(__private__.stereoAt(planes, 0, 0, 0)).toEqual([4, 6]);
  });

  it('downmixes a five-channel center and surround layout', () => {
    const planes = [1, 2, 4, 6, 8].map((value) => Float32Array.of(value));
    const [left, right] = __private__.stereoAt(planes, 0, 0, 0);
    expect(left).toBeCloseTo(1 + 4 * Math.SQRT1_2 + 3);
    expect(right).toBeCloseTo(2 + 4 * Math.SQRT1_2 + 4);
  });
});

describe('audio output limiting', () => {
  it('preserves normal samples and continuously limits overloads below full scale', () => {
    expect(__private__.softLimit(0.5)).toBe(0.5);
    expect(__private__.softLimit(-0.98)).toBe(-0.98);
    expect(__private__.softLimit(1.25)).toBeGreaterThan(0.98);
    expect(__private__.softLimit(1.25)).toBeLessThanOrEqual(1);
    expect(__private__.softLimit(-4)).toBeGreaterThanOrEqual(-1);
  });

  it('does not change quiet samples based on another chunk sample peak', () => {
    const quietBeforePeak = __private__.softLimit(0.25);
    __private__.softLimit(12);
    expect(__private__.softLimit(0.25)).toBe(quietBeforePeak);
  });
});
