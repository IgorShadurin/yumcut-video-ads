import type { OutputFormat } from './types';

const AVC_LEVELS = [
  { maxMacroblocks: 99, maxBitrate: 64_000, level: 0x0a },
  { maxMacroblocks: 396, maxBitrate: 192_000, level: 0x0b },
  { maxMacroblocks: 396, maxBitrate: 384_000, level: 0x0c },
  { maxMacroblocks: 396, maxBitrate: 768_000, level: 0x0d },
  { maxMacroblocks: 396, maxBitrate: 2_000_000, level: 0x14 },
  { maxMacroblocks: 792, maxBitrate: 4_000_000, level: 0x15 },
  { maxMacroblocks: 1620, maxBitrate: 4_000_000, level: 0x16 },
  { maxMacroblocks: 1620, maxBitrate: 10_000_000, level: 0x1e },
  { maxMacroblocks: 3600, maxBitrate: 14_000_000, level: 0x1f },
  { maxMacroblocks: 5120, maxBitrate: 20_000_000, level: 0x20 },
  { maxMacroblocks: 8192, maxBitrate: 20_000_000, level: 0x28 },
  { maxMacroblocks: 8192, maxBitrate: 50_000_000, level: 0x29 },
  { maxMacroblocks: 8704, maxBitrate: 50_000_000, level: 0x2a },
  { maxMacroblocks: 22_080, maxBitrate: 135_000_000, level: 0x32 },
  { maxMacroblocks: 36_864, maxBitrate: 240_000_000, level: 0x33 },
  { maxMacroblocks: 36_864, maxBitrate: 240_000_000, level: 0x34 },
  { maxMacroblocks: 139_264, maxBitrate: 240_000_000, level: 0x3c },
  { maxMacroblocks: 139_264, maxBitrate: 480_000_000, level: 0x3d },
  { maxMacroblocks: 139_264, maxBitrate: 800_000_000, level: 0x3e },
] as const;

const VP9_LEVELS = [
  { maxPictureSize: 36_864, maxBitrate: 200_000, level: 10 },
  { maxPictureSize: 73_728, maxBitrate: 800_000, level: 11 },
  { maxPictureSize: 122_880, maxBitrate: 1_800_000, level: 20 },
  { maxPictureSize: 245_760, maxBitrate: 3_600_000, level: 21 },
  { maxPictureSize: 552_960, maxBitrate: 7_200_000, level: 30 },
  { maxPictureSize: 983_040, maxBitrate: 12_000_000, level: 31 },
  { maxPictureSize: 2_228_224, maxBitrate: 18_000_000, level: 40 },
  { maxPictureSize: 2_228_224, maxBitrate: 30_000_000, level: 41 },
  { maxPictureSize: 8_912_896, maxBitrate: 60_000_000, level: 50 },
  { maxPictureSize: 8_912_896, maxBitrate: 120_000_000, level: 51 },
  { maxPictureSize: 8_912_896, maxBitrate: 180_000_000, level: 52 },
  { maxPictureSize: 35_651_584, maxBitrate: 180_000_000, level: 60 },
  { maxPictureSize: 35_651_584, maxBitrate: 240_000_000, level: 61 },
  { maxPictureSize: 35_651_584, maxBitrate: 480_000_000, level: 62 },
] as const;

export interface OutputEncodingProfile {
  format: OutputFormat;
  video: 'avc' | 'vp9';
  videoCodec: string;
  audio: 'aac' | 'opus';
  audioCodec: string;
  videoBitrate: number;
}
export function estimateVideoBitrate(
  width: number,
  height: number,
  frameRate: number,
  format: OutputFormat,
  quality: 'balanced' | 'high' = 'balanced',
  explicitBitrate?: number,
): number {
  if (explicitBitrate !== undefined) return explicitBitrate;
  const high = quality === 'high';
  const bitsPerPixel = format === 'webm' ? (high ? 0.1 : 0.07) : (high ? 0.15 : 0.1);
  return Math.round(Math.min(
    80_000_000,
    Math.max(500_000, width * height * frameRate * bitsPerPixel),
  ));
}

export function outputEncodingProfile(
  format: OutputFormat,
  width: number,
  height: number,
  frameRate: number,
  quality: 'balanced' | 'high' = 'balanced',
  explicitBitrate?: number,
): OutputEncodingProfile {
  const videoBitrate = estimateVideoBitrate(
    width,
    height,
    frameRate,
    format,
    quality,
    explicitBitrate,
  );
  if (format === 'mp4') {
    const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    const selected = AVC_LEVELS.find((entry) =>
      macroblocks <= entry.maxMacroblocks && videoBitrate <= entry.maxBitrate) ?? AVC_LEVELS.at(-1)!;
    return {
      format,
      video: 'avc',
      videoCodec: `avc1.6400${selected.level.toString(16).padStart(2, '0')}`,
      audio: 'aac',
      audioCodec: 'mp4a.40.2',
      videoBitrate,
    };
  }

  const pictureSize = width * height;
  const selected = VP9_LEVELS.find((entry) =>
    pictureSize <= entry.maxPictureSize && videoBitrate <= entry.maxBitrate) ?? VP9_LEVELS.at(-1)!;
  return {
    format,
    video: 'vp9',
    videoCodec: `vp09.00.${selected.level.toString().padStart(2, '0')}.08`,
    audio: 'opus',
    audioCodec: 'opus',
    videoBitrate,
  };
}
