let ctx: AudioContext | null = null;
let muted = localStorage.getItem('richman.muted') === '1';

function audio(): AudioContext | null {
  if (muted) return null;
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

function tone(opts: {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
  delay?: number;
}): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + (opts.delay ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? 'square';
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(opts.slideTo, 1), t0 + opts.dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.08, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.05);
}

/** 程序生成的原创音效（无任何素材文件） */
export const sfx = {
  dice() {
    tone({ freq: 620, dur: 0.05, gain: 0.05 });
    tone({ freq: 760, dur: 0.05, gain: 0.05, delay: 0.07 });
    tone({ freq: 520, dur: 0.07, gain: 0.05, delay: 0.14 });
  },
  buy() {
    tone({ freq: 440, dur: 0.09, type: 'triangle', gain: 0.07 });
    tone({ freq: 660, dur: 0.12, type: 'triangle', gain: 0.07, delay: 0.09 });
  },
  pay() {
    tone({ freq: 520, dur: 0.14, type: 'sawtooth', gain: 0.05, slideTo: 240 });
  },
  bankrupt() {
    tone({ freq: 400, dur: 0.5, type: 'sawtooth', gain: 0.07, slideTo: 80 });
  },
  win() {
    [523, 659, 784, 1047].forEach((freq, i) => tone({ freq, dur: 0.16, type: 'triangle', gain: 0.07, delay: i * 0.13 }));
  },
  toggleMuted(): boolean {
    muted = !muted;
    localStorage.setItem('richman.muted', muted ? '1' : '0');
    return muted;
  },
  isMuted(): boolean {
    return muted;
  },
};
