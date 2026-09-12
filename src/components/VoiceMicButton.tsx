/**
 * VoiceMicButton — 语音输入（刘总 2026-09）。
 *
 * 按住/点按开始录音：实时波形（AnalyserNode 时域数据）+ 录音时长；
 * 停止后把录音字节交给主进程 audio:transcribe（当前激活模型服务的
 * /audio/transcriptions）。转写失败如实显示原因——服务不支持语音时
 * 明确告知，绝不假装识别成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';

interface VoiceMicButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

type RecorderState =
  | { phase: 'idle' }
  | { phase: 'error'; message: string }
  | { phase: 'recording'; startedAt: number }
  | { phase: 'transcribing' };

const MAX_RECORD_MS = 120_000;

export default function VoiceMicButton({ onTranscript, disabled = false }: VoiceMicButtonProps) {
  const [state, setState] = useState<RecorderState>({ phase: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const cleanupAudio = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  function drawWave() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.lineWidth = 2;
    context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary') || '#2563eb';
    context.beginPath();
    const step = Math.max(1, Math.floor(data.length / width));
    for (let x = 0; x < width; x += 1) {
      const raw = data[Math.min(data.length - 1, x * step)] ?? 128;
      const value = raw / 128 - 1;
      const y = height / 2 + value * (height / 2 - 2);
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    rafRef.current = requestAnimationFrame(drawWave);
  }


  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      cleanupAudio();
      setState({ phase: 'idle' });
      return;
    }
    setState({ phase: 'transcribing' });
    recorder.stop();
  }, [cleanupAudio]);

  const transcribe = useCallback(async (mime: string) => {
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (blob.size === 0) {
      setState({ phase: 'error', message: '没有录到声音，请重试。' });
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      const result = await window.metis?.transcribeAudio?.(bytes, mime);
      if (result?.ok && result.text) {
        onTranscript(result.text);
        setState({ phase: 'idle' });
        return;
      }
      const reason = result?.code === 'empty_transcript'
        ? (result.message || '未识别到语音内容。')
        : (result?.message || `转写未完成（${result?.code ?? 'unknown'}）。当前模型服务可能不支持语音转写。`);
      setState({ phase: 'error', message: reason });
    } catch {
      setState({ phase: 'error', message: '转写服务不可用。' });
    }
  }, [onTranscript]);

  const start = useCallback(async () => {
    if (disabled) return;
    setState({ phase: 'idle' });
    setElapsed(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        rafRef.current = requestAnimationFrame(drawWave);
      }
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType || 'audio/webm';
        cleanupAudio();
        void transcribe(mime);
      };
      recorder.start();
      const startedAt = Date.now();
      setState({ phase: 'recording', startedAt });
      timerRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startedAt);
      }, 200);
      window.setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state === 'recording') void finishRecording();
      }, MAX_RECORD_MS);
    } catch (error) {
      cleanupAudio();
      const message = error instanceof Error && error.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在系统设置中允许后重试。'
        : `无法访问麦克风：${error instanceof Error ? error.message : 'unknown'}`;
      setState({ phase: 'error', message });
    }
  }, [cleanupAudio, disabled, drawWave, finishRecording, transcribe]);

  const click = useCallback(() => {
    if (state.phase === 'recording') void finishRecording();
    else if (state.phase === 'idle' || state.phase === 'error') void start();
  }, [finishRecording, start, state.phase]);

  const title = state.phase === 'recording'
    ? '停止录音并转写'
    : state.phase === 'transcribing'
      ? '正在转写…'
      : '语音输入';

  return (
    <span className="voice-mic" data-testid="voice-mic">
      {state.phase === 'recording' && (
        <span className="voice-mic__live" data-testid="voice-wave">
          <canvas ref={canvasRef} width={120} height={26} aria-hidden="true" />
          <small>{(elapsed / 1000).toFixed(1)}s</small>
        </span>
      )}
      {state.phase === 'transcribing' && <small className="voice-mic__hint" role="status">转写中…</small>}
      {state.phase === 'error' && (
        <small className="voice-mic__hint voice-mic__hint--error" role="alert" title={state.message}>
          {state.message.length > 26 ? `${state.message.slice(0, 26)}…` : state.message}
        </small>
      )}
      <button
        type="button"
        className={`chat-tool-icon voice-mic__button ${state.phase === 'recording' ? 'is-recording' : ''}`}
        onClick={click}
        disabled={disabled || state.phase === 'transcribing'}
        aria-label={title}
        title={title}
        data-testid="voice-mic-button"
      >
        {state.phase === 'recording' ? <Square size={15} /> : <Mic size={16} />}
      </button>
    </span>
  );
}
