import { describe, expect, it } from 'vitest';
import {
  activeClipsAt,
  clipEndUs,
  frameCountForDuration,
  frameTimestampUs,
  frameTimestamps,
  intervalsOverlap,
  millisecondsToUs,
  overlapDurationUs,
  projectDurationUs,
  secondsToUs,
  sortClipsByTime,
  sourceTimestampUs,
  transitionOpacity,
  usToMilliseconds,
  usToSeconds,
} from '../../src/timeline.js';
import type { BaseClip, Project } from '../../src/types.js';

describe('time conversion', () => {
  it('rounds external time values to integer microseconds', () => {
    expect(secondsToUs(1.2345674)).toBe(1_234_567);
    expect(millisecondsToUs(12.3456)).toBe(12_346);
    expect(usToSeconds(1_500_000)).toBe(1.5);
    expect(usToMilliseconds(12_500)).toBe(12.5);
  });

  it('rejects values that lose safe integer precision', () => {
    expect(() => secondsToUs(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => usToSeconds(0.5)).toThrow(RangeError);
  });
});

describe('frame timing', () => {
  it('derives every frame from its index instead of accumulating rounded durations', () => {
    expect(frameTimestampUs(0, 30)).toBe(0);
    expect(frameTimestampUs(1, 30)).toBe(33_333);
    expect(frameTimestampUs(9_000, 30)).toBe(300_000_000);
    expect(frameTimestampUs(300, 29.97)).toBe(Math.round((300 * 1_000_000) / 29.97));
  });

  it('uses half-open duration boundaries', () => {
    expect(frameCountForDuration(1_000_000, 30)).toBe(30);
    expect(frameCountForDuration(1_000_001, 30)).toBe(31);
    expect([...frameTimestamps(100_000, 30)]).toEqual([0, 33_333, 66_667]);
  });

  it('lazily supports a five-minute 60 fps timeline', () => {
    const timestamps = frameTimestamps(secondsToUs(300), 60);
    let count = 0;
    let last = -1;
    for (const timestamp of timestamps) {
      count += 1;
      last = timestamp;
    }
    expect(count).toBe(18_000);
    expect(last).toBe(frameTimestampUs(17_999, 60));
  });
});

describe('clip timeline operations', () => {
  const first = { startUs: 0, durationUs: 1_000_000 };
  const touching = { startUs: 1_000_000, durationUs: 500_000 };
  const overlapping = { startUs: 750_000, durationUs: 500_000 };

  it('treats intervals as half-open', () => {
    expect(clipEndUs(first)).toBe(1_000_000);
    expect(intervalsOverlap(first, touching)).toBe(false);
    expect(intervalsOverlap(first, overlapping)).toBe(true);
    expect(overlapDurationUs(first, overlapping)).toBe(250_000);
    expect(activeClipsAt([first, touching], 1_000_000)).toEqual([touching]);
  });

  it('sorts stably by start time', () => {
    const clips = [
      { id: 'later', startUs: 5, durationUs: 1 },
      { id: 'first-a', startUs: 0, durationUs: 1 },
      { id: 'first-b', startUs: 0, durationUs: 1 },
    ];
    expect(sortClipsByTime(clips).map(({ id }) => id)).toEqual(['first-a', 'first-b', 'later']);
  });

  it('maps and loops source timestamps after trim', () => {
    const clip = { startUs: 1_000_000, durationUs: 5_000_000, trimStartUs: 2_000_000 };
    expect(sourceTimestampUs(clip, 999_999)).toBeNull();
    expect(sourceTimestampUs(clip, 1_500_000)).toBe(2_500_000);
    expect(sourceTimestampUs({ ...clip, loop: true }, 5_500_000, 5_000_000)).toBe(3_500_000);
  });

  it('calculates fade opacity at timeline edges', () => {
    const clip: BaseClip = {
      startUs: 1_000_000,
      durationUs: 2_000_000,
      opacity: 0.8,
      transitionIn: { type: 'fade', durationUs: 500_000 },
      transitionOut: { type: 'fade', durationUs: 500_000 },
    };
    expect(transitionOpacity(clip, 1_250_000)).toBeCloseTo(0.4);
    expect(transitionOpacity(clip, 2_000_000)).toBeCloseTo(0.8);
    expect(transitionOpacity(clip, 2_875_000)).toBeCloseTo(0.2);
    expect(transitionOpacity(clip, 3_000_000)).toBe(0);
  });

  it('derives natural project duration unless output overrides it', () => {
    const project: Project = {
      output: { width: 1920, height: 1080 },
      tracks: [
        {
          type: 'visual',
          clips: [
            {
              type: 'text',
              text: 'End card',
              style: { fontSize: 64 },
              startUs: 5_000_000,
              durationUs: 2_000_000,
            },
          ],
        },
      ],
    };
    expect(projectDurationUs(project)).toBe(7_000_000);
    expect(projectDurationUs({ ...project, output: { ...project.output, durationUs: 6_000_000 } })).toBe(
      6_000_000,
    );
  });
});
