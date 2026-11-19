// Release 4: 60 FPS Canvas Spectrum Visualizer + 21-bar live chalkboard waveform

export class SpectrumVisualizer {
  constructor({ audioSystem, waveContainer, canvas }) {
    this.audioSystem = audioSystem;
    this.waveContainer = waveContainer;
    this.canvas = canvas;
    this.ctx2d = canvas ? canvas.getContext('2d') : null;
    this._raf = null;
    this._active = false;
    this._peaks = new Float32Array(32);
    this._bars = waveContainer ? [...waveContainer.querySelectorAll('span')] : [];
  }

  start() {
    if (this._active) return;
    this._active = true;
    if (this.waveContainer) {
      this.waveContainer.classList.add('live-audio');
    }
    const tick = () => {
      if (!this._active) return;
      this.drawFrame();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._active = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this.waveContainer) {
      this.waveContainer.classList.remove('live-audio');
      for (const bar of this._bars) {
        bar.style.height = '';
        bar.style.opacity = '';
        bar.style.background = '';
      }
    }
    this._peaks.fill(0);
    this.drawIdleCanvas();
  }

  _readThemeColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      fg: styles.getPropertyValue('--fg').trim() || '#f5f5f5',
      fgDim: styles.getPropertyValue('--fg-dim').trim() || '#6f6f78',
      red: styles.getPropertyValue('--red').trim() || '#e53240',
    };
  }

  _syncCanvasSize() {
    if (!this.canvas) return { width: 0, height: 0 };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    const targetW = Math.floor(cssW * dpr);
    const targetH = Math.floor(cssH * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssW, height: cssH };
  }

  drawIdleCanvas() {
    if (!this.canvas || !this.ctx2d) return;
    const { width, height } = this._syncCanvasSize();
    if (!width || !height) return;
    const { fgDim } = this._readThemeColors();
    this.ctx2d.clearRect(0, 0, width, height);
    this.ctx2d.strokeStyle = fgDim;
    this.ctx2d.globalAlpha = 0.28;
    this.ctx2d.lineWidth = 1;
    this.ctx2d.beginPath();
    this.ctx2d.moveTo(0, height - 2);
    this.ctx2d.lineTo(width, height - 2);
    this.ctx2d.stroke();
    this.ctx2d.globalAlpha = 1;
  }

  drawFrame() {
    const levels = this.audioSystem.getFrequencyLevels(Math.max(21, this._bars.length));
    const { fg, red } = this._readThemeColors();

    // Update 21-bar chalkboard waveform
    for (let i = 0; i < this._bars.length; i++) {
      const level = levels[i] || 0;
      const bar = this._bars[i];
      bar.style.height = `${Math.round(8 + level * 58)}px`;
      bar.style.opacity = (0.28 + level * 0.72).toFixed(2);
      bar.style.background = i === 10 || level > 0.55 ? 'var(--red)' : 'var(--fg)';
    }

    // Update 60 FPS spectrum canvas
    if (!this.canvas || !this.ctx2d) return;
    const { width, height } = this._syncCanvasSize();
    if (!width || !height) return;

    const canvasLevels = this.audioSystem.getFrequencyLevels(32);
    const barCount = canvasLevels.length;
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);

    this.ctx2d.clearRect(0, 0, width, height);

    for (let i = 0; i < barCount; i++) {
      const level = canvasLevels[i] || 0;
      this._peaks[i] = Math.max(level, this._peaks[i] - 0.015);

      const barH = Math.max(2, level * (height - 6));
      const x = i * (barWidth + gap);
      const y = height - barH;

      this.ctx2d.fillStyle = level > 0.62 ? red : fg;
      this.ctx2d.globalAlpha = 0.25 + level * 0.65;
      this.ctx2d.fillRect(x, y, barWidth, barH);

      const peakY = Math.max(1, height - this._peaks[i] * (height - 6) - 2);
      this.ctx2d.fillStyle = red;
      this.ctx2d.globalAlpha = 0.85;
      this.ctx2d.fillRect(x, peakY, barWidth, 2);
    }

    this.ctx2d.globalAlpha = 1;
  }
}
