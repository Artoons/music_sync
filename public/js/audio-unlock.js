// AudioContext unlocker, Screen Wake Lock manager, DSP bridge, and precision sync test pulse scheduler

import { AudioDspChain, BASE_DELAY_SEC } from './audio-dsp.js';

export { BASE_DELAY_SEC };

export class AudioSystem {
  constructor(options = {}) {
    this.onWakeLockChange = options.onWakeLockChange || (() => {});
    this.onVisibilityChange = options.onVisibilityChange || (() => {});
    this.audioCtx = null;
    this.dsp = null;
    this.wakeLock = null;
    this.unlocked = false;
    this.manualOffsetMs = 0;
    this.channelRole = 'full';
    this.volume = 1;
    this.bassEnabled = false;
    this.limiterEnabled = true;
    this._visibilityListenerBound = false;
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx({
        latencyHint: 'interactive',
        sampleRate: 48000,
      });

      this.dsp = new AudioDspChain(this.audioCtx, {
        manualOffsetMs: this.manualOffsetMs,
        channelRole: this.channelRole,
        volume: this.volume,
        bassEnabled: this.bassEnabled,
        limiterEnabled: this.limiterEnabled,
      });
    }
    return this.audioCtx;
  }

  getInputNode() {
    this.ensureContext();
    return this.dsp.input;
  }

  roleToPan(role) {
    if (role === 'left') return -1;
    if (role === 'right') return 1;
    return 0;
  }

  getDelaySeconds() {
    return this.dsp
      ? this.dsp.getDelaySeconds()
      : Math.max(0, BASE_DELAY_SEC + this.manualOffsetMs / 1000);
  }

  setManualOffsetMs(ms) {
    const clamped = Math.max(-150, Math.min(150, Math.round(Number(ms) || 0)));
    this.manualOffsetMs = clamped;
    if (this.dsp) {
      return this.dsp.setManualOffsetMs(clamped);
    }
    return this.manualOffsetMs;
  }

  setChannelRole(role) {
    const valid = ['full', 'left', 'right', 'center'];
    this.channelRole = valid.includes(role) ? role : 'full';
    if (this.dsp) {
      return this.dsp.setChannelRole(this.channelRole);
    }
    return this.channelRole;
  }

  setBassBoost(enabled) {
    this.bassEnabled = Boolean(enabled);
    if (this.dsp) {
      return this.dsp.setBassBoost(this.bassEnabled);
    }
    return this.bassEnabled;
  }

  setLimiter(enabled) {
    this.limiterEnabled = Boolean(enabled);
    if (this.dsp) {
      return this.dsp.setLimiter(this.limiterEnabled);
    }
    return this.limiterEnabled;
  }

  setVolume(vol) {
    const clamped = Math.max(0, Math.min(1, Number(vol)));
    this.volume = Number.isFinite(clamped) ? clamped : 1;
    if (this.dsp) {
      return this.dsp.setVolume(this.volume);
    }
    return this.volume;
  }

  getFrequencyLevels(barCount = 21) {
    if (!this.dsp) return new Array(barCount).fill(0);
    return this.dsp.getFrequencyLevels(barCount);
  }

  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // 1-frame silent pulse to unlock mobile Web Audio output
    const silentBuffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const silentSrc = ctx.createBufferSource();
    silentSrc.buffer = silentBuffer;
    silentSrc.connect(ctx.destination);
    silentSrc.start(ctx.currentTime);

    // Subtle confirmation chime on unlock
    const now = ctx.currentTime + 0.02;
    this.playDirectChime(now, 523.25, 0.08, 0.07);
    this.playDirectChime(now + 0.06, 659.25, 0.08, 0.08);

    this.unlocked = true;
    await this.requestWakeLock();
    this.bindVisibilityHandler();
    return ctx;
  }

  playDirectChime(startTime, freq, gainPeak, duration) {
    const ctx = this.audioCtx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(gainPeak, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  async requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      this.onWakeLockChange(false, 'unsupported');
      return false;
    }
    try {
      if (this.wakeLock && !this.wakeLock.released) {
        this.onWakeLockChange(true, 'active');
        return true;
      }
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.onWakeLockChange(false, 'released');
      });
      this.onWakeLockChange(true, 'active');
      return true;
    } catch {
      this.onWakeLockChange(false, 'denied');
      return false;
    }
  }

  bindVisibilityHandler() {
    if (this._visibilityListenerBound) return;
    this._visibilityListenerBound = true;
    document.addEventListener('visibilitychange', async () => {
      const hidden = document.visibilityState !== 'visible';
      this.onVisibilityChange(hidden);
      if (!hidden && this.unlocked) {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          try {
            await this.audioCtx.resume();
          } catch {
            // ignore
          }
        }
        await this.requestWakeLock();
      }
    });
  }

  scheduleSyncBeep(targetSpeakerAudioTime, role = this.channelRole, freq = 880) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const rawScheduleTime = targetSpeakerAudioTime - BASE_DELAY_SEC;
    const minSafeTime = ctx.currentTime + 0.005;
    const scheduleTime = Math.max(minSafeTime, rawScheduleTime);
    const lateMs = rawScheduleTime < minSafeTime ? (minSafeTime - rawScheduleTime) * 1000 : 0;

    const osc = ctx.createOscillator();
    const clickOsc = ctx.createOscillator();
    const env = ctx.createGain();
    const localPan = ctx.createStereoPanner();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, scheduleTime);

    clickOsc.type = 'sine';
    clickOsc.frequency.setValueAtTime(freq * 2, scheduleTime);

    env.gain.setValueAtTime(0.0001, scheduleTime);
    env.gain.exponentialRampToValueAtTime(0.55, scheduleTime + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, scheduleTime + 0.05);

    localPan.pan.value = role === this.channelRole ? 0 : this.roleToPan(role);

    osc.connect(env);
    clickOsc.connect(env);
    env.connect(localPan);
    localPan.connect(this.dsp.input);

    osc.start(scheduleTime);
    clickOsc.start(scheduleTime);
    osc.stop(scheduleTime + 0.055);
    clickOsc.stop(scheduleTime + 0.055);

    return {
      scheduledAt: scheduleTime,
      expectedOutputAt: scheduleTime + this.getDelaySeconds(),
      clampedLateMs: Math.round(lateMs),
    };
  }
}
