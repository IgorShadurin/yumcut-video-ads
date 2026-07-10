import { describe, expect, it } from 'vitest';
import { outputEncodingProfile } from '../../src/encoding-profile.js';

describe('output encoding profiles', () => {
  it('selects codec levels from actual dimensions and target bitrate', () => {
    const mp4 = outputEncodingProfile('mp4', 640, 360, 30);
    const webm = outputEncodingProfile('webm', 3840, 2160, 30);

    expect(mp4).toMatchObject({
      video: 'avc',
      videoCodec: 'avc1.640016',
      audio: 'aac',
      audioCodec: 'mp4a.40.2',
    });
    expect(webm).toMatchObject({
      video: 'vp9',
      videoCodec: 'vp09.00.50.08',
      audio: 'opus',
      audioCodec: 'opus',
    });
  });

  it('uses explicit render bitrates in codec-level selection', () => {
    const profile = outputEncodingProfile('mp4', 1920, 1080, 30, 'balanced', 60_000_000);
    expect(profile.videoBitrate).toBe(60_000_000);
    expect(profile.videoCodec).toBe('avc1.640032');
  });
});
