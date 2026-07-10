import { AudioSample, AudioSampleSink, type InputAudioTrack } from 'mediabunny';
import type { AudioClip, VideoClip } from './types';

export const OUTPUT_AUDIO_SAMPLE_RATE = 48_000;
export const OUTPUT_AUDIO_CHANNELS = 2;
export const DEFAULT_AUDIO_CHUNK_FRAMES = 1_024;

export type AudibleClip = AudioClip | VideoClip;

export interface AudioReaderOptions {
  clip: AudibleClip;
  track: InputAudioTrack;
  sourceDurationUs: number;
  sourceOriginUs?: number;
  trackVolume?: number;
}

interface DecodedSample {
  sample: AudioSample;
  planes: Float32Array[];
  startSeconds: number;
  endSeconds: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** A continuous, stateless ceiling that cannot pump at chunk boundaries. */
const softLimit = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude <= 0.98) return value;
  const limited = 0.98 + 0.02 * (1 - Math.exp(-(magnitude - 0.98) / 0.02));
  return Math.sign(value) * Math.min(1, limited);
};

const frameAtOrAfter = (timeUs: number, sampleRate: number): number =>
  Math.ceil((timeUs * sampleRate) / 1_000_000 - Number.EPSILON);

const frameBefore = (timeUs: number, sampleRate: number): number =>
  Math.ceil((timeUs * sampleRate) / 1_000_000 - Number.EPSILON);

export class AudioClipReader {
  readonly clip: AudibleClip;
  readonly sourceDurationUs: number;
  readonly sink: AudioSampleSink;
  readonly baseVolume: number;
  readonly sourceOriginUs: number;
  private decoded: DecodedSample | undefined;
  private iterator: AsyncGenerator<AudioSample, void, unknown> | undefined;
  private lastRequestedSeconds: number | undefined;

  constructor(options: AudioReaderOptions) {
    this.clip = options.clip;
    this.sourceDurationUs = options.sourceDurationUs;
    this.sourceOriginUs = options.sourceOriginUs ?? 0;
    this.sink = new AudioSampleSink(options.track);
    this.baseVolume = (options.trackVolume ?? 1) * (options.clip.volume ?? 1);
  }

  async mixInto(
    left: Float32Array,
    right: Float32Array,
    outputStartFrame: number,
    outputSampleRate = OUTPUT_AUDIO_SAMPLE_RATE,
  ): Promise<void> {
    if (this.clip.muted === true || this.baseVolume === 0) return;

    const clipStartFrame = frameAtOrAfter(this.clip.startUs, outputSampleRate);
    const clipEndFrame = frameBefore(this.clip.startUs + this.clip.durationUs, outputSampleRate);
    const mixStart = Math.max(outputStartFrame, clipStartFrame);
    const mixEnd = Math.min(outputStartFrame + left.length, clipEndFrame);
    if (mixEnd <= mixStart) return;

    let outputFrame = mixStart;
    while (outputFrame < mixEnd) {
      const sourceSeconds = this.sourceSecondsForOutputFrame(outputFrame, outputSampleRate);
      if (sourceSeconds === null) break;
      const decoded = await this.ensureDecoded(sourceSeconds);
      if (!decoded || sourceSeconds < decoded.startSeconds || sourceSeconds >= decoded.endSeconds) {
        outputFrame += 1;
        continue;
      }

      const sourceFramesRemaining = Math.max(
        1,
        Math.floor((decoded.endSeconds - sourceSeconds) * outputSampleRate),
      );
      const framesToMix = Math.min(mixEnd - outputFrame, sourceFramesRemaining);
      const outputOffset = outputFrame - outputStartFrame;

      for (let index = 0; index < framesToMix; index += 1) {
        const absoluteOutputFrame = outputFrame + index;
        const timeSeconds = this.sourceSecondsForOutputFrame(absoluteOutputFrame, outputSampleRate);
        if (timeSeconds === null || timeSeconds < decoded.startSeconds || timeSeconds >= decoded.endSeconds) {
          break;
        }
        const sourcePosition = (timeSeconds - decoded.startSeconds) * decoded.sample.sampleRate;
        const sourceIndex = clamp(Math.floor(sourcePosition), 0, decoded.sample.numberOfFrames - 1);
        const fraction = clamp(sourcePosition - sourceIndex, 0, 1);
        const nextIndex = Math.min(sourceIndex + 1, decoded.sample.numberOfFrames - 1);
        const [sampleLeft, sampleRight] = stereoAt(decoded.planes, sourceIndex, nextIndex, fraction);
        const volume = this.volumeAtOutputFrame(absoluteOutputFrame, outputSampleRate);
        left[outputOffset + index] = (left[outputOffset + index] ?? 0) + sampleLeft * volume;
        right[outputOffset + index] = (right[outputOffset + index] ?? 0) + sampleRight * volume;
      }
      outputFrame += framesToMix;
    }
  }

  dispose(): void {
    this.decoded?.sample.close();
    this.decoded = undefined;
    void this.iterator?.return(undefined);
    this.iterator = undefined;
  }

  private sourceSecondsForOutputFrame(outputFrame: number, outputSampleRate: number): number | null {
    const outputUs = (outputFrame * 1_000_000) / outputSampleRate;
    const elapsedUs = outputUs - this.clip.startUs;
    if (elapsedUs < 0 || elapsedUs >= this.clip.durationUs) return null;

    const trimStartUs = this.clip.trimStartUs ?? 0;
    if (this.clip.loop !== true) {
      const relativeUs = trimStartUs + elapsedUs;
      if (relativeUs >= this.sourceDurationUs) return null;
      return (this.sourceOriginUs + relativeUs) / 1_000_000;
    }
    const loopDurationUs = this.sourceDurationUs - trimStartUs;
    if (loopDurationUs <= 0) return null;
    return (this.sourceOriginUs + trimStartUs + (elapsedUs % loopDurationUs)) / 1_000_000;
  }

  private volumeAtOutputFrame(outputFrame: number, outputSampleRate: number): number {
    const outputUs = (outputFrame * 1_000_000) / outputSampleRate;
    const elapsedUs = outputUs - this.clip.startUs;
    const remainingUs = this.clip.startUs + this.clip.durationUs - outputUs;
    const fadeIn = this.clip.fadeInUs && this.clip.fadeInUs > 0
      ? clamp(elapsedUs / this.clip.fadeInUs, 0, 1)
      : 1;
    const fadeOut = this.clip.fadeOutUs && this.clip.fadeOutUs > 0
      ? clamp(remainingUs / this.clip.fadeOutUs, 0, 1)
      : 1;
    return this.baseVolume * Math.min(fadeIn, fadeOut);
  }

  private async ensureDecoded(sourceSeconds: number): Promise<DecodedSample | null> {
    const current = this.decoded;
    if (current && sourceSeconds >= current.startSeconds && sourceSeconds < current.endSeconds) {
      this.lastRequestedSeconds = sourceSeconds;
      return current;
    }

    // Source time is monotonic during a normal clip. Keep one sequential sink
    // iterator so each packet is decoded once; only restart it when a loop wraps
    // or the caller explicitly seeks backwards.
    const movedBackwards = this.lastRequestedSeconds !== undefined &&
      sourceSeconds + 1e-7 < this.lastRequestedSeconds;
    this.lastRequestedSeconds = sourceSeconds;
    if (!this.iterator || movedBackwards) {
      await this.iterator?.return(undefined);
      current?.sample.close();
      this.decoded = undefined;
      const sourceEndSeconds = (this.sourceOriginUs + this.sourceDurationUs) / 1_000_000;
      this.iterator = this.sink.samples(sourceSeconds, sourceEndSeconds);
    }

    while (this.iterator) {
      const buffered = this.decoded;
      if (buffered && sourceSeconds < buffered.startSeconds) return null;
      if (buffered && sourceSeconds < buffered.endSeconds) return buffered;

      const next = await this.iterator.next();
      if (next.done) {
        buffered?.sample.close();
        this.decoded = undefined;
        return null;
      }
      buffered?.sample.close();
      const sample = next.value;
      const planes: Float32Array[] = [];
      for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        planes.push(plane);
      }
      this.decoded = {
        sample,
        planes,
        startSeconds: sample.timestamp,
        endSeconds: sample.timestamp + sample.duration,
      };
    }
    return null;
  }
}

function interpolate(plane: Float32Array | undefined, a: number, b: number, fraction: number): number {
  if (!plane) return 0;
  const first = plane[a] ?? 0;
  const second = plane[b] ?? first;
  return first + (second - first) * fraction;
}

function stereoAt(
  planes: readonly Float32Array[],
  sourceIndex: number,
  nextIndex: number,
  fraction: number,
): [number, number] {
  if (planes.length === 0) return [0, 0];
  if (planes.length === 1) {
    const mono = interpolate(planes[0], sourceIndex, nextIndex, fraction);
    return [mono, mono];
  }

  let left = interpolate(planes[0], sourceIndex, nextIndex, fraction);
  let right = interpolate(planes[1], sourceIndex, nextIndex, fraction);
  if (planes.length > 2) {
    const center = interpolate(planes[2], sourceIndex, nextIndex, fraction);
    if (planes.length !== 4) {
      left += center * Math.SQRT1_2;
      right += center * Math.SQRT1_2;
    }
  }
  if (planes.length === 4) {
    left += interpolate(planes[2], sourceIndex, nextIndex, fraction) * 0.5;
    right += interpolate(planes[3], sourceIndex, nextIndex, fraction) * 0.5;
  } else if (planes.length === 5) {
    left += interpolate(planes[3], sourceIndex, nextIndex, fraction) * 0.5;
    right += interpolate(planes[4], sourceIndex, nextIndex, fraction) * 0.5;
  } else if (planes.length >= 6) {
    // Common 5.1 order: L, R, C, LFE, surround-L, surround-R. LFE is
    // intentionally omitted from the stereo downmix to avoid overload.
    left += interpolate(planes[4], sourceIndex, nextIndex, fraction) * 0.5;
    right += interpolate(planes[5], sourceIndex, nextIndex, fraction) * 0.5;
  }
  return [left, right];
}

export async function mixAudioChunk(
  readers: readonly AudioClipReader[],
  outputStartFrame: number,
  frameCount: number,
): Promise<AudioSample> {
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  await Promise.all(readers.map((reader) => reader.mixInto(left, right, outputStartFrame)));

  const planar = new Float32Array(frameCount * 2);
  for (let index = 0; index < frameCount; index += 1) {
    planar[index] = softLimit(left[index] ?? 0);
    planar[frameCount + index] = softLimit(right[index] ?? 0);
  }

  return new AudioSample({
    data: planar,
    format: 'f32-planar',
    numberOfChannels: OUTPUT_AUDIO_CHANNELS,
    sampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
    timestamp: outputStartFrame / OUTPUT_AUDIO_SAMPLE_RATE,
  });
}

export const __private__ = { softLimit, stereoAt };
