// 20-sample outlier-filtered P2P NTP clock sync engine over WebRTC control channel

const BURST_COUNT = 20;
const PING_INTERVAL_MS = 25;
const BURST_SETTLE_TIMEOUT_MS = 800;
const RESYNC_INTERVAL_MS = 45000;

export class ClockSyncEngine {
  constructor(options = {}) {
    this.isHost = Boolean(options.isHost);
    this.hostOffsetMs = 0; // tHost - tLocal
    this.bestRttMs = 0;
    this.syncQuality = this.isHost ? 'host' : 'unsynced';
    this.synced = this.isHost;
    this._samples = [];
    this._burstId = 0;
    this._burstTimer = null;
    this._settleTimer = null;
    this._resyncTimer = null;
    this._sendControlFn = null;
    this._onSyncUpdate = options.onSyncUpdate || (() => {});
  }

  setHostMode(isHost) {
    this.isHost = Boolean(isHost);
    if (this.isHost) {
      this.stopSync();
      this.hostOffsetMs = 0;
      this.bestRttMs = 0;
      this.syncQuality = 'host';
      this.synced = true;
    }
  }

  startSync(sendControlFn, onSyncUpdate) {
    if (this.isHost) return;
    if (sendControlFn) this._sendControlFn = sendControlFn;
    if (onSyncUpdate) this._onSyncUpdate = onSyncUpdate;

    this.stopSync();
    this.runBurst();
    this._resyncTimer = setInterval(() => {
      this.runBurst();
    }, RESYNC_INTERVAL_MS);
  }

  stopSync() {
    if (this._burstTimer) {
      clearInterval(this._burstTimer);
      this._burstTimer = null;
    }
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (this._resyncTimer) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }
  }

  runBurst() {
    if (this.isHost || !this._sendControlFn) return;
    if (this._burstTimer) {
      clearInterval(this._burstTimer);
      this._burstTimer = null;
    }
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }

    this._burstId += 1;
    const activeBurstId = this._burstId;
    this._samples = [];
    let sent = 0;

    const sendOne = () => {
      if (sent >= BURST_COUNT) {
        if (this._burstTimer) {
          clearInterval(this._burstTimer);
          this._burstTimer = null;
        }
        return;
      }
      sent += 1;
      try {
        this._sendControlFn({
          type: 'sync-ping',
          burstId: activeBurstId,
          seq: sent,
          t0: performance.now(),
        });
      } catch {
        // Ignore transient channel errors; settle timer will wrap up
      }
    };

    sendOne();
    this._burstTimer = setInterval(sendOne, PING_INTERVAL_MS);

    this._settleTimer = setTimeout(() => {
      if (activeBurstId === this._burstId) {
        this.finalizeBurst();
      }
    }, BURST_COUNT * PING_INTERVAL_MS + BURST_SETTLE_TIMEOUT_MS);
  }

  finalizeBurst() {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (this._samples.length === 0) return;

    const sorted = [...this._samples].sort((a, b) => a.rtt - b.rtt);
    const keepCount = Math.max(1, Math.ceil(sorted.length * 0.25));
    const best = sorted.slice(0, keepCount);

    let offsetSum = 0;
    let rttSum = 0;
    for (const s of best) {
      offsetSum += s.offset;
      rttSum += s.rtt;
    }

    this.hostOffsetMs = offsetSum / best.length;
    this.bestRttMs = rttSum / best.length;
    this.synced = true;

    if (this.bestRttMs < 15) this.syncQuality = 'excellent';
    else if (this.bestRttMs < 40) this.syncQuality = 'good';
    else if (this.bestRttMs < 100) this.syncQuality = 'fair';
    else this.syncQuality = 'poor';

    this._onSyncUpdate({
      hostOffsetMs: Number(this.hostOffsetMs.toFixed(2)),
      bestRttMs: Number(this.bestRttMs.toFixed(2)),
      sampleCount: this._samples.length,
      keptCount: best.length,
      syncQuality: this.syncQuality,
    });
  }

  handleIncomingMessage(peerId, msg, sendControlFn, audioSystem) {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'sync-ping') {
      if (this.isHost && sendControlFn) {
        sendControlFn(peerId, {
          type: 'sync-pong',
          burstId: msg.burstId ?? 0,
          seq: msg.seq ?? 0,
          t0: msg.t0,
          tHost: performance.now(),
        });
      }
      return true;
    }

    if (msg.type === 'sync-pong') {
      if (this.isHost) return true;
      if (msg.burstId !== undefined && msg.burstId !== this._burstId) return true;
      const t1 = performance.now();
      const rtt = t1 - msg.t0;
      if (Number.isFinite(rtt) && rtt >= 0 && rtt < 5000) {
        const offset = msg.tHost - (msg.t0 + rtt / 2);
        this._samples.push({ rtt, offset });
        if (this._samples.length >= BURST_COUNT) {
          this.finalizeBurst();
        }
      }
      return true;
    }

    if (msg.type === 'sync-beep' && audioSystem) {
      const ctx = audioSystem.ensureContext();
      const localAudioTime = this.hostTimeToLocalAudioTime(msg.hostStartTimeMs, ctx);
      audioSystem.scheduleSyncBeep(localAudioTime, audioSystem.channelRole, msg.freq || 880);
      return true;
    }

    return false;
  }

  getHostNowMs() {
    return performance.now() + (this.isHost ? 0 : this.hostOffsetMs);
  }

  hostTimeToLocalAudioTime(hostTimeMs, audioCtx) {
    const localTargetPerfMs = this.isHost
      ? hostTimeMs
      : hostTimeMs - this.hostOffsetMs;
    const deltaSec = (localTargetPerfMs - performance.now()) / 1000;
    return audioCtx.currentTime + deltaSec;
  }
}
