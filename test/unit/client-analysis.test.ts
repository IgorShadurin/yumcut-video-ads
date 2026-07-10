import { describe, expect, it } from 'vitest';
import { __private__ } from '../../src/client.js';
import type { MediaInfo, Project } from '../../src/types.js';

const videoInfo = (overrides: Partial<MediaInfo> = {}): MediaInfo => ({
  durationUs: 5_000_000,
  hasAudio: true,
  hasVideo: true,
  videoCodec: 'avc1.42001f',
  audioCodec: 'mp4a.40.2',
  videoDecodable: true,
  audioDecodable: true,
  tracks: [
    { type: 'video', codec: 'avc1.42001f', decodable: true },
    { type: 'audio', codec: 'mp4a.40.2', decodable: true },
  ],
  ...overrides,
});

describe('project media analysis', () => {
  it('does not schedule fetches for hidden, muted, or out-of-range sources', () => {
    const activeVideo = new Blob(['active']);
    const project: Project = {
      output: { width: 640, height: 360, durationUs: 5_000_000 },
      tracks: [
        {
          type: 'visual',
          visible: false,
          clips: [{ type: 'video', source: '/hidden.mp4', startUs: 0, durationUs: 5_000_000 }],
        },
        {
          type: 'visual',
          clips: [
            { type: 'video', source: activeVideo, startUs: 0, durationUs: 5_000_000, muted: true },
            { type: 'image', source: '/future.jpg', startUs: 6_000_000, durationUs: 1_000_000 },
          ],
        },
        {
          type: 'audio',
          muted: true,
          clips: [{ type: 'audio', source: '/muted.mp3', startUs: 0, durationUs: 5_000_000 }],
        },
      ],
    };

    expect(__private__.collectSources(project)).toEqual([activeVideo]);
  });

  it('keeps request-header variants as distinct active sources', () => {
    const first = { type: 'url' as const, url: 'https://cdn.test/video.mp4', headers: { Authorization: 'A' } };
    const second = { type: 'url' as const, url: 'https://cdn.test/video.mp4', headers: { Authorization: 'B' } };
    const project: Project = {
      output: { width: 640, height: 360 },
      tracks: [{
        type: 'visual',
        clips: [
          { type: 'video', source: first, startUs: 0, durationUs: 5_000_000 },
          { type: 'video', source: second, startUs: 0, durationUs: 5_000_000 },
        ],
      }],
    };

    expect(__private__.collectSources(project)).toEqual([first, second]);
  });

  it('infers audio only from audible, active sources that actually contain audio', () => {
    const hidden = new Blob(['hidden']);
    const muted = new Blob(['muted']);
    const silent = new Blob(['silent']);
    const project: Project = {
      output: { width: 640, height: 360, durationUs: 5_000_000 },
      tracks: [
        {
          type: 'visual',
          visible: false,
          clips: [{ type: 'video', source: hidden, startUs: 0, durationUs: 5_000_000 }],
        },
        {
          type: 'visual',
          clips: [{
            type: 'video',
            source: muted,
            startUs: 0,
            durationUs: 5_000_000,
            muted: true,
          }],
        },
        {
          type: 'audio',
          clips: [{ type: 'audio', source: silent, startUs: 0, durationUs: 5_000_000 }],
        },
      ],
    };
    const assessment = __private__.assessActiveMedia(
      project,
      [hidden, muted, silent],
      [videoInfo({ audioDecodable: false }), videoInfo({ audioDecodable: false }), {
        durationUs: 5_000_000,
        hasAudio: false,
        hasVideo: true,
        videoCodec: 'avc1.42001f',
        videoDecodable: true,
        tracks: [{ type: 'video', codec: 'avc1.42001f', decodable: true }],
      }],
    );

    expect(assessment.includeAudio).toBe(false);
    expect(assessment.blockers).toEqual(['An active audio clip does not contain an audio track.']);
  });

  it('reports unsupported codecs only when their tracks are required by active clips', () => {
    const source = new Blob(['media']);
    const project: Project = {
      output: { width: 640, height: 360, durationUs: 5_000_000 },
      tracks: [{
        type: 'visual',
        clips: [{ type: 'video', source, startUs: 0, durationUs: 5_000_000 }],
      }],
    };
    const assessment = __private__.assessActiveMedia(project, [source], [videoInfo({
      videoCodec: 'unsupported-video',
      audioCodec: 'unsupported-audio',
      videoDecodable: false,
      audioDecodable: false,
      tracks: [
        { type: 'video', codec: 'unsupported-video', decodable: false },
        { type: 'audio', codec: 'unsupported-audio', decodable: false },
      ],
    })]);

    expect(assessment.includeAudio).toBe(true);
    expect(assessment.blockers).toEqual(expect.arrayContaining([
      'The browser cannot decode an active unsupported-video video track.',
      'The browser cannot decode an active unsupported-audio audio track.',
    ]));
  });

  it('uses requested quality and bitrate choices in its output estimate', () => {
    const project: Project = {
      output: { width: 1920, height: 1080, frameRate: 30, durationUs: 10_000_000 },
      tracks: [{
        type: 'visual',
        clips: [{
          type: 'text',
          text: 'Estimate',
          style: { fontSize: 24 },
          startUs: 0,
          durationUs: 10_000_000,
        }],
      }],
    };

    const balanced = __private__.estimatedBytes(project, 'mp4', false);
    const high = __private__.estimatedBytes(project, 'mp4', false, { quality: 'high' });
    const explicit = __private__.estimatedBytes(project, 'webm', true, {
      videoBitrate: 1_000_000,
      audioBitrate: 100_000,
    });

    expect(high).toBeGreaterThan(balanced);
    expect(explicit).toBe(Math.ceil(((1_000_000 + 100_000) * 10) / 8 * 1.05));
  });

  it('requires origin storage only for large automatic outputs', () => {
    expect(__private__.autoOutputNeedsOriginStorage('auto', 32 * 1024 * 1024)).toBe(false);
    expect(__private__.autoOutputNeedsOriginStorage(undefined, 32 * 1024 * 1024 + 1)).toBe(true);
    expect(__private__.autoOutputNeedsOriginStorage('blob', 500 * 1024 * 1024)).toBe(false);
    expect(__private__.autoOutputNeedsOriginStorage(
      { type: 'writable', writable: new WritableStream<Uint8Array>() },
      500 * 1024 * 1024,
    )).toBe(false);
  });
});
