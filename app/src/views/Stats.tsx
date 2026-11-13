import { Download, Gauge, Info, Unplug } from 'lucide-react';
import { useRef, useState } from 'react';
import { session } from '../session.ts';
import { downloadFile, isTauri } from '../lib/platform.ts';
import { runEncoderBenchmark, type BenchmarkResult } from '../media/benchmark.ts';
import { samplesToCsv, type Sample } from '../media/stats.ts';
import { toast, useApp } from '../store.ts';
import { fmt, fmtMbps, Spark, Stat, useAction } from '../ui.tsx';

const C = { a: '#8b6cff', b: '#4f9dff', good: '#3ecf8e', warn: '#f5a524', bad: '#ef5a6f' };
const series = (history: Sample[], get: (s: Sample) => number | null | undefined): (number | null)[] => history.slice(-120).map((s) => get(s) ?? null);

export function StatsView() {
  const latest = useApp((s) => s.latest);
  const history = useApp((s) => s.history);
  const room = useApp((s) => s.room);
  const target = useApp((s) => s.settings.stream);
  const signal = useApp((s) => s.signal);
  const { send, recv, net, sys, audio } = latest ?? { send: null, recv: null, net: null, sys: null, audio: null };
  const video = send ?? recv;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Performance</h1>
          <p>Measured once per second from the live WebRTC connection{isTauri ? ' and the operating system' : ''}. Nothing here is estimated or simulated.</p>
        </div>
        <ExportButtons />
      </div>
      <div className="stack">
        {!room && <div className="notice info"><Info /><span>Join a room and start (or watch) a stream to see live transport statistics. The encoder benchmark below works at any time.</span></div>}
        {room && !video && <div className="notice info"><Info /><span>You are in “{room.info.name}”, but no screen is being shared yet.</span></div>}

        <div className="grid cols-4">
          <Stat label={send ? 'FPS sent' : 'FPS received'} value={fmt(video?.fps)} sub={send ? `captured ${fmt(send.captureFps)} · target ${target.fps}` : recv ? `${recv.width}×${recv.height}` : ''}>
            <Spark series={[{ data: series(history, (s) => s.send?.captureFps), color: C.b }, { data: series(history, (s) => (s.send ?? s.recv)?.fps), color: C.a }]} />
          </Stat>
          <Stat label="Bitrate" value={fmtMbps(video?.bitrateKbps)} unit="Mbps" sub={send ? `target ${fmtMbps(send.targetKbps)} · limit ${(target.bitrateKbps / 1000).toFixed(1)}` : ''}>
            <Spark series={[{ data: series(history, (s) => (s.send ?? s.recv)?.bitrateKbps), color: C.good }]} />
          </Stat>
          <Stat label="Network latency (RTT)" value={fmt(net?.rttMs)} unit="ms" sub={net ? `${net.protocol.toUpperCase()} · ${net.relayed ? 'TURN relay' : net.remoteCandidate === 'host' ? 'direct to server' : 'direct'}` : ''}>
            <Spark series={[{ data: series(history, (s) => s.net?.rttMs), color: C.warn }]} />
          </Stat>
          <Stat label="Packet loss" value={fmt(send ? send.remoteLossPct : recv?.lossPct, 2)} unit="%" sub={send ? `${send.nack} NACK · ${send.pli} PLI /s` : recv ? `${recv.packetsLost} lost /s` : ''}>
            <Spark series={[{ data: series(history, (s) => (s.send ? s.send.remoteLossPct : s.recv?.lossPct)), color: C.bad }]} />
          </Stat>
        </div>

        <div className="grid cols-4">
          <Stat label={send ? 'Encode time' : 'Decode time'} value={fmt(send ? send.encodeMs : recv?.decodeMs, 2)} unit="ms/frame"
            sub={video ? `budget ${(1000 / (send ? target.fps : Math.max(recv?.fps ?? 60, 1))).toFixed(1)} ms` : ''}>
            <Spark series={[{ data: series(history, (s) => (s.send ? s.send.encodeMs : s.recv?.decodeMs)), color: C.a }]} />
          </Stat>
          <Stat label="Jitter" value={fmt(send ? send.remoteJitterMs : recv?.jitterMs, 1)} unit="ms" sub={recv ? `buffer ${fmt(recv.jitterBufferMs)} ms` : ''}>
            <Spark series={[{ data: series(history, (s) => (s.send ? s.send.remoteJitterMs : s.recv?.jitterMs)), color: C.b }]} />
          </Stat>
          <Stat label="Dropped frames" value={fmt(video?.framesDropped)} unit="/s" sub={recv ? `${recv.freezes} freezes` : send ? `limited by: ${send.limitation}` : ''}>
            <Spark series={[{ data: series(history, (s) => (s.send ?? s.recv)?.framesDropped), color: C.bad }]} />
          </Stat>
          <Stat label="Resolution" value={video && video.width ? `${video.width}×${video.height}` : '—'} sub={send ? `target ${target.width}×${target.height}` : ''} />
        </div>

        <div className="grid cols-4">
          <Stat label="CPU" value={fmt(sys?.cpu)} unit="%" sub={sys ? `${sys.cpuCores} logical cores` : isTauri ? '' : 'desktop app only'}>
            <Spark max={100} series={[{ data: series(history, (s) => s.sys?.cpu), color: C.b }]} />
          </Stat>
          <Stat label="GPU" value={fmt(sys?.gpu?.utilization)} unit="%" sub={sys ? (sys.gpu ? sys.gpu.name : 'No NVIDIA GPU / NVML') : isTauri ? '' : 'desktop app only'}>
            <Spark max={100} series={[{ data: series(history, (s) => s.sys?.gpu?.utilization), color: C.good }]} />
          </Stat>
          <Stat label="GPU encoder (NVENC)" value={fmt(sys?.gpu?.encoderUtilization)} unit="%" sub={sys?.gpu ? `${fmt(sys.gpu.memoryUsedMb)} / ${fmt(sys.gpu.memoryTotalMb)} MB VRAM${sys.gpu.temperatureC !== null ? ` · ${sys.gpu.temperatureC}°C` : ''}` : ''}>
            <Spark max={100} series={[{ data: series(history, (s) => s.sys?.gpu?.encoderUtilization), color: C.a }]} />
          </Stat>
          <Stat label="App memory" value={fmt(sys?.appMemoryMb)} unit="MB" sub={sys ? `system ${fmt(sys.memoryUsedMb / 1024, 1)} / ${fmt(sys.memoryTotalMb / 1024, 1)} GB` : ''}>
            <Spark series={[{ data: series(history, (s) => s.sys?.appMemoryMb), color: C.warn }]} />
          </Stat>
        </div>

        <div className="grid cols-2">
          <div className="card">
            <h2>Stream details</h2>
            <p>Codec and pipeline in use right now</p>
            <div className="kv" data-testid="stream-details">
              <span>Direction</span><b>{send ? 'Sending (you are sharing)' : recv ? 'Receiving' : '—'}</b>
              <span>Codec</span><b className="mono">{video?.codec || '—'}</b>
              <span>{send ? 'Encoder' : 'Decoder'}</span><b className="mono">{(send ? send.encoder : recv?.decoder) || '—'}</b>
              <span>Hardware accelerated</span><b>{video ? (video.hardware === true ? 'Yes' : video.hardware === false ? 'No (software)' : 'Not reported') : '—'}</b>
              {send && <><span>Quality limited by</span><b>{send.limitation}</b><span>Layers sent</span><b>{send.layers}</b></>}
              {recv && <><span>Receive → decoded delay</span><b className="mono">{fmt(recv.processingMs, 1)} ms</b></>}
              {recv && <><span>Audio / video offset</span><b className="mono">{recv.avOffsetMs === null ? 'no stream audio' : `${fmt(recv.avOffsetMs)} ms`}</b></>}
              {audio && <><span>Audio</span><b className="mono">{fmt(audio.bitrateKbps)} kbps · jitter {fmt(audio.jitterMs, 1)} ms · loss {fmt(audio.lossPct, 2)}%</b></>}
            </div>
          </div>
          <div className="card">
            <h2>Connection</h2>
            <p>Signaling and media path</p>
            <div className="kv">
              <span>Server</span><b>{signal === 'online' ? 'Connected' : signal === 'connecting' ? 'Reconnecting…' : 'Offline'}</b>
              <span>Room transport</span><b>{room ? (room.info.mode === 'sfu' ? 'SFU (one upload, server fan-out)' : 'Direct peer-to-peer') : '—'}</b>
              <span>Media path</span><b>{net ? `${net.localCandidate} → ${net.remoteCandidate} over ${net.protocol.toUpperCase()}` : '—'}</b>
              <span>TURN relay</span><b>{net ? (net.relayed ? 'Yes' : 'No') : '—'}</b>
              <span>Upload / download</span><b className="mono">{net ? `${fmtMbps(net.sentKbps)} / ${fmtMbps(net.recvKbps)} Mbps` : '—'}</b>
              <span>Estimated uplink capacity</span><b className="mono">{net?.availableOutKbps ? `${fmtMbps(net.availableOutKbps)} Mbps` : '—'}</b>
              <span>Encryption</span><b>{room ? 'DTLS-SRTP' : '—'}</b>
            </div>
            {room && (
              <button className="btn sm" style={{ marginTop: 14 }} onClick={() => { session.sig.dropConnection(); toast('info', 'Connection dropped on purpose — watch it recover'); }} data-testid="drop-connection">
                <Unplug /> Test reconnection
              </button>
            )}
          </div>
        </div>

        <Benchmark />
      </div>
    </div>
  );
}

function ExportButtons() {
  const inRoom = useApp((s) => Boolean(s.room));
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const guard = (fn: () => void) => () => (session.recording.length ? fn() : toast('info', 'No samples recorded yet — join a room first'));
  return (
    <div className="row">
      <button className="btn sm" disabled={!inRoom && !session.recording.length} onClick={guard(() => downloadFile(`vision-stream-stats-${stamp()}.csv`, 'text/csv', samplesToCsv(session.recording)))}><Download /> CSV</button>
      <button className="btn sm" disabled={!inRoom && !session.recording.length} onClick={guard(() => downloadFile(`vision-stream-stats-${stamp()}.json`, 'application/json', JSON.stringify(session.recording)))}><Download /> JSON</button>
    </div>
  );
}

function Benchmark() {
  const target = useApp((s) => s.settings.stream);
  const [results, setResults] = useState<BenchmarkResult[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, run] = useAction();
  const abort = useRef<AbortController | null>(null);

  const start = () => run(async () => {
    abort.current = new AbortController();
    setResults(null);
    setProgress(0);
    try {
      setResults(await runEncoderBenchmark({
        width: target.width, height: target.height, fps: target.fps, bitrateKbps: target.bitrateKbps, seconds: 3,
        signal: abort.current.signal, onProgress: (done, total) => setProgress(done / total),
      }));
    } finally {
      setProgress(null);
    }
  });

  return (
    <div className="card stack">
      <div className="row spread">
        <div>
          <h2>Encoder benchmark</h2>
          <p className="muted small">Encodes moving test frames at {target.width}×{target.height}, {target.fps} FPS target, {(target.bitrateKbps / 1000).toFixed(1)} Mbps with every encoder on this PC (3 s each) and reports real throughput.</p>
        </div>
        {busy ? <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>
          : <button className="btn primary" onClick={start} data-testid="run-benchmark"><Gauge /> Run benchmark</button>}
      </div>
      {progress !== null && <div className="progress"><i style={{ width: `${progress * 100}%` }} /></div>}
      {results && (
        <table className="table" data-testid="benchmark-results">
          <thead><tr><th>Encoder</th><th>Type</th><th>Throughput</th><th>Encode time (avg / p95)</th><th>Bitrate</th><th>{target.fps} FPS target</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={`${r.codec}-${r.mode}`} style={r.supported ? undefined : { opacity: 0.45 }}>
                <td>{r.label}</td>
                <td>{r.mode === 'hardware' ? 'Hardware (GPU)' : 'Software (CPU)'}</td>
                {r.supported ? (
                  <>
                    <td className="mono">{fmt(r.fps, 1)} FPS</td>
                    <td className="mono">{fmt(r.avgEncodeMs, 2)} / {fmt(r.p95EncodeMs, 2)} ms</td>
                    <td className="mono">{fmtMbps(r.bitrateKbps)} Mbps</td>
                    <td>{r.sustainsTarget ? <span className="chip good">Sustained</span> : <span className="chip bad">Too slow ({fmt((r.fps / target.fps) * 100)}%)</span>}</td>
                  </>
                ) : (
                  <td colSpan={4} className="muted">{r.error ? `Failed: ${r.error}` : 'Not available on this device'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
