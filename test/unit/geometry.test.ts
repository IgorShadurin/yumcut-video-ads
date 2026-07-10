import { describe, expect, it } from 'vitest';
import {
  computeFitGeometry,
  fullFrameRect,
  getOrientedSize,
  normalizedRectToPixels,
  normalizeDegrees,
  rotateNormalizedPoint,
} from '../../src/geometry.js';

describe('computeFitGeometry', () => {
  it('covers a portrait output without stretching a landscape source', () => {
    const geometry = computeFitGeometry(
      { width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1080, height: 1920 },
    );

    expect(geometry.sourceRect).toEqual({
      x: 656.25,
      y: 0,
      width: 607.5,
      height: 1080,
    });
    expect(geometry.destinationRect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(geometry.scale).toBeCloseTo(1920 / 1080);
    expect(geometry.destinationRect.width / geometry.sourceRect.width).toBeCloseTo(
      geometry.destinationRect.height / geometry.sourceRect.height,
    );
  });

  it('keeps a focal point visible while clamping the cover crop', () => {
    const left = computeFitGeometry(
      { width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1080, height: 1920 },
      { focalPoint: { x: 0, y: 0.5 } },
    );
    const right = computeFitGeometry(
      { width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1080, height: 1920 },
      { focalPoint: { x: 1, y: 0.5 } },
    );

    expect(left.sourceRect.x).toBe(0);
    expect(right.sourceRect.x + right.sourceRect.width).toBe(1920);
  });

  it('contains with a uniform scale and configurable alignment', () => {
    const geometry = computeFitGeometry(
      { width: 1920, height: 1080 },
      { x: 100, y: 50, width: 1080, height: 1920 },
      { fit: 'contain', alignment: { x: 0.5, y: 0 } },
    );

    expect(geometry.sourceRect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(geometry.destinationRect).toEqual({ x: 100, y: 50, width: 1080, height: 607.5 });
    expect(geometry.destinationRect.width / geometry.sourceRect.width).toBeCloseTo(
      geometry.destinationRect.height / geometry.sourceRect.height,
    );
  });

  it('accounts for rotation and non-square source pixels', () => {
    expect(getOrientedSize({ width: 720, height: 576 }, 0, 16 / 15)).toEqual({
      width: 768,
      height: 576,
    });
    expect(getOrientedSize({ width: 1920, height: 1080 }, 90)).toEqual({
      width: 1080,
      height: 1920,
    });
  });
});

describe('geometry utilities', () => {
  it('normalizes negative and complete rotations', () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(720)).toBe(0);
  });

  it('rotates normalized focal points clockwise', () => {
    expect(rotateNormalizedPoint({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(rotateNormalizedPoint({ x: 0.25, y: 0.75 }, 180)).toEqual({ x: 0.75, y: 0.25 });
  });

  it('converts normalized placement to output pixels', () => {
    expect(
      normalizedRectToPixels(
        { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
        { width: 3840, height: 2160 },
      ),
    ).toEqual({ x: 384, y: 432, width: 1920, height: 540 });
    expect(fullFrameRect({ width: 3840, height: 2160 })).toEqual({
      x: 0,
      y: 0,
      width: 3840,
      height: 2160,
    });
  });

  it('rejects impossible sizes and out-of-frame normalized rectangles', () => {
    expect(() =>
      computeFitGeometry(
        { width: 0, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      normalizedRectToPixels(
        { x: 0.75, y: 0, width: 0.5, height: 1 },
        { width: 1920, height: 1080 },
      ),
    ).toThrow(RangeError);
  });
});
