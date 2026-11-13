import { ALL_CODECS, CODEC_LABEL, webCodecsString, type CodecName } from './codecs.ts';

export interface BenchmarkResult {
  codec: CodecName;
  label: string;
  mode: 'hardware' | 'software';
  supported: boolean;
  /** Frames the encoder completed per second of wall-clock time. */
  fps: number;
  /** Mean submit->output time per frame, including time spent queued behind earlier frames. */
  avgEncodeMs: number;
  p95EncodeMs: number;
  bitrateKbps: number;
  frames: number;
  /** Whether the measured throughput meets the requested frame rate. */
  sustainsTarget: boolean;
  error?: string;
}

export interface BenchmarkOptions {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  seconds: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Real encoder benchmark on this machine: renders moving content to a canvas
 * and pushes it through the platform encoders with WebCodecs (the same
 * NVENC / Media Foundation / software encoders WebRTC uses). Frames are fed as
 * fast as the encoder accepts them, so `fps` is the true throughput ceiling.
 */
export async function runEncoderBenchmark(o: BenchmarkOptions): Promise<BenchmarkResult[]> {
  if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available in this runtime');
  const results: BenchmarkResult[] = [];
  const jobs = ALL_CODECS.flatMap((codec) => (['hardware', 'software'] as const).map((mode) => ({ codec, mode })));
  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;

  for (const [i, { codec, mode }] of jobs.entries()) {
    if (o.signal?.aborted) break;
    o.onProgress?.(i, jobs.length);
    const base: BenchmarkResult = {
      codec, mode, label: CODEC_LABEL[codec], supported: false, fps: 0, avgEncodeMs: 0, p95EncodeMs: 0,
      bitrateKbps: 0, frames: 0, sustainsTarget: false,
    };
    const config: VideoEncoderConfig = {
      codec: webCodecsString(codec, o.width, o.height, o.fps),
      width: o.width, height: o.height, framerate: o.fps, bitrate: o.bitrateKbps * 1000,
      latencyMode: 'realtime', hardwareAcceleration: mode === 'hardware' ? 'prefer-hardware' : 'prefer-software',
    };
    try {
      if (!(await VideoEncoder.isConfigSupported(config)).supported) {
        results.push(base);
        continue;
      }
      results.push({ ...base, supported: true, ...(await encodeRun(config, canvas, ctx, o)) });
    } catch (e) {
      results.push({ ...base, error: e instanceof Error ? e.message : String(e) });
    }
  }
  o.onProgress?.(jobs.length, jobs.length);
  return results;
}

async function encodeRun(
  config: VideoEncoderConfig, canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D, o: BenchmarkOptions,
): Promise<Pick<BenchmarkResult, 'fps' | 'avgEncodeMs' | 'p95EncodeMs' | 'bitrateKbps' | 'frames' | 'sustainsTarget'>> {
  const submitted = new Map<number, number>();
  const latencies: number[] = [];
  let bytes = 0;
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const at = submitted.get(chunk.timestamp);
      if (at !== undefined) latencies.push(performance.now() - at);
      submitted.delete(chunk.timestamp);
      bytes += chunk.byteLength;
    },
    error: (e) => (failure = e),
  });
  encoder.configure(config);

  const frameUs = 1_000_000 / o.fps;
  const start = performance.now();
  const deadline = start + o.seconds * 1000;
  let n = 0;
  while (performance.now() < deadline && !failure && !o.signal?.aborted) {
    drawFrame(ctx, o.width, o.height, n);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(n * frameUs) });
    submitted.set(frame.timestamp, performance.now());
    encoder.encode(frame, { keyFrame: n % (o.fps * 2) === 0 });
    frame.close();
    n++;
    // Back-pressure: never queue more than a couple of frames, like a real-time pipeline.
    while (encoder.encodeQueueSize > 2 && !failure) await new Promise((r) => setTimeout(r, 0));
    if (n % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (!failure) await encoder.flush();
  const elapsed = (performance.now() - start) / 1000;
  if (encoder.state !== 'closed') encoder.close();
  if (failure) throw failure;

  latencies.sort((a, b) => a - b);
  const frames = latencies.length;
  const fps = frames / elapsed;
  return {
    frames,
    fps,
    avgEncodeMs: frames ? latencies.reduce((a, b) => a + b, 0) / frames : 0,
    p95EncodeMs: frames ? latencies[Math.min(frames - 1, Math.floor(frames * 0.95))]! : 0,
    bitrateKbps: (bytes * 8) / 1000 / ((frames || 1) / o.fps),
    sustainsTarget: fps >= o.fps * 0.98,
  };
}

/** Moving gradients, shapes and text: enough motion and detail to load the encoder like real content. */
function drawFrame(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, n: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(n * 2) % 360} 60% 20%)`);
  g.addColorStop(1, `hsl(${(n * 2 + 140) % 360} 60% 12%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 48; i++) {
    const x = ((i * 197 + n * (3 + (i % 7))) % (w + 200)) - 100;
    const y = ((i * 131 + n * (2 + (i % 5))) % (h + 200)) - 100;
    ctx.fillStyle = `hsl(${(i * 37 + n) % 360} 80% 60% / 0.8)`;
    ctx.fillRect(x, y, 60 + (i % 5) * 30, 40 + (i % 3) * 30);
  }
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(h / 18)}px sans-serif`;
  ctx.fillText(`VISION STREAM benchmark frame ${n}`, 40 + (n % 200), h / 2);
}
