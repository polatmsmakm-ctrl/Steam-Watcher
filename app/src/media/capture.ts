export type SurfacePreference = 'monitor' | 'window' | 'any';

export interface ScreenCapture {
  video: MediaStreamTrack;
  audio?: MediaStreamTrack;
}

export interface ScreenCaptureOptions {
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  surface: SurfacePreference;
  contentHint: 'motion' | 'detail';
}

/**
 * Opens the system screen picker. This is the only way capture starts: the
 * platform shows its own chooser (screen / window / which monitor) and the
 * user must confirm there, so the app cannot capture silently.
 *
 * On Windows the WebView2/Chromium capturer is backed by Windows Graphics
 * Capture; frames above the requested size are scaled down before encoding.
 */
export async function captureScreen(o: ScreenCaptureOptions): Promise<ScreenCapture> {
  const constraints = {
    video: {
      ...videoConstraints(o.width, o.height, o.fps),
      ...(o.surface === 'any' ? {} : { displaySurface: o.surface }),
      cursor: 'always',
    },
    audio: o.audio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
      : false,
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
    surfaceSwitching: 'include',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions);
  const video = stream.getVideoTracks()[0];
  if (!video) throw new Error('No video track was captured');
  video.contentHint = o.contentHint;
  const audio = stream.getAudioTracks()[0];
  if (audio) audio.contentHint = 'music';
  return { video, audio };
}

export function videoConstraints(width: number, height: number, fps: number): MediaTrackConstraints {
  return {
    width: { ideal: width, max: width },
    height: { ideal: height, max: height },
    frameRate: { ideal: fps, max: fps },
  };
}

export interface MicOptions {
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export async function captureMic(o: MicOptions): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}),
      echoCancellation: o.echoCancellation,
      noiseSuppression: o.noiseSuppression,
      autoGainControl: o.autoGainControl,
      channelCount: 1,
    },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone track');
  track.contentHint = 'speech';
  return track;
}

export function describeSurface(track: MediaStreamTrack): string {
  const s = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  return s.displaySurface === 'monitor' ? 'Entire screen' : s.displaySurface === 'window' ? 'Application window'
    : s.displaySurface === 'browser' ? 'Browser tab' : 'Screen';
}

export function mediaErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') return 'Permission was not granted.';
  if (name === 'NotFoundError') return 'No capture source or device was found.';
  if (name === 'NotReadableError') return 'The device or screen is in use or blocked by the system.';
  if (name === 'OverconstrainedError') return 'The selected device does not support the requested settings.';
  return e instanceof Error ? e.message : String(e);
}
