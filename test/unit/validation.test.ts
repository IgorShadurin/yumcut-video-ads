import { describe, expect, it } from 'vitest';
import { VideoAdsError } from '../../src/errors.js';
import type { Project } from '../../src/types.js';
import {
  assertValidProject,
  isValidMediaSource,
  validateProject,
  validateSupportProfile,
  validatedProjectDurationUs,
} from '../../src/validation.js';

function validProject(): Project {
  return {
    output: {
      width: 3840,
      height: 2160,
      frameRate: 60,
      background: { type: 'blur', blurRadius: 32, dim: 0.2 },
    },
    tracks: [
      {
        id: 'visuals',
        type: 'visual',
        clips: [
          {
            id: 'hero',
            type: 'video',
            source: 'https://cdn.example.test/template.mp4',
            startUs: 0,
            durationUs: 10_000_000,
            fit: 'cover',
            focalPoint: { x: 0.25, y: 0.5 },
            volume: 0.8,
          },
          {
            type: 'text',
            text: 'Fast browser video',
            style: { fontSize: 96, color: '#fff' },
            startUs: 1_000_000,
            durationUs: 3_000_000,
            box: { x: 0.1, y: 0.1, width: 0.8, height: 0.25 },
          },
        ],
      },
      {
        id: 'music',
        type: 'audio',
        volume: 0.6,
        clips: [
          {
            type: 'audio',
            source: new ArrayBuffer(8),
            startUs: 0,
            durationUs: 10_000_000,
            fadeInUs: 50_000,
            fadeOutUs: 50_000,
          },
        ],
      },
    ],
  };
}

describe('validateProject', () => {
  it('accepts a normal mixed-media project', () => {
    const result = validateProject(validProject());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(validatedProjectDurationUs(validProject())).toBe(10_000_000);
  });

  it('does not impose a 4K or five-minute ceiling', () => {
    const project = validProject();
    project.output.width = 7680;
    project.output.height = 4320;
    const firstTrack = project.tracks[0];
    if (firstTrack?.type !== 'visual') {
      throw new Error('fixture is missing its visual track');
    }
    const firstClip = firstTrack.clips[0];
    if (firstClip === undefined) {
      throw new Error('fixture is missing its first clip');
    }
    firstClip.durationUs = 600_000_000;

    expect(validateProject(project).valid).toBe(true);
  });

  it('requires positive even dimensions and fps in the supported range', () => {
    const project = validProject();
    project.output.width = 1921;
    project.output.height = 0;
    project.output.frameRate = 61;

    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['INVALID_DIMENSION', 'INVALID_FRAME_RATE']),
    );
  });

  it('reports timeline, source, layout, and transition problems together', () => {
    const project = validProject();
    const track = project.tracks[0];
    if (track?.type !== 'visual') {
      throw new Error('fixture is missing its visual track');
    }
    const clip = track.clips[0];
    if (clip?.type !== 'video') {
      throw new Error('fixture is missing its first video clip');
    }
    clip.source = '';
    clip.startUs = -1;
    clip.durationUs = 1_000;
    clip.box = { x: 0.75, y: 0, width: 0.5, height: 1 };
    clip.transitionIn = { type: 'wipe', durationUs: 2_000 };

    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'INVALID_DURATION',
        'INVALID_SOURCE',
        'INVALID_LAYOUT',
        'INVALID_TRANSITION',
      ]),
    );
  });

  it('detects duplicate ids and output clipping', () => {
    const project = validProject();
    project.output.durationUs = 5_000_000;
    const audioTrack = project.tracks[1];
    if (audioTrack?.type !== 'audio' || audioTrack.clips[0] === undefined) {
      throw new Error('fixture is missing its audio track');
    }
    audioTrack.clips[0].id = 'hero';

    const result = validateProject(project);
    expect(result.errors.some(({ code }) => code === 'DUPLICATE_ID')).toBe(true);
    expect(result.warnings.some(({ code }) => code === 'CLIPPED_BY_OUTPUT')).toBe(true);
  });

  it('throws a structured library error from assertValidProject', () => {
    const project = validProject();
    project.output.width = 1;

    expect(() => assertValidProject(project)).toThrowError(VideoAdsError);
    try {
      assertValidProject(project);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PROJECT' });
    }
  });
});

describe('source and support profile validation', () => {
  it('accepts native and described browser sources', () => {
    expect(isValidMediaSource('/template.mp4')).toBe(true);
    expect(isValidMediaSource(new ArrayBuffer(1))).toBe(true);
    expect(isValidMediaSource({ type: 'url', url: 'https://example.test/a.webm' })).toBe(true);
    expect(isValidMediaSource({ type: 'buffer', data: new Uint8Array(1), mimeType: 'video/mp4' })).toBe(
      true,
    );
    expect(isValidMediaSource('')).toBe(false);
    expect(isValidMediaSource({ type: 'url', url: '' })).toBe(false);
  });

  it('validates profile dimensions as a pair without capping their size', () => {
    expect(validateSupportProfile({ width: 7680, height: 4320, frameRate: 60 }).valid).toBe(true);
    expect(validateSupportProfile({ width: 1920 }).valid).toBe(false);
    expect(validateSupportProfile({ width: 1920, height: 1080, frameRate: 0.5 }).valid).toBe(false);
  });
});
