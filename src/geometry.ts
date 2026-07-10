import type { FitMode, Point, Rect, Size } from './types.js';

const DEFAULT_POINT: Point = { x: 0.5, y: 0.5 };
const EPSILON = 1e-9;

export interface FitGeometryOptions {
  fit?: FitMode;
  focalPoint?: Point;
  alignment?: Point;
  /** Clockwise source metadata rotation. Arbitrary rotations use their axis-aligned bounds. */
  rotationDegrees?: number;
  /** Width-to-height ratio of a source pixel. */
  pixelAspectRatio?: number;
}

export interface FitGeometry {
  /** Crop in the display-oriented source coordinate space. */
  sourceRect: Rect;
  /** Placement in output pixel coordinates. */
  destinationRect: Rect;
  /** Display size after pixel-aspect correction and source metadata rotation. */
  orientedSourceSize: Size;
  /** Identical X/Y scale; exposed so renderers never need to infer a stretch transform. */
  scale: number;
  rotationDegrees: number;
  fit: FitMode;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    throw new RangeError('Rotation must be a finite number.');
  }

  const normalized = ((degrees % 360) + 360) % 360;
  return Math.abs(normalized - 360) < EPSILON || Math.abs(normalized) < EPSILON ? 0 : normalized;
}

export function getOrientedSize(
  source: Size,
  rotationDegrees = 0,
  pixelAspectRatio = 1,
): Size {
  assertSize(source, 'Source');
  assertPositiveFinite(pixelAspectRatio, 'Pixel aspect ratio');

  const width = source.width * pixelAspectRatio;
  const height = source.height;
  const radians = (normalizeDegrees(rotationDegrees) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));

  return cleanSize({
    width: width * cosine + height * sine,
    height: width * sine + height * cosine,
  });
}

/**
 * Calculates one uniform scale for either crop-to-fill (`cover`) or fit-inside
 * (`contain`). `contain` only returns the foreground placement; callers can fill
 * the remainder from lower tracks or a blurred background without letterboxing.
 */
export function computeFitGeometry(
  source: Size,
  destination: Rect,
  options: FitGeometryOptions = {},
): FitGeometry {
  assertSize(source, 'Source');
  assertRect(destination, 'Destination');

  const rotationDegrees = normalizeDegrees(options.rotationDegrees ?? 0);
  const orientedSourceSize = getOrientedSize(
    source,
    rotationDegrees,
    options.pixelAspectRatio ?? 1,
  );
  const fit = options.fit ?? 'cover';

  if (fit === 'cover') {
    const scale = Math.max(
      destination.width / orientedSourceSize.width,
      destination.height / orientedSourceSize.height,
    );
    const cropWidth = destination.width / scale;
    const cropHeight = destination.height / scale;
    const focalPoint = normalizePoint(options.focalPoint ?? DEFAULT_POINT);
    const idealX = focalPoint.x * orientedSourceSize.width - cropWidth / 2;
    const idealY = focalPoint.y * orientedSourceSize.height - cropHeight / 2;

    return {
      sourceRect: {
        x: cleanNumber(clamp(idealX, 0, orientedSourceSize.width - cropWidth)),
        y: cleanNumber(clamp(idealY, 0, orientedSourceSize.height - cropHeight)),
        width: cleanNumber(cropWidth),
        height: cleanNumber(cropHeight),
      },
      destinationRect: { ...destination },
      orientedSourceSize,
      scale: cleanNumber(scale),
      rotationDegrees,
      fit,
    };
  }

  const scale = Math.min(
    destination.width / orientedSourceSize.width,
    destination.height / orientedSourceSize.height,
  );
  const outputWidth = orientedSourceSize.width * scale;
  const outputHeight = orientedSourceSize.height * scale;
  const alignment = normalizePoint(options.alignment ?? DEFAULT_POINT);

  return {
    sourceRect: { x: 0, y: 0, ...orientedSourceSize },
    destinationRect: {
      x: cleanNumber(destination.x + (destination.width - outputWidth) * alignment.x),
      y: cleanNumber(destination.y + (destination.height - outputHeight) * alignment.y),
      width: cleanNumber(outputWidth),
      height: cleanNumber(outputHeight),
    },
    orientedSourceSize,
    scale: cleanNumber(scale),
    rotationDegrees,
    fit,
  };
}

export function normalizedRectToPixels(rect: Rect, output: Size): Rect {
  assertNormalizedRect(rect);
  assertSize(output, 'Output');

  return {
    x: rect.x * output.width,
    y: rect.y * output.height,
    width: rect.width * output.width,
    height: rect.height * output.height,
  };
}

export function fullFrameRect(output: Size): Rect {
  assertSize(output, 'Output');
  return { x: 0, y: 0, width: output.width, height: output.height };
}

/** Rotates a normalized source point clockwise, useful for metadata-oriented focal points. */
export function rotateNormalizedPoint(point: Point, rotationDegrees: number): Point {
  const normalizedPoint = normalizePoint(point);
  const radians = (normalizeDegrees(rotationDegrees) * Math.PI) / 180;
  const x = normalizedPoint.x - 0.5;
  const y = normalizedPoint.y - 0.5;

  return {
    x: cleanNumber(clamp(x * Math.cos(radians) - y * Math.sin(radians) + 0.5, 0, 1)),
    y: cleanNumber(clamp(x * Math.sin(radians) + y * Math.cos(radians) + 0.5, 0, 1)),
  };
}

function normalizePoint(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError('Normalized points must contain finite coordinates.');
  }

  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

function assertSize(size: Size, label: string): void {
  assertPositiveFinite(size.width, `${label} width`);
  assertPositiveFinite(size.height, `${label} height`);
}

function assertRect(rect: Rect, label: string): void {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new RangeError(`${label} origin must contain finite coordinates.`);
  }
  assertSize(rect, label);
}

function assertNormalizedRect(rect: Rect): void {
  assertRect(rect, 'Normalized rectangle');
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x > 1 ||
    rect.y > 1 ||
    rect.width > 1 ||
    rect.height > 1 ||
    rect.x + rect.width > 1 + EPSILON ||
    rect.y + rect.height > 1 + EPSILON
  ) {
    throw new RangeError('Normalized rectangles must fit inside the inclusive 0..1 range.');
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
}

function cleanNumber(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < EPSILON) {
    return rounded;
  }
  const precisionRounded = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  if (Math.abs(value - precisionRounded) < EPSILON) {
    return Object.is(precisionRounded, -0) ? 0 : precisionRounded;
  }
  return Object.is(value, -0) ? 0 : value;
}

function cleanSize(size: Size): Size {
  return { width: cleanNumber(size.width), height: cleanNumber(size.height) };
}
