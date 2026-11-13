export type CodecName = 'av1' | 'hevc' | 'h264' | 'vp9' | 'vp8';
export type CodecChoice = 'auto' | CodecName;

export const CODEC_MIME: Record<CodecName, string> = {
  av1: 'video/AV1', hevc: 'video/H265', h264: 'video/H264', vp9: 'video/VP9', vp8: 'video/VP8',
};
export const CODEC_LABEL: Record<CodecName, string> = {
  av1: 'AV1', hevc: 'HEVC (H.265)', h264: 'H.264 (AVC)', vp9: 'VP9', vp8: 'VP8',
};
export const ALL_CODECS: CodecName[] = ['av1', 'hevc', 'h264', 'vp9', 'vp8'];

export function codecFromMime(mime: string | undefined): CodecName | null {
  const m = mime?.toLowerCase();
  return ALL_CODECS.find((c) => CODEC_MIME[c].toLowerCase() === m) ?? null;
}

/** Codecs this device's WebRTC stack can encode at all (hardware or software). */
export function sendableCodecs(): CodecName[] {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  const mimes = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  return ALL_CODECS.filter((c) => mimes.has(CODEC_MIME[c].toLowerCase()));
}

export type EncoderSupport = 'hardware' | 'software' | 'unsupported';

/** WebCodecs codec strings with a level high enough for the requested pixel rate. */
export function webCodecsString(codec: CodecName, width: number, height: number, fps: number): string {
  const rate = width * height * fps;
  switch (codec) {
    case 'av1': // seq_level_idx: 4.0=08, 5.0=12, 5.1=13, 5.2=14, 6.0=16
      return `av01.0.${rate <= 1920 * 1080 * 30 ? '08' : rate <= 3840 * 2160 * 30 ? '12' : rate <= 3840 * 2160 * 60 ? '13' : '14'}M.08`;
    case 'hevc': // general_level_idc = level * 30
      return `hev1.1.6.L${rate <= 1920 * 1080 * 30 ? 120 : rate <= 3840 * 2160 * 30 ? 150 : rate <= 3840 * 2160 * 60 ? 153 : 156}.B0`;
    case 'h264': // High profile; level 4.0 / 5.1 / 5.2
      return `avc1.6400${rate <= 1920 * 1080 * 30 ? '28' : rate <= 3840 * 2160 * 30 ? '33' : '34'}`;
    case 'vp9':
      return `vp09.00.${rate <= 1920 * 1080 * 30 ? '40' : rate <= 3840 * 2160 * 30 ? '50' : '51'}.08`;
    case 'vp8':
      return 'vp8';
  }
}

/**
 * Asks the platform (via WebCodecs) whether a hardware encoder exists for each
 * codec at the given format. WebRTC uses the same platform encoders, so this
 * is a strong hint — the authoritative answer is the `encoderImplementation`
 * reported in live stats once a stream is running.
 */
export async function probeEncoders(width: number, height: number, fps: number): Promise<Record<CodecName, EncoderSupport>> {
  const out = {} as Record<CodecName, EncoderSupport>;
  for (const codec of ALL_CODECS) {
    out[codec] = 'unsupported';
    if (typeof VideoEncoder === 'undefined') continue;
    const base: VideoEncoderConfig = {
      codec: webCodecsString(codec, width, height, fps), width, height, framerate: fps, bitrate: 20_000_000, latencyMode: 'realtime',
    };
    try {
      if ((await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-hardware' })).supported) out[codec] = 'hardware';
      else if ((await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-software' })).supported) out[codec] = 'software';
    } catch {
      /* unsupported codec string on this platform */
    }
  }
  return out;
}

/**
 * Resolves "Auto": the best codec that has a hardware encoder (AV1 > HEVC >
 * H.264); otherwise the cheapest software codec. Software AV1/HEVC cannot hold
 * high-resolution real-time encodes, so they are last resorts.
 */
export function pickCodec(choice: CodecChoice, usable: CodecName[], support: Record<CodecName, EncoderSupport>): CodecName | null {
  if (choice !== 'auto') return usable.includes(choice) ? choice : null;
  const hw = (['av1', 'hevc', 'h264'] as const).find((c) => usable.includes(c) && support[c] === 'hardware');
  if (hw) return hw;
  return (['h264', 'vp8', 'vp9', 'av1', 'hevc'] as const).find((c) => usable.includes(c)) ?? null;
}
