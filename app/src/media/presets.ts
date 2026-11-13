export type PresetName = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

export interface VideoFormat {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

export const PRESETS: Record<Exclude<PresetName, 'custom'>, VideoFormat & { label: string }> = {
  low: { label: 'Low', width: 1280, height: 720, fps: 30, bitrateKbps: 3000 },
  medium: { label: 'Medium', width: 1920, height: 1080, fps: 60, bitrateKbps: 10000 },
  high: { label: 'High', width: 2560, height: 1440, fps: 60, bitrateKbps: 20000 },
  ultra: { label: 'Ultra', width: 2560, height: 1440, fps: 120, bitrateKbps: 35000 },
};

export const RESOLUTIONS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 },
  { label: '4K', width: 3840, height: 2160 },
] as const;

export const FRAME_RATES = [30, 60, 90, 120] as const;
export const BITRATE_RANGE = { min: 500, max: 80000, step: 500 } as const;

export function resolutionLabel(height: number): string {
  return RESOLUTIONS.find((r) => r.height === height)?.label ?? `${height}p`;
}
