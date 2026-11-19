// Release 5: YouTube & YT Music Remote Co-Listening Sync Controller

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeVideoId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (YT_ID_RE.test(trimmed)) {
    return trimmed;
  }

  let url;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    url = new URL(withProto);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    const seg = url.pathname.split('/').filter(Boolean)[0];
    return seg && YT_ID_RE.test(seg) ? seg : null;
  }

  const isYouTubeHost =
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com';

  if (!isYouTubeHost) return null;

  const vParam = url.searchParams.get('v');
  if (vParam && YT_ID_RE.test(vParam)) {
    return vParam;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
    return YT_ID_RE.test(parts[1]) ? parts[1] : null;
  }

  return null;
}

export function computeRemoteSyncAction(localPosSec, targetPosSec, thresholdSec = 0.45) {
  const local = Number(localPosSec);
  const target = Number(targetPosSec);
  if (!Number.isFinite(local) || !Number.isFinite(target)) {
    return { shouldSeek: false, driftSec: 0, targetPosSec: 0 };
  }
  const driftSec = local - target;
  return {
    shouldSeek: Math.abs(driftSec) > thresholdSec,
    driftSec,
    targetPosSec: Math.max(0, target),
  };
}

let ytApiPromise = null;

function loadYouTubeIframeApi() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('No browser window'));
  }
  if (window.YT && typeof window.YT.Player === 'function') {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') {
        try {
          prevReady();
        } catch {
          // ignore
        }
      }
      resolve(window.YT);
    };

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        ytApiPromise = null;
        reject(new Error('Failed to load YouTube IFrame API'));
      };
      document.head.appendChild(script);
    }

    setTimeout(() => {
      if (window.YT && typeof window.YT.Player === 'function') {
        resolve(window.YT);
      }
    }, 8000);
  });

  return ytApiPromise;
}

export class RemoteTabController {
  constructor({ clockSync, rtcMesh, mountElementId, onStateChange }) {
    this.clockSync = clockSync;
    this.rtcMesh = rtcMesh;
    this.mountElementId = mountElementId;
    this.onStateChange = onStateChange || (() => {});

    this.isHost = false;
    this.videoId = null;
    this.isPlaying = false;
    this.positionSec = 0;
    this.hostTimeMs = 0;
    this.lastDriftMs = 0;
    this.statusMessage = '';
    this.errorMessage = '';

    this.player = null;
    this._playerReady = false;
    this._pendingLoad = null;
    this._suppressHostEvent = false;
    this._beaconTimer = null;
  }

  setHostMode(isHost) {
    this.isHost = Boolean(isHost);
    this.emitState();
  }

  emitState() {
    this.onStateChange(this.getUiState());
  }

  getUiState() {
    return {
      isHost: this.isHost,
      hasVideo: Boolean(this.videoId),
      videoId: this.videoId,
      isPlaying: this.isPlaying,
      positionSec: this.positionSec,
      lastDriftMs: this.lastDriftMs,
      statusMessage: this.statusMessage,
      errorMessage: this.errorMessage,
    };
  }

  async _ensurePlayer(initialVideoId) {
    if (this.player && this._playerReady) {
      return this.player;
    }

    this.statusMessage = 'Loading YouTube player...';
    this.emitState();

    const YT = await loadYouTubeIframeApi();
    if (this.player) return this.player;

    return await new Promise((resolve) => {
      this.player = new YT.Player(this.mountElementId, {
        videoId: initialVideoId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: () => {
            this._playerReady = true;
            this.statusMessage = this.isHost
              ? 'Ready — press Play inside video or Sync All'
              : 'Synced to Host video';
            if (this._pendingLoad) {
              const p = this._pendingLoad;
              this._pendingLoad = null;
              this._applyRemoteToPlayer(p);
            }
            this.emitState();
            resolve(this.player);
          },
          onStateChange: (event) => {
            this._handlePlayerStateChange(event.data);
          },
        },
      });
    });
  }

  _handlePlayerStateChange(ytState) {
    if (!this.isHost || this._suppressHostEvent || !window.YT?.PlayerState) return;
    const PS = window.YT.PlayerState;
    if (ytState === PS.PLAYING) {
      this.isPlaying = true;
      this.broadcastState();
    } else if (ytState === PS.PAUSED || ytState === PS.ENDED) {
      this.isPlaying = false;
      this.broadcastState();
    }
  }

  async loadVideo(rawInput) {
    if (!this.isHost) return false;
    const id = extractYouTubeVideoId(rawInput);
    if (!id) {
      this.errorMessage = 'Enter a valid YouTube / YouTube Music URL or 11-character video ID.';
      this.emitState();
      return false;
    }

    this.errorMessage = '';
    const isNew = this.videoId !== id;
    this.videoId = id;
    this.isPlaying = true;
    this.positionSec = 0;
    this.hostTimeMs = performance.now();

    try {
      const player = await this._ensurePlayer(id);
      if (isNew && typeof player.loadVideoById === 'function') {
        this._suppressHostEvent = true;
        player.loadVideoById(id, 0);
        setTimeout(() => {
          this._suppressHostEvent = false;
        }, 400);
      }
      this.broadcastState();
      this._startBeacon();
      this.emitState();
      return true;
    } catch (err) {
      this.errorMessage = err?.message || 'Could not load YouTube player';
      this.emitState();
      return false;
    }
  }

  forceSyncNow() {
    if (!this.isHost || !this.videoId) return;
    this.broadcastState();
  }

  broadcastState() {
    if (!this.isHost || !this.videoId) return;
    let pos = this.positionSec;
    if (this.player && this._playerReady && typeof this.player.getCurrentTime === 'function') {
      pos = Number(this.player.getCurrentTime()) || 0;
    }
    this.positionSec = pos;
    this.hostTimeMs = performance.now();

    this.rtcMesh.broadcastControl({
      type: 'remote-state',
      videoId: this.videoId,
      isPlaying: this.isPlaying,
      positionSec: this.positionSec,
      hostTimeMs: this.hostTimeMs,
    });
    this.emitState();
  }

  syncPeer(peerId) {
    if (!this.isHost || !this.videoId || !peerId) return;
    let pos = this.positionSec;
    if (this.player && this._playerReady && typeof this.player.getCurrentTime === 'function') {
      pos = Number(this.player.getCurrentTime()) || 0;
    }
    this.rtcMesh.sendControlToPeer(peerId, {
      type: 'remote-state',
      videoId: this.videoId,
      isPlaying: this.isPlaying,
      positionSec: pos,
      hostTimeMs: performance.now(),
    });
  }

  _startBeacon() {
    this._stopBeacon();
    this._beaconTimer = setInterval(() => {
      if (this.isHost && this.videoId) {
        this.broadcastState();
      }
    }, 1500);
  }

  _stopBeacon() {
    if (this._beaconTimer) {
      clearInterval(this._beaconTimer);
      this._beaconTimer = null;
    }
  }

  handleControlMessage(_peerId, msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'remote-state') return false;
    if (this.isHost || !msg.videoId) return true;

    this.errorMessage = '';
    const prevId = this.videoId;
    this.videoId = msg.videoId;
    this.isPlaying = Boolean(msg.isPlaying);
    this.positionSec = Number(msg.positionSec) || 0;
    this.hostTimeMs = Number(msg.hostTimeMs) || 0;

    if (!this.player || !this._playerReady) {
      this._pendingLoad = msg;
      this._ensurePlayer(msg.videoId).catch((err) => {
        this.errorMessage = err?.message || 'Failed loading YouTube player';
        this.emitState();
      });
      this.emitState();
      return true;
    }

    this._applyRemoteToPlayer(msg, prevId !== msg.videoId);
    this.emitState();
    return true;
  }

  _applyRemoteToPlayer(msg, videoChanged = false) {
    if (!this.player || !this._playerReady) return;
    const elapsedSec = msg.isPlaying
      ? Math.max(0, (this.clockSync.getHostNowMs() - (msg.hostTimeMs || 0)) / 1000)
      : 0;
    const targetPos = (Number(msg.positionSec) || 0) + elapsedSec;

    if (videoChanged && typeof this.player.loadVideoById === 'function') {
      this.player.loadVideoById(msg.videoId, targetPos);
      if (!msg.isPlaying && typeof this.player.pauseVideo === 'function') {
        setTimeout(() => this.player?.pauseVideo?.(), 250);
      }
      this.lastDriftMs = 0;
      this.statusMessage = msg.isPlaying ? 'Playing in remote sync' : 'Paused by Host';
      return;
    }

    const currentPos =
      typeof this.player.getCurrentTime === 'function' ? this.player.getCurrentTime() : targetPos;
    const action = computeRemoteSyncAction(currentPos, targetPos, 0.45);
    this.lastDriftMs = action.driftSec * 1000;

    if (action.shouldSeek && typeof this.player.seekTo === 'function') {
      this.player.seekTo(action.targetPosSec, true);
    }

    const PS = window.YT?.PlayerState;
    const pState =
      typeof this.player.getPlayerState === 'function' ? this.player.getPlayerState() : -1;

    if (msg.isPlaying) {
      if (PS && pState !== PS.PLAYING && pState !== PS.BUFFERING) {
        this.player.playVideo?.();
      }
      this.statusMessage = `Synced (±${Math.abs(this.lastDriftMs).toFixed(0)} ms)`;
    } else {
      if (!PS || pState === PS.PLAYING) {
        this.player.pauseVideo?.();
      }
      this.statusMessage = 'Paused by Host';
    }
  }

  reset() {
    this._stopBeacon();
    this.videoId = null;
    this.isPlaying = false;
    this.positionSec = 0;
    this.hostTimeMs = 0;
    this.lastDriftMs = 0;
    this.statusMessage = '';
    this.errorMessage = '';
    this._pendingLoad = null;
    this._playerReady = false;
    if (this.player) {
      try {
        this.player.destroy();
      } catch {
        // ignore
      }
      this.player = null;
    }
    this.emitState();
  }
}
