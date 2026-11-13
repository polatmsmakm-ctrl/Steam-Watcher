/** Bridges to the Tauri shell. Every function degrades cleanly when running as a plain web page. */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface GpuMetrics {
  name: string;
  /** 0-100 */
  utilization: number;
  /** NVENC encoder load, 0-100 */
  encoderUtilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number | null;
}

export interface SystemMetrics {
  /** Whole-machine CPU load, 0-100 */
  cpu: number;
  cpuCores: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  /** RSS of the app process tree (shell + WebView). */
  appMemoryMb: number;
  /** null when no NVIDIA GPU / NVML is present. */
  gpu: GpuMetrics | null;
}

export async function systemMetrics(): Promise<SystemMetrics | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SystemMetrics>('system_metrics');
}

export async function appVersion(): Promise<string> {
  if (!isTauri) return __APP_VERSION__;
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

export function defaultServerUrl(): string {
  const fromEnv = import.meta.env.VITE_DEFAULT_SERVER as string | undefined;
  if (fromEnv) return fromEnv;
  // Served by the room service itself => same origin. Tauri / vite dev => local server.
  if (!isTauri && !import.meta.env.DEV && location.protocol.startsWith('http')) return location.origin;
  return 'http://localhost:8080';
}

export function downloadFile(name: string, mime: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
