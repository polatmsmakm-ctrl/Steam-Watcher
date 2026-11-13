import { AlertTriangle, Cpu, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { session } from '../session.ts';
import { ALL_CODECS, CODEC_LABEL, probeEncoders, sendableCodecs, type CodecChoice, type CodecName, type EncoderSupport } from '../media/codecs.ts';
import { BITRATE_RANGE, FRAME_RATES, PRESETS, RESOLUTIONS, type PresetName } from '../media/presets.ts';
import { toast, useApp } from '../store.ts';
import { Field, fmt, Segmented, ToggleRow } from '../ui.tsx';

export function StreamSettingsView() {
  const stream = useApp((s) => s.settings.stream);
  const update = useApp((s) => s.updateSettings);
  const sharing = useApp((s) => Boolean(s.localScreen));
  const roomMode = useApp((s) => s.room?.info.mode);
  const send = useApp((s) => s.latest?.send);
  const [support, setSupport] = useState<Record<CodecName, EncoderSupport> | null>(null);
  const sendable = sendableCodecs();
  const set = (patch: Partial<typeof stream>) => update({ stream: patch });

  useEffect(() => {
    let live = true;
    void probeEncoders(stream.width, stream.height, stream.fps).then((r) => live && setSupport(r));
    return () => void (live = false);
  }, [stream.width, stream.height, stream.fps]);

  // Push changes into a running share (debounced so dragging the bitrate slider is smooth).
  const first = useRef(true);
  const key = JSON.stringify(stream);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (!sharing) return;
    const timer = setTimeout(() => {
      session.applyStreamSettings().catch((e: Error) => toast('error', `Could not apply settings: ${e.message}`));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setPreset = (preset: PresetName) => {
    if (preset === 'custom') return set({ preset });
    const p = PRESETS[preset];
    set({ preset, width: p.width, height: p.height, fps: p.fps, bitrateKbps: p.bitrateKbps });
  };
  const custom = (patch: Partial<typeof stream>) => set({ ...patch, preset: 'custom' });
  const anyHardware = support && ALL_CODECS.some((c) => support[c] === 'hardware');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Stream settings</h1>
          <p>{sharing ? 'Changes apply to your live stream immediately.' : 'These settings are used the next time you share your screen.'}</p>
        </div>
        {sharing && send && <span className="chip good mono">Live: {send.width}×{send.height} · {fmt(send.fps)} FPS · {fmt(send.bitrateKbps / 1000, 1)} Mbps</span>}
      </div>
      <div className="stack">
        <div className="card stack">
          <div>
            <h2>Quality preset</h2>
            <p className="muted small">Targets, not guarantees — the Performance screen shows what your hardware and network actually deliver.</p>
          </div>
          <Segmented<PresetName> label="Quality preset" value={stream.preset} onChange={setPreset}
            options={[
              { value: 'low', label: 'Low · 720p30' }, { value: 'medium', label: 'Medium · 1080p60' }, { value: 'high', label: 'High · 1440p60' },
              { value: 'ultra', label: 'Ultra · 1440p120' }, { value: 'custom', label: 'Custom' },
            ]} />
          <div className="grid cols-3">
            <Field label="Resolution">
              <select className="select" value={stream.height} aria-label="Resolution" onChange={(e) => {
                const r = RESOLUTIONS.find((x) => x.height === Number(e.target.value))!;
                custom({ width: r.width, height: r.height });
              }}>
                {RESOLUTIONS.map((r) => <option key={r.height} value={r.height}>{r.label} ({r.width}×{r.height})</option>)}
              </select>
            </Field>
            <Field label="Frame rate">
              <select className="select" value={stream.fps} aria-label="Frame rate" onChange={(e) => custom({ fps: Number(e.target.value) })}>
                {FRAME_RATES.map((f) => <option key={f} value={f}>{f} FPS</option>)}
              </select>
            </Field>
            <Field label={`Bitrate — ${(stream.bitrateKbps / 1000).toFixed(1)} Mbps`}>
              <input type="range" aria-label="Bitrate" min={BITRATE_RANGE.min} max={BITRATE_RANGE.max} step={BITRATE_RANGE.step} value={stream.bitrateKbps}
                onChange={(e) => custom({ bitrateKbps: Number(e.target.value) })} style={{ marginTop: 16 }} />
            </Field>
          </div>
          {stream.fps > 60 && (
            <div className="notice"><AlertTriangle />
              <span>{stream.fps} FPS needs a display running at {stream.fps} Hz or more, a hardware encoder, and viewers whose PCs can decode it. If any link is slower, the app reports the lower real frame rate instead of the target.</span>
            </div>
          )}
        </div>

        <div className="card stack">
          <div>
            <h2>Video encoder</h2>
            <p className="muted small">Auto picks the best codec with a hardware encoder on this PC (AV1 → HEVC → H.264), and falls back to software only when it must.</p>
          </div>
          <Field label="Encoder">
            <select className="select" aria-label="Encoder" value={stream.codec} onChange={(e) => set({ codec: e.target.value as CodecChoice })}>
              <option value="auto">Auto</option>
              {ALL_CODECS.map((c) => (
                <option key={c} value={c} disabled={!sendable.includes(c)}>
                  {CODEC_LABEL[c]}{!sendable.includes(c) ? ' — not available on this device' : support?.[c] === 'hardware' ? ' — hardware' : ' — software'}
                </option>
              ))}
            </select>
          </Field>
          <table className="table" data-testid="encoder-table">
            <thead><tr><th>Codec</th><th>WebRTC send</th><th>Encoder at {stream.width}×{stream.height}@{stream.fps}</th></tr></thead>
            <tbody>
              {ALL_CODECS.map((c) => (
                <tr key={c}>
                  <td>{CODEC_LABEL[c]}</td>
                  <td>{sendable.includes(c) ? <span className="chip good">Available</span> : <span className="chip">Unavailable</span>}</td>
                  <td>
                    {!support ? '…' : support[c] === 'hardware' ? <span className="chip good"><Cpu /> Hardware (GPU)</span>
                      : support[c] === 'software' ? <span className="chip warn">Software (CPU) only</span> : <span className="chip">Not supported</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {support && !anyHardware && (
            <div className="notice"><AlertTriangle />
              <span>No hardware video encoder was detected on this device. Encoding will run on the CPU, which usually cannot sustain 1440p at high frame rates. On an NVIDIA GPU, update the driver and make sure hardware acceleration is enabled.</span>
            </div>
          )}
          {(stream.codec === 'hevc' && roomMode !== 'p2p') && (
            <div className="notice info"><Info /><span>HEVC is only available in Direct (1:1) rooms — the group media server routes AV1, H.264, VP9 and VP8.</span></div>
          )}
          {sharing && send && (
            <div className="kv">
              <span>Active encoder</span><b className="mono">{send.codec} · {send.encoder || 'unknown'}</b>
              <span>Hardware accelerated</span><b>{send.hardware === true ? 'Yes' : send.hardware === false ? 'No (software)' : 'Not reported'}</b>
              <span>Encode time</span><b className="mono">{fmt(send.encodeMs, 2)} ms / frame</b>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Network adaptation</h2>
          <p>How the stream reacts when bandwidth or encoder capacity runs short</p>
          <Field label="When constrained">
            <Segmented<RTCDegradationPreference> label="Degradation preference" value={stream.degradation} onChange={(degradation) => set({ degradation })}
              options={[
                { value: 'maintain-framerate', label: 'Keep frame rate (dynamic resolution)' },
                { value: 'maintain-resolution', label: 'Keep resolution' },
                { value: 'balanced', label: 'Balanced' },
              ]} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <ToggleRow title="Optimise for motion" hint="On: games and video stay fluid. Off: text and fine detail stay sharp." on={stream.contentHint === 'motion'} onChange={(on) => set({ contentHint: on ? 'motion' : 'detail' })} />
            <ToggleRow title="Low-bandwidth layer for slow viewers" hint="Group rooms with H.264 or VP8: also sends a half-resolution 30 FPS layer (+20% upload) that the server gives to viewers who cannot keep up."
              on={stream.simulcast} onChange={(simulcast) => set({ simulcast })} />
            <ToggleRow title="Share system audio" hint="Applies the next time you start sharing" on={stream.systemAudio} onChange={(systemAudio) => set({ systemAudio })} />
          </div>
        </div>
      </div>
    </div>
  );
}
