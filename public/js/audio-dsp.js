// Web Audio DSP chain: delay offset, 2x2 role matrix, psychoacoustic bass harmonics, brickwall limiter, and analyser

export const BASE_DELAY_SEC = 0.15;

export function createHarmonicCurve(amount = 3.2, samples = 1024) {
  const n = Math.max(16, Math.floor(samples));
  const curve = new Float32Array(n);
  const norm = Math.tanh(amount + 0.12) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    // Slight quadratic bias creates 2nd-order warmth alongside 3rd-order odd harmonics in 150-400 Hz
    const y = Math.tanh(x * amount + 0.12 * x * x) / norm;
    curve[i] = Math.max(-1, Math.min(1, y));
  }
  return curve;
}

const ROLE_MATRICES = {
  full: [1, 0, 0, 1],
  left: [1, 0, 1, 0],
  right: [0, 1, 0, 1],
  center: [0.5, 0.5, 0.5, 0.5],
};

export class AudioDspChain {
  constructor(audioCtx, options = {}) {
    this.ctx = audioCtx;
    this.manualOffsetMs = 0;
    this.channelRole = 'full';
    this.volume = 1;
    this.bassEnabled = Boolean(options.bassEnabled);
    this.limiterEnabled = options.limiterEnabled !== undefined ? Boolean(options.limiterEnabled) : true;

    this.input = this.ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';

    this.delayNode = this.ctx.createDelay(1.0);

    // True 2x2 stereo role matrix
    this.splitter = this.ctx.createChannelSplitter(2);
    this.lToL = this.ctx.createGain();
    this.rToL = this.ctx.createGain();
    this.lToR = this.ctx.createGain();
    this.rToR = this.ctx.createGain();
    this.merger = this.ctx.createChannelMerger(2);

    // Parallel dry + psychoacoustic bass harmonic enhancer (150-400 Hz overtones)
    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 1.0;

    this.bassLowpass = this.ctx.createBiquadFilter();
    this.bassLowpass.type = 'lowpass';
    this.bassLowpass.frequency.value = 140;
    this.bassLowpass.Q.value = 0.8;

    this.bassHighpass = this.ctx.createBiquadFilter();
    this.bassHighpass.type = 'highpass';
    this.bassHighpass.frequency.value = 45;
    this.bassHighpass.Q.value = 0.7;

    this.bassShaper = this.ctx.createWaveShaper();
    this.bassShaper.curve = createHarmonicCurve(3.2, 1024);
    this.bassShaper.oversample = '2x';

    this.bassBandpass = this.ctx.createBiquadFilter();
    this.bassBandpass.type = 'bandpass';
    this.bassBandpass.frequency.value = 240;
    this.bassBandpass.Q.value = 0.9;

    this.bassWetGain = this.ctx.createGain();
    this.preLimiterBus = this.ctx.createGain();

    // Brickwall compressor / limiter + makeup gain
    this.compressor = this.ctx.createDynamicsCompressor();
    this.makeupGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.78;
    this._freqBins = new Uint8Array(this.analyser.frequencyBinCount);

    // Wire graph: input -> delay -> splitter -> 2x2 matrix -> merger
    this.input.connect(this.delayNode);
    this.delayNode.connect(this.splitter);

    this.splitter.connect(this.lToL, 0);
    this.splitter.connect(this.rToL, 1);
    this.splitter.connect(this.lToR, 0);
    this.splitter.connect(this.rToR, 1);

    this.lToL.connect(this.merger, 0, 0);
    this.rToL.connect(this.merger, 0, 0);
    this.lToR.connect(this.merger, 0, 1);
    this.rToR.connect(this.merger, 0, 1);

    // Dry & harmonic branches -> preLimiterBus
    this.merger.connect(this.dryGain);
    this.dryGain.connect(this.preLimiterBus);

    this.merger.connect(this.bassLowpass);
    this.bassLowpass.connect(this.bassHighpass);
    this.bassHighpass.connect(this.bassShaper);
    this.bassShaper.connect(this.bassBandpass);
    this.bassBandpass.connect(this.bassWetGain);
    this.bassWetGain.connect(this.preLimiterBus);

    // Limiter -> Master Gain -> Analyser -> Output
    this.preLimiterBus.connect(this.compressor);
    this.compressor.connect(this.makeupGain);
    this.makeupGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Apply initial parameter values immediately
    this.setManualOffsetMs(options.manualOffsetMs ?? 0, true);
    this.setChannelRole(options.channelRole ?? 'full', true);
    this.setBassBoost(this.bassEnabled, true);
    this.setLimiter(this.limiterEnabled, true);
    this.setVolume(options.volume ?? 1, true);
  }

  getDelaySeconds() {
    return Math.max(0, BASE_DELAY_SEC + this.manualOffsetMs / 1000);
  }

  setManualOffsetMs(ms, immediate = false) {
    const clamped = Math.max(-150, Math.min(150, Math.round(Number(ms) || 0)));
    this.manualOffsetMs = clamped;
    const delaySec = this.getDelaySeconds();
    if (immediate) {
      this.delayNode.delayTime.value = delaySec;
    } else {
      this.delayNode.delayTime.setTargetAtTime(delaySec, this.ctx.currentTime, 0.015);
    }
    return this.manualOffsetMs;
  }

  setChannelRole(role, immediate = false) {
    const next = Object.prototype.hasOwnProperty.call(ROLE_MATRICES, role) ? role : 'full';
    this.channelRole = next;
    const [ll, rl, lr, rr] = ROLE_MATRICES[next];
    const now = this.ctx.currentTime;
    if (immediate) {
      this.lToL.gain.value = ll;
      this.rToL.gain.value = rl;
      this.lToR.gain.value = lr;
      this.rToR.gain.value = rr;
    } else {
      this.lToL.gain.setTargetAtTime(ll, now, 0.015);
      this.rToL.gain.setTargetAtTime(rl, now, 0.015);
      this.lToR.gain.setTargetAtTime(lr, now, 0.015);
      this.rToR.gain.setTargetAtTime(rr, now, 0.015);
    }
    return this.channelRole;
  }

  setBassBoost(enabled, immediate = false) {
    this.bassEnabled = Boolean(enabled);
    const wet = this.bassEnabled ? 0.55 : 0.0;
    if (immediate) {
      this.bassWetGain.gain.value = wet;
    } else {
      this.bassWetGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.02);
    }
    return this.bassEnabled;
  }

  setLimiter(enabled, immediate = false) {
    this.limiterEnabled = Boolean(enabled);
    const now = this.ctx.currentTime;
    const threshold = this.limiterEnabled ? -12 : 0;
    const knee = 6;
    const ratio = this.limiterEnabled ? 12 : 1;
    const attack = 0.003;
    const release = 0.15;
    const makeup = this.limiterEnabled ? 1.45 : 1.0;

    if (immediate) {
      this.compressor.threshold.value = threshold;
      this.compressor.knee.value = knee;
      this.compressor.ratio.value = ratio;
      this.compressor.attack.value = attack;
      this.compressor.release.value = release;
      this.makeupGain.gain.value = makeup;
    } else {
      this.compressor.threshold.setTargetAtTime(threshold, now, 0.02);
      this.compressor.knee.setTargetAtTime(knee, now, 0.02);
      this.compressor.ratio.setTargetAtTime(ratio, now, 0.02);
      this.compressor.attack.setTargetAtTime(attack, now, 0.02);
      this.compressor.release.setTargetAtTime(release, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(makeup, now, 0.02);
    }
    return this.limiterEnabled;
  }

  setVolume(vol, immediate = false) {
    const clamped = Math.max(0, Math.min(1, Number(vol)));
    this.volume = Number.isFinite(clamped) ? clamped : 1;
    if (immediate) {
      this.masterGain.gain.value = this.volume;
    } else {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
    return this.volume;
  }

  getFrequencyLevels(barCount = 21) {
    this.analyser.getByteFrequencyData(this._freqBins);
    const half = Math.floor(barCount / 2);
    const usableBins = Math.min(this._freqBins.length, 36);
    const levels = new Array(barCount);

    for (let i = 0; i < barCount; i++) {
      const dist = Math.abs(i - half);
      const frac = half > 0 ? dist / half : 0;
      const binIndex = Math.min(usableBins - 1, Math.floor(frac * (usableBins - 1)));
      const nextIndex = Math.min(usableBins - 1, binIndex + 1);
      const raw = (this._freqBins[binIndex] * 0.7 + this._freqBins[nextIndex] * 0.3) / 255;
      levels[i] = Math.max(0, Math.min(1, raw));
    }

    return levels;
  }
}
