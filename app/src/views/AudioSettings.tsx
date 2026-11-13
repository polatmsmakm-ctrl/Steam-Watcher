import { Mic, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { session } from '../session.ts';
import { captureMic, mediaErrorMessage } from '../media/capture.ts';
import { toast, useApp } from '../store.ts';
import { Field, ToggleRow, useAction } from '../ui.tsx';

export function AudioSettingsView() {
  const audio = useApp((s) => s.settings.audio);
  const update = useApp((s) => s.updateSettings);
  const micActive = useApp((s) => s.mic.active);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState<number | null>(null);
  const [busy, run] = useAction();
  const stopTest = useRef<() => void>(() => {});
  const set = (patch: Partial<typeof audio>) => update({ audio: patch });

  const refresh = async () => setDevices(await navigator.mediaDevices.enumerateDevices());
  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
      stopTest.current();
    };
  }, []);

  // Capture settings changed while in voice: reopen the microphone with them.
  const captureKey = `${audio.micId}|${audio.noiseSuppression}|${audio.echoCancellation}|${audio.autoGainControl}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (micActive) session.restartMic().catch((e: Error) => toast('error', e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureKey]);

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');
  const labelsHidden = mics.length > 0 && mics.every((d) => !d.label);

  const grant = () => run(async () => {
    try {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    } catch (e) {
      throw new Error(`Microphone: ${mediaErrorMessage(e)}`);
    }
    await refresh();
  });

  const testMic = () => run(async () => {
    if (level !== null) return stopTest.current();
    let track: MediaStreamTrack;
    try {
      track = await captureMic({ deviceId: audio.micId, echoCancellation: audio.echoCancellation, noiseSuppression: audio.noiseSuppression, autoGainControl: audio.autoGainControl });
    } catch (e) {
      throw new Error(`Microphone: ${mediaErrorMessage(e)}`);
    }
    await refresh();
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);
      setLevel(Math.min(1, rms * 6));
    }, 60);
    stopTest.current = () => {
      clearInterval(timer);
      track.stop();
      void ctx.close();
      setLevel(null);
      stopTest.current = () => {};
    };
  });

  const testSpeaker = () => run(async () => {
    const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (audio.speakerId) await ctx.setSinkId?.(audio.speakerId);
    const gain = ctx.createGain();
    gain.gain.value = 0.15 * audio.voiceVolume;
    gain.connect(ctx.destination);
    [440, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.22);
    });
    setTimeout(() => void ctx.close(), 900);
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audio settings</h1>
          <p>Voice chat uses the Opus codec with forward error correction.</p>
        </div>
      </div>
      <div className="stack">
        <div className="card stack">
          <h2>Devices</h2>
          <div className="grid cols-2">
            <Field label="Microphone">
              <select className="select" aria-label="Microphone" value={audio.micId} onChange={(e) => set({ micId: e.target.value })}>
                <option value="">System default</option>
                {mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select>
            </Field>
            <Field label="Speakers / headphones">
              <select className="select" aria-label="Speaker" value={audio.speakerId} onChange={(e) => set({ speakerId: e.target.value })}>
                <option value="">System default</option>
                {speakers.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${i + 1}`}</option>)}
              </select>
            </Field>
          </div>
          {labelsHidden && (
            <div className="row"><span className="muted small grow">Device names are hidden until microphone access is granted.</span>
              <button className="btn sm" disabled={busy} onClick={grant}>Allow microphone access</button></div>
          )}
          <div className="row">
            <button className={`btn ${level !== null ? 'on' : ''}`} disabled={busy} onClick={testMic} data-testid="mic-test">{level !== null ? <><Square /> Stop test</> : <><Mic /> Test microphone</>}</button>
            <button className="btn" disabled={busy} onClick={testSpeaker}><Volume2 /> Play test sound</button>
            <div className="grow meter" aria-label="Microphone level"><i style={{ width: `${(level ?? 0) * 100}%` }} /></div>
          </div>
        </div>

        <div className="card">
          <h2>Voice processing</h2>
          <p>Applied to your microphone before it is sent</p>
          <ToggleRow title="Noise suppression" hint="Removes keyboard, fan and background noise" on={audio.noiseSuppression} onChange={(noiseSuppression) => set({ noiseSuppression })} />
          <ToggleRow title="Echo cancellation" hint="Stops friends hearing themselves through your speakers" on={audio.echoCancellation} onChange={(echoCancellation) => set({ echoCancellation })} />
          <ToggleRow title="Automatic gain control" hint="Keeps your voice at a steady level" on={audio.autoGainControl} onChange={(autoGainControl) => set({ autoGainControl })} />
        </div>

        <div className="card stack">
          <h2>Volume</h2>
          <Field label={`Stream audio — ${Math.round(audio.streamVolume * 100)}%`}>
            <input type="range" min={0} max={1} step={0.02} value={audio.streamVolume} aria-label="Stream audio volume" onChange={(e) => set({ streamVolume: Number(e.target.value) })} />
          </Field>
          <Field label={`Voice chat — ${Math.round(audio.voiceVolume * 100)}%`} hint="Each participant also has an individual volume slider in the room.">
            <input type="range" min={0} max={1} step={0.02} value={audio.voiceVolume} aria-label="Voice chat volume" onChange={(e) => set({ voiceVolume: Number(e.target.value) })} />
          </Field>
          <ToggleRow title="Mute stream audio" hint="Silences game/app sound from the shared screen; voice chat stays on" on={audio.streamMuted} onChange={(streamMuted) => set({ streamMuted })} />
        </div>
      </div>
    </div>
  );
}
