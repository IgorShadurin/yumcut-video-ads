import { describe, expect, it } from 'vitest';
import {
  __private__,
  type CompositorImageSource,
  type CompositorLayer,
} from '../../src/compositor.js';

const imageSource = {} as CompositorImageSource;

const layer = (overrides: Partial<CompositorLayer> = {}): CompositorLayer => ({
  source: imageSource,
  sourceWidth: 1920,
  sourceHeight: 1080,
  fit: 'cover',
  box: { x: 0, y: 0, width: 1, height: 1 },
  focalPoint: { x: 0.5, y: 0.5 },
  alignment: { x: 0.5, y: 0.5 },
  position: { x: 0, y: 0 },
  scale: 1,
  rotation: 0,
  opacity: 1,
  ...overrides,
});

describe('compositor placement', () => {
  it('covers a portrait frame by cropping without stretching the source', () => {
    const placement = __private__.placementFor(1080, 1920, layer());

    expect(placement.source).toEqual({
      x: 656.25,
      y: 0,
      width: 607.5,
      height: 1080,
    });
    expect(placement.destination).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(placement.destination.width / placement.source.width).toBeCloseTo(
      placement.destination.height / placement.source.height,
    );
  });

  it('clamps a cover focal point to the available crop bounds', () => {
    const left = __private__.placementFor(
      1080,
      1920,
      layer({ focalPoint: { x: -1, y: 0.5 } }),
    );
    const right = __private__.placementFor(
      1080,
      1920,
      layer({ focalPoint: { x: 2, y: 0.5 } }),
    );

    expect(left.source.x).toBe(0);
    expect(right.source.x + right.source.width).toBe(1920);
  });

  it('contains with uniform scale, clamped alignment, and normalized translation', () => {
    const placement = __private__.placementFor(
      1000,
      1000,
      layer({
        sourceWidth: 400,
        sourceHeight: 200,
        fit: 'contain',
        box: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
        alignment: { x: -3, y: 4 },
        position: { x: 0.05, y: -0.1 },
        scale: 0.5,
      }),
    );

    expect(placement.source).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(placement.destination).toEqual({ x: 150, y: 500, width: 400, height: 200 });
    expect(placement.destination.width / placement.source.width).toBeCloseTo(
      placement.destination.height / placement.source.height,
    );
  });

  it('keeps a cover scale centered in its box and applies output-relative position', () => {
    const placement = __private__.placementFor(
      800,
      600,
      layer({
        sourceWidth: 800,
        sourceHeight: 600,
        box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        position: { x: 0.1, y: -0.05 },
        scale: 1.5,
      }),
    );

    expect(placement.destination).toEqual({ x: 180, y: 45, width: 600, height: 450 });
  });

  it('uses a small positive scale for zero and negative scale values', () => {
    const zero = __private__.placementFor(1000, 500, layer({ scale: 0 }));
    const negative = __private__.placementFor(1000, 500, layer({ scale: -10 }));

    expect(zero.destination.width).toBeCloseTo(0.1);
    expect(zero.destination.height).toBeCloseTo(0.05);
    expect(negative.destination).toEqual(zero.destination);
  });
});
