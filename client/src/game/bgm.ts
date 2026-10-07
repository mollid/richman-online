import { getSettings, SETTINGS_CHANGED_EVENT } from './settings.js';

/**
 * UI-11 背景音乐：**程序生成**的原创循环旋律（无任何音频素材文件），
 * 与 `sfx.ts` 同样只用 Web Audio 振荡器合成。
 *
 * 设计：一段 8 小节的轻快循环（主音 + 下行五度 + 上行三度），
 * 用三角波 + 低通增益包络，音量受 OPTION 的 `musicVolume` 控制，可整体静音。
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let timer: number | null = null;
let step = 0;
let started = false;

/** 8 小节旋律（相对半音，null = 休止）；C 大调五声音阶为主，避免刺耳 */
const MELODY: Array<number | null> = [
  0, 4, 7, 4, 2, 4, 0, null,
  -3, 0, 4, 0, 5, 4, 2, null,
  0, 4, 7, 12, 9, 7, 4, null,
  5, 7, 9, 7, 4, 2, 0, null,
];

/** 和声低音（每 4 步换一次根音） */
const BASS: number[] = [-12, -5, -7, -3];
/** 每步时长（毫秒），对应中速 120BPM 的八分音符 */
const STEP_MS = 250;

function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 把相对半音转成频率（以 C4 = 261.63Hz 为基准） */
function freq(semitone: number): number {
  return 261.63 * Math.pow(2, semitone / 12);
}

function note(semitone: number, dur: number, gain: number, type: OscillatorType): void {
  const ac = audio();
  if (!ac || !master) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1800, t0);
  osc.type = type;
  osc.frequency.setValueAtTime(freq(semitone), t0);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t0 + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(filter).connect(env).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** 推进一拍 */
function tick(): void {
  const settings = getSettings();
  if (!settings.musicEnabled || settings.musicVolume <= 0) return;
  const volume = Math.min(1, Math.max(0, settings.musicVolume / 100));
  if (master) master.gain.setTargetAtTime(volume * 0.06, audio()?.currentTime ?? 0, 0.1);

  const mel = MELODY[step % MELODY.length];
  if (mel !== null && mel !== undefined) {
    note(mel, STEP_MS / 1000 * 0.9, 0.5, 'triangle');
    // 加一个八度上的泛音让旋律更亮
    note(mel + 12, STEP_MS / 1000 * 0.5, 0.18, 'sine');
  }
  if (step % 4 === 0) {
    const bass = BASS[Math.floor(step / 4) % BASS.length]!;
    note(bass, STEP_MS / 1000 * 3.2, 0.42, 'triangle');
  }
  step += 1;
}

function ensureGraph(): boolean {
  const ac = audio();
  if (!ac) return false;
  if (!master) {
    master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);
  }
  return true;
}

/** 依据当前设置启动 BGM（幂等） */
export function syncMusic(): void {
  const settings = getSettings();
  if (!settings.musicEnabled || settings.musicVolume <= 0) {
    stopMusic();
    return;
  }
  if (!ensureGraph()) return;
  if (timer !== null) return;
  tick();
  timer = window.setInterval(tick, STEP_MS);
  started = true;
}

export function stopMusic(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (master) {
    const ac = audio();
    if (ac) master.gain.setTargetAtTime(0, ac.currentTime, 0.1);
  }
  started = false;
}

export function isMusicPlaying(): boolean {
  return started && timer !== null;
}

/** 挂载时调用：订阅设置变化，设置面板里勾选/调节音量即刻生效 */
export function initMusic(): () => void {
  syncMusic();
  const onChange = () => syncMusic();
  window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
    stopMusic();
  };
}

/** 文档：mute 音效时也一并压低 BGM（UI-11 的总静音） */
export function duckMusic(muted: boolean): void {
  if (!master) return;
  const ac = audio();
  if (!ac) return;
  const settings = getSettings();
  const base = muted ? 0 : Math.min(1, Math.max(0, settings.musicVolume / 100)) * 0.06;
  master.gain.setTargetAtTime(base, ac.currentTime, 0.1);
}