import type { BaseClip, Clip, Project, TimeUs, Track } from './types.js';

export const MICROSECONDS_PER_MILLISECOND = 1_000;
export const MICROSECONDS_PER_SECOND = 1_000_000;

export interface TimelineInterval {
  startUs: TimeUs;
  durationUs: TimeUs;
}

export function secondsToUs(seconds: number): TimeUs {
  return toSafeMicroseconds(seconds * MICROSECONDS_PER_SECOND, 'Seconds');
}

export function millisecondsToUs(milliseconds: number): TimeUs {
  return toSafeMicroseconds(milliseconds * MICROSECONDS_PER_MILLISECOND, 'Milliseconds');
}

export function usToSeconds(timestampUs: TimeUs): number {
  assertSafeTime(timestampUs, 'Timestamp');
  return timestampUs / MICROSECONDS_PER_SECOND;
}

export function usToMilliseconds(timestampUs: TimeUs): number {
  assertSafeTime(timestampUs, 'Timestamp');
  return timestampUs / MICROSECONDS_PER_MILLISECOND;
}

export function clipEndUs(clip: TimelineInterval): TimeUs {
  assertInterval(clip);
  const end = clip.startUs + clip.durationUs;
  assertSafeTime(end, 'Clip end');
  return end;
}

export function intervalsOverlap(a: TimelineInterval, b: TimelineInterval): boolean {
  return a.startUs < clipEndUs(b) && b.startUs < clipEndUs(a);
}

export function overlapDurationUs(a: TimelineInterval, b: TimelineInterval): TimeUs {
  const start = Math.max(a.startUs, b.startUs);
  const end = Math.min(clipEndUs(a), clipEndUs(b));
  return Math.max(0, end - start);
}

export function containsTimestamp(interval: TimelineInterval, timestampUs: TimeUs): boolean {
  assertSafeTime(timestampUs, 'Timestamp');
  return timestampUs >= interval.startUs && timestampUs < clipEndUs(interval);
}

/** Returns a frame timestamp calculated from its index, avoiding cumulative frame drift. */
export function frameTimestampUs(frameIndex: number, frameRate: number): TimeUs {
  assertFrameRate(frameRate);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError('Frame index must be a non-negative safe integer.');
  }
  return toSafeMicroseconds((frameIndex * MICROSECONDS_PER_SECOND) / frameRate, 'Frame timestamp');
}

/** The number of frames with a presentation timestamp strictly before `durationUs`. */
export function frameCountForDuration(durationUs: TimeUs, frameRate: number): number {
  assertNonNegativeSafeTime(durationUs, 'Duration');
  assertFrameRate(frameRate);
  if (durationUs === 0) {
    return 0;
  }

  // Subtract a tiny relative epsilon so an exact frame boundary is not counted twice.
  const exact = (durationUs * frameRate) / MICROSECONDS_PER_SECOND;
  const count = Math.ceil(exact - Number.EPSILON * Math.max(1, exact));
  if (!Number.isSafeInteger(count)) {
    throw new RangeError('Frame count exceeds JavaScript safe integer precision.');
  }
  return count;
}

/** Lazily yields timestamps so long projects never require a timestamp array allocation. */
export function* frameTimestamps(
  durationUs: TimeUs,
  frameRate: number,
): Generator<TimeUs, void, undefined> {
  const count = frameCountForDuration(durationUs, frameRate);
  for (let index = 0; index < count; index += 1) {
    yield frameTimestampUs(index, frameRate);
  }
}

export function sortClipsByTime<T extends TimelineInterval>(clips: readonly T[]): T[] {
  return clips
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => a.clip.startUs - b.clip.startUs || a.index - b.index)
    .map(({ clip }) => clip);
}

export function activeClipsAt<T extends TimelineInterval>(
  clips: readonly T[],
  timestampUs: TimeUs,
): T[] {
  return clips.filter((clip) => containsTimestamp(clip, timestampUs));
}

export function trackDurationUs(track: Track): TimeUs {
  let durationUs = 0;
  for (const clip of track.clips) {
    durationUs = Math.max(durationUs, clipEndUs(clip));
  }
  return durationUs;
}

export function projectDurationUs(project: Project): TimeUs {
  if (project.output.durationUs !== undefined) {
    assertNonNegativeSafeTime(project.output.durationUs, 'Project duration');
    return project.output.durationUs;
  }

  let durationUs = 0;
  for (const track of project.tracks) {
    durationUs = Math.max(durationUs, trackDurationUs(track));
  }
  return durationUs;
}

/**
 * Maps a composition timestamp to source time. Returns `null` outside the clip.
 * When looping, `sourceDurationUs` is the complete source duration and trim is
 * treated as the beginning of the loopable region.
 */
export function sourceTimestampUs(
  clip: Pick<Clip, 'startUs' | 'durationUs'> & {
    trimStartUs?: TimeUs;
    loop?: boolean;
  },
  timestampUs: TimeUs,
  sourceDurationUs?: TimeUs,
): TimeUs | null {
  if (!containsTimestamp(clip, timestampUs)) {
    return null;
  }

  const trimStartUs = clip.trimStartUs ?? 0;
  assertNonNegativeSafeTime(trimStartUs, 'Trim start');
  const elapsedUs = timestampUs - clip.startUs;

  if (clip.loop !== true) {
    return trimStartUs + elapsedUs;
  }

  if (sourceDurationUs === undefined) {
    throw new RangeError('A source duration is required for looping clips.');
  }
  assertNonNegativeSafeTime(sourceDurationUs, 'Source duration');
  const loopDurationUs = sourceDurationUs - trimStartUs;
  if (loopDurationUs <= 0) {
    throw new RangeError('Trim start must be earlier than the source duration when looping.');
  }

  return trimStartUs + (elapsedUs % loopDurationUs);
}

export function transitionOpacity(clip: BaseClip, timestampUs: TimeUs): number {
  if (!containsTimestamp(clip, timestampUs)) {
    return 0;
  }

  const elapsedUs = timestampUs - clip.startUs;
  const remainingUs = clipEndUs(clip) - timestampUs;
  const inOpacity = clip.transitionIn?.type === 'fade'
    ? transitionRatio(elapsedUs, clip.transitionIn.durationUs)
    : 1;
  const outOpacity = clip.transitionOut?.type === 'fade'
    ? transitionRatio(remainingUs, clip.transitionOut.durationUs)
    : 1;

  return Math.min(inOpacity, outOpacity) * (clip.opacity ?? 1);
}

function transitionRatio(elapsedUs: number, durationUs: number): number {
  if (durationUs <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, elapsedUs / durationUs));
}

function assertInterval(interval: TimelineInterval): void {
  assertNonNegativeSafeTime(interval.startUs, 'Clip start');
  if (!Number.isSafeInteger(interval.durationUs) || interval.durationUs <= 0) {
    throw new RangeError('Clip duration must be a positive safe integer number of microseconds.');
  }
}

function assertFrameRate(frameRate: number): void {
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new RangeError('Frame rate must be a positive finite number.');
  }
}

function assertSafeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer number of microseconds.`);
  }
}

function assertNonNegativeSafeTime(value: number, label: string): void {
  assertSafeTime(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must not be negative.`);
  }
}

function toSafeMicroseconds(value: number, label: string): TimeUs {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite.`);
  }
  const rounded = Math.round(value);
  assertSafeTime(rounded, label);
  return rounded;
}
