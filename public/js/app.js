import { generateQrSvg } from './qrcode.js';
import { AudioSystem } from './audio-unlock.js';
import { ClockSyncEngine } from './clock-sync.js';
import { RTCMesh } from './rtc-mesh.js';
import { FilesTabController } from './tab-files.js';
import { CastTabController } from './tab-cast.js';
import { RemoteTabController } from './tab-remote.js';
import { RequestQueueController } from './requests.js';
import { SpectrumVisualizer } from './visualizer.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

function generateRoomCode(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function defaultDeviceName(isHost) {
  const ua = navigator.userAgent || '';
  const suffix = Math.floor(100 + Math.random() * 900);
  if (isHost) {
    if (/Windows/i.test(ua)) return `Host-PC-${suffix}`;
    if (/Mac/i.test(ua)) return `Host-Mac-${suffix}`;
    if (/Android/i.test(ua)) return `Host-Android-${suffix}`;
    return `Host-${suffix}`;
  }
  if (/Android/i.test(ua)) return `Android-${suffix}`;
  if (/iPhone|iPad/i.test(ua)) return `iPhone-${suffix}`;
  return `Speaker-${suffix}`;
}

function getOrCreatePeerId() {
  const key = 'syncstage_peer_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `peer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const el = {
  metaThemeColor: document.getElementById('meta-theme-color'),
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  roomNavControls: document.getElementById('room-nav-controls'),
  joinScreen: document.getElementById('join-screen'),
  roomScreen: document.getElementById('room-screen'),
  modeHostBtn: document.getElementById('mode-host-btn'),
  modeListenerBtn: document.getElementById('mode-listener-btn'),
  roomCodeInput: document.getElementById('room-code-input'),
  randomCodeBtn: document.getElementById('random-code-btn'),
  nicknameInput: document.getElementById('nickname-input'),
  joinError: document.getElementById('join-error'),
  unlockJoinBtn: document.getElementById('unlock-join-btn'),

  headerRoomCode: document.getElementById('header-room-code'),
  openQrBtn: document.getElementById('open-qr-btn'),
  meshBadge: document.getElementById('mesh-badge'),
  wakelockBadge: document.getElementById('wakelock-badge'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),

  backgroundBanner: document.getElementById('background-banner'),
  hostLeftBanner: document.getElementById('host-left-banner'),
  isolationBanner: document.getElementById('isolation-banner'),
  openTurnBtn: document.getElementById('open-turn-btn'),
  retryP2pBtn: document.getElementById('retry-p2p-btn'),

  tabButtons: [...document.querySelectorAll('.tab-btn')],
  panelFiles: document.getElementById('panel-files'),
  panelCast: document.getElementById('panel-cast'),
  panelRemote: document.getElementById('panel-remote'),
  castCapabilityText: document.getElementById('cast-capability-text'),

  pulseBox: document.getElementById('pulse-box'),
  syncWave: document.getElementById('sync-wave'),
  spectrumCanvas: document.getElementById('spectrum-canvas'),
  filesDropZone: document.getElementById('files-drop-zone'),
  fileInput: document.getElementById('file-input'),
  pickFileBtn: document.getElementById('pick-file-btn'),
  loadTestTrackBtn: document.getElementById('load-test-track-btn'),
  fileDropHint: document.getElementById('file-drop-hint'),
  trackBar: document.getElementById('track-bar'),
  trackTitle: document.getElementById('track-title'),
  trackStatus: document.getElementById('track-status'),
  transferProgressFill: document.getElementById('transfer-progress-fill'),
  playPauseBtn: document.getElementById('play-pause-btn'),
  trackTime: document.getElementById('track-time'),
  trackSeekSlider: document.getElementById('track-seek-slider'),
  loopToggleBtn: document.getElementById('loop-toggle-btn'),

  castHostControls: document.getElementById('cast-host-controls'),
  castToggleBtn: document.getElementById('cast-toggle-btn'),
  castMonitorBtn: document.getElementById('cast-monitor-btn'),
  castDelaySelect: document.getElementById('cast-delay-select'),
  castCodecBadge: document.getElementById('cast-codec-badge'),
  castStatusText: document.getElementById('cast-status-text'),
  castError: document.getElementById('cast-error'),

  remoteHostControls: document.getElementById('remote-host-controls'),
  remoteUrlInput: document.getElementById('remote-url-input'),
  remoteLoadBtn: document.getElementById('remote-load-btn'),
  remoteSyncBtn: document.getElementById('remote-sync-btn'),
  remoteError: document.getElementById('remote-error'),
  remotePlayerWrap: document.getElementById('remote-player-wrap'),
  remoteStatusText: document.getElementById('remote-status-text'),

  requestsCount: document.getElementById('requests-count'),
  requestInput: document.getElementById('request-input'),
  requestAddBtn: document.getElementById('request-add-btn'),
  requestsList: document.getElementById('requests-list'),

  statRole: document.getElementById('stat-role'),
  statPeersReady: document.getElementById('stat-peers-ready'),
  statOffset: document.getElementById('stat-offset'),
  statRtt: document.getElementById('stat-rtt'),
  testPulseBtn: document.getElementById('test-pulse-btn'),
  resyncClockBtn: document.getElementById('resync-clock-btn'),

  offsetReadout: document.getElementById('offset-readout'),
  offsetSlider: document.getElementById('offset-slider'),
  nudgeButtons: [...document.querySelectorAll('.nudge-btn')],
  localRoleButtons: [...document.querySelectorAll('#local-role-group .role-btn')],
  toggleBassBtn: document.getElementById('toggle-bass-btn'),
  toggleLimiterBtn: document.getElementById('toggle-limiter-btn'),
  volumeSlider: document.getElementById('volume-slider'),
  volumeReadout: document.getElementById('volume-readout'),

  rosterCount: document.getElementById('roster-count'),
  rosterList: document.getElementById('roster-list'),

  qrModal: document.getElementById('qr-modal'),
  closeQrBtn: document.getElementById('close-qr-btn'),
  qrSvgContainer: document.getElementById('qr-svg-container'),
  lanIpField: document.getElementById('lan-ip-field'),
  lanIpSelect: document.getElementById('lan-ip-select'),
  inviteUrlInput: document.getElementById('invite-url-input'),
  copyLinkBtn: document.getElementById('copy-link-btn'),

  turnModal: document.getElementById('turn-modal'),
  closeTurnBtn: document.getElementById('close-turn-btn'),
  turnUrlInput: document.getElementById('turn-url-input'),
  turnUserInput: document.getElementById('turn-user-input'),
  turnPassInput: document.getElementById('turn-pass-input'),
  clearTurnBtn: document.getElementById('clear-turn-btn'),
  saveTurnBtn: document.getElementById('save-turn-btn'),
};

const state = {
  chosenRole: 'host',
  assignedRole: 'listener',
  roomCode: '',
  peerId: getOrCreatePeerId(),
  name: '',
  hostId: null,
  peers: [],
  hostPeerStates: new Map(),
  hostConnectionState: 'connecting',
  ws: null,
  joined: false,
  wakeLockActive: false,
  backgrounded: false,
  pulseSeq: 0,
  serverInfo: null,
  isSeekingTrack: false,
  lastTransferSig: '',
};

const audioSystem = new AudioSystem({
  onWakeLockChange: (active) => {
    state.wakeLockActive = active;
    updateWakeLockBadge();
    if (state.joined) {
      pushPeerMeta({ screenAwake: active });
    }
  },
  onVisibilityChange: (hidden) => {
    state.backgrounded = hidden;
    el.backgroundBanner.classList.toggle('hidden', !hidden);
    if (state.joined) {
      pushPeerMeta({ backgrounded: hidden });
    }
  },
});

const clockSync = new ClockSyncEngine();

const rtcMesh = new RTCMesh({
  sendSignal: (targetId, signalType, payload) => {
    sendWs({
      type: 'webrtc-signal',
      targetId,
      signalType,
      payload,
    });
  },
  onControlOpen: (peerId) => {
    if (state.assignedRole === 'listener') {
      clockSync.startSync(
        (msg) => rtcMesh.sendControlToPeer(peerId, msg),
        (syncInfo) => {
          el.statOffset.textContent = `${syncInfo.hostOffsetMs.toFixed(1)} ms`;
          el.statRtt.textContent = `${syncInfo.bestRttMs.toFixed(1)} ms`;
          pushPeerMeta({
            rttMs: syncInfo.bestRttMs,
            clockOffsetMs: syncInfo.hostOffsetMs,
            syncQuality: syncInfo.syncQuality,
          });
        }
      );
    } else if (state.assignedRole === 'host') {
      requestQueue.syncPeer(peerId);
      remoteTab.syncPeer(peerId);
    }
  },
  onControlMessage: async (peerId, msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'sync-beep') {
      flashPulseBox();
    }

    if (clockSync.handleIncomingMessage(peerId, msg, (target, reply) => rtcMesh.sendControlToPeer(target, reply), audioSystem)) {
      return;
    }

    if (filesTab.handleControlMessage(peerId, msg)) {
      return;
    }

    if (await castTab.handleControlMessage(peerId, msg)) {
      return;
    }

    if (remoteTab.handleControlMessage(peerId, msg)) {
      return;
    }

    if (requestQueue.handleControlMessage(peerId, msg)) {
      return;
    }

    if (msg.type === 'set-role' && typeof msg.channelRole === 'string') {
      setLocalChannelRole(msg.channelRole);
      return;
    }

    if (msg.type === 'force-resync' && state.assignedRole === 'listener') {
      clockSync.runBurst();
      return;
    }

    if (msg.type === 'request-sync-beep' && state.assignedRole === 'host') {
      triggerRoomSyncPulse();
    }
  },
  onAudioOpen: (peerId) => {
    filesTab.handlePeerAudioOpen(peerId);
  },
  onAudioData: (peerId, data) => {
    filesTab.handleAudioChunk(peerId, data);
  },
  onCastOpen: (peerId) => {
    castTab.handlePeerCastOpen(peerId);
  },
  onCastData: (peerId, data) => {
    castTab.handleCastPacket(peerId, data);
  },
  onPeerStateChange: (peerId, connState) => {
    if (state.assignedRole === 'host') {
      state.hostPeerStates.set(peerId, connState);
      updateMeshBadge();
      renderRoster();
    } else if (peerId === state.hostId) {
      state.hostConnectionState = connState;
      updateMeshBadge();
      pushPeerMeta({ connectionState: connState });
    }
  },
  onIsolationWarning: () => {
    el.isolationBanner.classList.remove('hidden');
  },
});

const filesTab = new FilesTabController({
  audioSystem,
  clockSync,
  rtcMesh,
  onStateChange: (ui) => renderFilesState(ui),
});

const castTab = new CastTabController({
  audioSystem,
  clockSync,
  rtcMesh,
  onStateChange: (ui) => renderCastState(ui),
});

const remoteTab = new RemoteTabController({
  clockSync,
  rtcMesh,
  mountElementId: 'yt-player-mount',
  onStateChange: (ui) => renderRemoteState(ui),
});

const requestQueue = new RequestQueueController({
  rtcMesh,
  onStateChange: (ui) => renderRequests(ui),
});

const visualizer = new SpectrumVisualizer({
  audioSystem,
  waveContainer: el.syncWave,
  canvas: el.spectrumCanvas,
});

function sendWs(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function pushPeerMeta(patch) {
  sendWs({
    type: 'peer-meta',
    ...patch,
  });
}

function showJoinError(message) {
  if (!message) {
    el.joinError.classList.add('hidden');
    el.joinError.textContent = '';
    return;
  }
  el.joinError.textContent = message;
  el.joinError.classList.remove('hidden');
}

function setJoinMode(mode) {
  state.chosenRole = mode === 'listener' ? 'listener' : 'host';
  el.modeHostBtn.classList.toggle('active', state.chosenRole === 'host');
  el.modeListenerBtn.classList.toggle('active', state.chosenRole === 'listener');
  el.randomCodeBtn.classList.toggle('hidden', state.chosenRole !== 'host');

  const currentName = el.nicknameInput.value.trim();
  if (!currentName || /^Host-|^Android-|^iPhone-|^Speaker-/.test(currentName)) {
    el.nicknameInput.value = defaultDeviceName(state.chosenRole === 'host');
  }
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('syncstage_theme', next);
  } catch {
    // Ignore storage errors
  }
  if (el.metaThemeColor) {
    el.metaThemeColor.setAttribute('content', next === 'light' ? '#fafafa' : '#121212');
  }
  if (el.themeToggleBtn) {
    el.themeToggleBtn.textContent = next === 'dark' ? '☀ Light' : '☾ Dark';
  }
  if (typeof visualizer !== 'undefined' && state.joined && !visualizer._active) {
    visualizer.drawIdleCanvas();
  }
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

function updateVisualizerState() {
  if (filesTab.isPlaying || castTab.isCasting || castTab.isReceiving) {
    visualizer.start();
  } else {
    visualizer.stop();
  }
}

function renderCastState(ui) {
  if (!el.castHostControls) return;
  el.castHostControls.classList.toggle('hidden', !ui.isHost);
  el.castCodecBadge.textContent = ui.codecLabel;
  el.castToggleBtn.textContent = ui.isCasting ? 'STOP CAST ■' : 'CAPTURE TAB AUDIO';
  el.castMonitorBtn.textContent = `Host Monitor: ${ui.monitorOnHost ? 'ON' : 'OFF'}`;
  el.castMonitorBtn.classList.toggle('active', ui.monitorOnHost);
  el.castMonitorBtn.setAttribute('aria-pressed', String(ui.monitorOnHost));
  el.castDelaySelect.value = String(ui.playoutDelayMs);

  if (ui.errorMessage) {
    el.castError.textContent = ui.errorMessage;
    el.castError.classList.remove('hidden');
  } else {
    el.castError.classList.add('hidden');
    el.castError.textContent = '';
  }

  if (ui.isCasting) {
    el.castStatusText.textContent =
      `Live casting (${ui.codecLabel}) · ${ui.packetsSent} frames sent · ${ui.playoutDelayMs} ms buffer`;
  } else if (ui.isReceiving) {
    el.castStatusText.textContent =
      `Receiving live (${ui.codecLabel}) · ${ui.packetsReceived} frames · ${ui.droppedLate} late`;
  } else {
    el.castStatusText.textContent =
      ui.statusMessage || (ui.isHost ? 'Idle — ready for live tab capture' : 'Waiting for Host to start Live Tab Cast');
  }

  updateVisualizerState();
}

function renderRemoteState(ui) {
  if (!el.remoteHostControls) return;
  el.remoteHostControls.classList.toggle('hidden', !ui.isHost);
  el.remotePlayerWrap.classList.toggle('hidden', !ui.hasVideo);

  if (ui.errorMessage) {
    el.remoteError.textContent = ui.errorMessage;
    el.remoteError.classList.remove('hidden');
  } else {
    el.remoteError.classList.add('hidden');
    el.remoteError.textContent = '';
  }

  el.remoteStatusText.textContent =
    ui.statusMessage || (ui.isHost ? 'Paste a YouTube or YT Music link above.' : 'Waiting for Host to load a YouTube video.');
}

function renderRequests(ui) {
  if (!el.requestsList) return;
  const items = ui.items || [];
  el.requestsCount.textContent = `${items.length} ${items.length === 1 ? 'request' : 'requests'}`;
  el.requestsList.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chalk-whisper-note';
    empty.style.marginTop = '4px';
    empty.textContent = 'No song requests yet — add one above.';
    el.requestsList.appendChild(empty);
    return;
  }

  for (const item of items) {
    const voted = Array.isArray(item.votes) && ui.selfId && item.votes.includes(ui.selfId);
    const voteCount = item.votes?.length || 0;
    const row = document.createElement('div');
    row.className = 'request-item';

    const query = encodeURIComponent(item.text);
    row.innerHTML = `
      <div class="request-main">
        <button class="upvote-btn ${voted ? 'voted' : ''}" type="button" data-upvote-id="${escapeHtml(item.id)}" aria-pressed="${voted ? 'true' : 'false'}">
          ▲ ${voteCount}
        </button>
        <div>
          <div class="request-text">${escapeHtml(item.text)}</div>
          <div class="request-by">by ${escapeHtml(item.byName || 'Guest')}</div>
        </div>
      </div>
      <div class="request-actions">
        ${
          ui.isHost
            ? `<a class="request-link" href="https://www.youtube.com/results?search_query=${query}" target="_blank" rel="noopener noreferrer">YT</a>
               <a class="request-link" href="https://open.spotify.com/search/${query}" target="_blank" rel="noopener noreferrer">Spotify</a>
               <button class="btn-ghost btn-xs" type="button" data-remove-req="${escapeHtml(item.id)}" aria-label="Remove request">×</button>`
            : ''
        }
      </div>
    `;
    el.requestsList.appendChild(row);
  }

  for (const btn of el.requestsList.querySelectorAll('[data-upvote-id]')) {
    btn.addEventListener('click', () => {
      requestQueue.toggleUpvote(btn.getAttribute('data-upvote-id'));
    });
  }

  for (const btn of el.requestsList.querySelectorAll('[data-remove-req]')) {
    btn.addEventListener('click', () => {
      requestQueue.removeRequest(btn.getAttribute('data-remove-req'));
    });
  }
}

function renderFilesState(ui) {
  if (!el.trackBar) return;

  const showBar = ui.hasTrack || Boolean(ui.statusMessage);
  el.trackBar.classList.toggle('hidden', !showBar);

  if (ui.hasTrack) {
    el.trackTitle.textContent = ui.trackName || 'Audio Track';
    el.transferProgressFill.style.width = `${ui.transferPercent}%`;

    if (ui.statusMessage) {
      el.trackStatus.textContent = ui.statusMessage;
    } else if (ui.transferPhase === 'sending') {
      el.trackStatus.textContent = `Sending ${ui.transferPercent}%`;
    } else if (ui.transferPhase === 'receiving') {
      el.trackStatus.textContent = `Receiving ${ui.transferPercent}%`;
    } else if (ui.transferPhase === 'decoding') {
      el.trackStatus.textContent = 'Decoding audio...';
    } else if (ui.isPlaying) {
      const driftAbs = Math.abs(ui.lastDriftMs || 0);
      const rateTag = ui.currentRate !== 1 ? ` · ${ui.currentRate.toFixed(3)}x` : '';
      el.trackStatus.textContent = `Locked ±${driftAbs.toFixed(0)} ms${rateTag}`;
    } else if (ui.isHost) {
      const openPeers = rtcMesh.getOpenAudioPeerIds();
      let readyCount = 0;
      for (const pid of openPeers) {
        if (ui.peerStates.get(pid)?.status === 'ready') readyCount++;
      }
      el.trackStatus.textContent =
        openPeers.length > 0
          ? `Ready (${readyCount}/${openPeers.length} speakers)`
          : 'Ready (Host only)';
    } else {
      el.trackStatus.textContent = 'Ready · Waiting for Host';
    }
  } else if (ui.statusMessage) {
    el.trackTitle.textContent = 'Preparing audio...';
    el.trackStatus.textContent = ui.statusMessage;
    el.transferProgressFill.style.width = '0%';
  }

  el.playPauseBtn.textContent = ui.isPlaying ? 'PAUSE ❚❚' : 'PLAY ▶';
  el.playPauseBtn.disabled = !ui.isHost || !ui.trackReady;
  el.trackSeekSlider.disabled = !ui.isHost || !ui.trackReady;
  el.loopToggleBtn.disabled = !ui.isHost || !ui.trackReady;
  el.loopToggleBtn.classList.toggle('active', ui.loop);

  el.trackTime.textContent = `${formatTime(ui.positionSec)} / ${formatTime(ui.durationSec)}`;
  if (!state.isSeekingTrack) {
    el.trackSeekSlider.max = String(ui.durationSec || 100);
    el.trackSeekSlider.value = String(ui.positionSec || 0);
  }

  updateVisualizerState();

  if (ui.isHost) {
    const sig = [...ui.peerStates.entries()]
      .map(([pid, st]) => `${pid}:${st.status}:${st.percent}`)
      .sort()
      .join('|');
    if (sig !== state.lastTransferSig) {
      state.lastTransferSig = sig;
      renderRoster();
    }
  }
}

function flashPulseBox() {
  el.pulseBox.classList.remove('flash');
  if (el.syncWave) el.syncWave.classList.remove('pulsing');
  void el.pulseBox.offsetWidth;
  el.pulseBox.classList.add('flash');
  if (el.syncWave) el.syncWave.classList.add('pulsing');
  setTimeout(() => {
    el.pulseBox.classList.remove('flash');
    if (el.syncWave) el.syncWave.classList.remove('pulsing');
  }, 350);
}

function updateWakeLockBadge() {
  if (state.wakeLockActive) {
    el.wakelockBadge.className = 'badge good';
    el.wakelockBadge.innerHTML = '<span class="dot"></span> Screen Awake';
  } else {
    el.wakelockBadge.className = 'badge warn';
    el.wakelockBadge.innerHTML = '<span class="dot"></span> Keep Screen On';
  }
}

function updateMeshBadge() {
  if (state.assignedRole === 'host') {
    const listeners = state.peers.filter((p) => p.role !== 'host');
    const connected = listeners.filter(
      (p) => state.hostPeerStates.get(p.peerId) === 'connected'
    ).length;

    el.statPeersReady.textContent = `${connected} / ${listeners.length}`;

    if (listeners.length === 0) {
      el.meshBadge.className = 'badge good';
      el.meshBadge.innerHTML = '<span class="dot"></span> Host Ready (0 speakers)';
    } else if (connected === listeners.length) {
      el.meshBadge.className = 'badge good';
      el.meshBadge.innerHTML = `<span class="dot"></span> ${connected}/${listeners.length} P2P Connected`;
    } else {
      el.meshBadge.className = 'badge warn';
      el.meshBadge.innerHTML = `<span class="dot"></span> ${connected}/${listeners.length} Connecting`;
    }
    return;
  }

  const s = state.hostConnectionState;
  const totalSpeakers = Math.max(0, state.peers.length - 1);
  el.statPeersReady.textContent = s === 'connected' ? `Host + ${totalSpeakers}` : 'Connecting';

  if (s === 'connected') {
    el.meshBadge.className = 'badge good';
    el.meshBadge.innerHTML = '<span class="dot"></span> P2P Connected';
    el.isolationBanner.classList.add('hidden');
  } else if (s === 'failed') {
    el.meshBadge.className = 'badge bad';
    el.meshBadge.innerHTML = '<span class="dot"></span> P2P Blocked';
  } else {
    el.meshBadge.className = 'badge warn';
    el.meshBadge.innerHTML = '<span class="dot"></span> Connecting P2P';
  }
}

function getPeerDisplayState(peer) {
  if (peer.role === 'host') {
    return { label: 'Host', cls: 'good' };
  }
  const raw =
    state.assignedRole === 'host'
      ? state.hostPeerStates.get(peer.peerId) || peer.meta?.connectionState || 'negotiating'
      : peer.meta?.connectionState || 'negotiating';

  if (raw === 'connected') return { label: 'P2P Connected', cls: 'good' };
  if (raw === 'failed') return { label: 'Blocked / Failed', cls: 'bad' };
  if (raw === 'reconnecting') return { label: 'Reconnecting', cls: 'warn' };
  if (raw === 'disconnected') return { label: 'Disconnected', cls: 'bad' };
  return { label: 'Negotiating...', cls: 'warn' };
}

function renderRoster() {
  el.rosterCount.textContent = `${state.peers.length} ${state.peers.length === 1 ? 'device' : 'devices'}`;
  el.rosterList.innerHTML = '';

  const sorted = [...state.peers].sort((a, b) => {
    if (a.role === 'host' && b.role !== 'host') return -1;
    if (b.role === 'host' && a.role !== 'host') return 1;
    return (a.joinedAt || 0) - (b.joinedAt || 0);
  });

  for (const peer of sorted) {
    const isSelf = peer.peerId === state.peerId;
    const isHostPeer = peer.role === 'host';
    const connBadge = getPeerDisplayState(peer);
    const meta = peer.meta || {};
    const rttText = isHostPeer
      ? '0.0 ms'
      : Number.isFinite(meta.rttMs)
        ? `${Number(meta.rttMs).toFixed(1)} ms`
        : '--';
    const offsetText = isHostPeer
      ? 'Master'
      : Number.isFinite(meta.clockOffsetMs)
        ? `${meta.clockOffsetMs >= 0 ? '+' : ''}${Number(meta.clockOffsetMs).toFixed(1)} ms`
        : '--';
    const roleLabel = (meta.channelRole || 'full').toUpperCase();
    const wakeHtml = meta.backgrounded
      ? '<span class="bg-alert-text">Backgrounded</span>'
      : meta.screenAwake
        ? 'Awake'
        : 'Unlocked';

    let transferLabel = '';
    if (state.assignedRole === 'host' && filesTab.currentFile && !isHostPeer) {
      const tState = filesTab.peerTransferState.get(peer.peerId);
      if (tState?.status === 'ready') transferLabel = 'Track: Ready';
      else if (tState?.status === 'decoding') transferLabel = 'Track: Decoding';
      else if (tState?.status === 'error') transferLabel = 'Track: Error';
      else if (tState) transferLabel = `Track: ${tState.percent}%`;
    }

    const row = document.createElement('div');
    row.className = 'roster-item';

    const canHostEditRole = state.assignedRole === 'host' && !isSelf;

    row.innerHTML = `
      <div class="roster-peer-main">
        <div class="roster-name-row">
          <span>${escapeHtml(peer.name)}</span>
          ${isHostPeer ? '<span class="tag host">Host</span>' : ''}
          ${isSelf ? '<span class="tag you">You</span>' : ''}
          <span class="badge ${connBadge.cls}"><span class="dot"></span> ${connBadge.label}</span>
        </div>
        <div class="roster-metrics">
          <span>RTT: ${rttText}</span>
          <span>Offset: ${offsetText}</span>
          <span>Role: ${escapeHtml(roleLabel)}</span>
          <span>Screen: ${wakeHtml}</span>
          ${transferLabel ? `<span>${escapeHtml(transferLabel)}</span>` : ''}
        </div>
      </div>
      <div class="roster-controls">
        ${
          canHostEditRole
            ? `<select class="role-select" data-peer-role="${escapeHtml(peer.peerId)}" aria-label="Assign speaker role">
                 <option value="full" ${meta.channelRole === 'full' ? 'selected' : ''}>Full</option>
                 <option value="left" ${meta.channelRole === 'left' ? 'selected' : ''}>Left</option>
                 <option value="right" ${meta.channelRole === 'right' ? 'selected' : ''}>Right</option>
                 <option value="center" ${meta.channelRole === 'center' ? 'selected' : ''}>Center</option>
               </select>`
            : `<span class="tag">${escapeHtml(roleLabel)}</span>`
        }
      </div>
    `;

    el.rosterList.appendChild(row);
  }

  for (const select of el.rosterList.querySelectorAll('select[data-peer-role]')) {
    select.addEventListener('change', (e) => {
      const targetId = e.target.getAttribute('data-peer-role');
      const nextRole = e.target.value;
      rtcMesh.sendControlToPeer(targetId, {
        type: 'set-role',
        channelRole: nextRole,
      });
    });
  }
}

function setLocalOffsetMs(ms) {
  const actual = audioSystem.setManualOffsetMs(ms);
  el.offsetSlider.value = String(actual);
  el.offsetReadout.textContent = `${actual > 0 ? '+' : ''}${actual} ms`;
  if (state.joined) {
    pushPeerMeta({ latencyOffsetMs: actual });
  }
}

function setLocalChannelRole(role) {
  const actual = audioSystem.setChannelRole(role);
  for (const btn of el.localRoleButtons) {
    btn.classList.toggle('active', btn.dataset.role === actual);
  }
  if (state.joined) {
    pushPeerMeta({ channelRole: actual });
  }
}

function triggerRoomSyncPulse() {
  const ctx = audioSystem.ensureContext();
  if (state.assignedRole === 'host') {
    const delayMs = 500;
    state.pulseSeq += 1;
    const hostStartTimeMs = performance.now() + delayMs;
    const freq = 880;
    rtcMesh.broadcastControl({
      type: 'sync-beep',
      hostStartTimeMs,
      freq,
      seq: state.pulseSeq,
    });
    audioSystem.scheduleSyncBeep(ctx.currentTime + delayMs / 1000, audioSystem.channelRole, freq);
    flashPulseBox();
    return;
  }

  // Listener: ask host to pulse everyone, or play local pulse if host isn't connected
  if (state.hostId && rtcMesh.getConnectionState(state.hostId) === 'connected') {
    rtcMesh.sendControlToPeer(state.hostId, { type: 'request-sync-beep' });
  } else {
    audioSystem.scheduleSyncBeep(ctx.currentTime + 0.25, audioSystem.channelRole, 880);
    flashPulseBox();
  }
}

async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    if (res.ok) {
      state.serverInfo = await res.json();
    }
  } catch {
    state.serverInfo = null;
  }
}

function buildInviteUrl() {
  const roomQuery = `?room=${encodeURIComponent(state.roomCode)}`;
  const isLocalHost =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocalHost && el.lanIpSelect.value) {
    return `${el.lanIpSelect.value}${roomQuery}`;
  }
  return `${location.origin}/${roomQuery}`;
}

function renderQrModal() {
  const lanIps = state.serverInfo?.lanIps || [];
  const isLocalHost =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if (isLocalHost && lanIps.length > 0) {
    el.lanIpField.classList.remove('hidden');
    if (el.lanIpSelect.options.length === 0) {
      const portPart = location.port ? `:${location.port}` : '';
      for (const ip of lanIps) {
        const opt = document.createElement('option');
        opt.value = `${location.protocol}//${ip}${portPart}`;
        opt.textContent = `${ip}${portPart}`;
        el.lanIpSelect.appendChild(opt);
      }
      const localhostOpt = document.createElement('option');
      localhostOpt.value = location.origin;
      localhostOpt.textContent = `${location.host} (this PC only)`;
      el.lanIpSelect.appendChild(localhostOpt);
    }
  } else {
    el.lanIpField.classList.add('hidden');
  }

  const inviteUrl = buildInviteUrl();
  el.inviteUrlInput.value = inviteUrl;
  el.qrSvgContainer.innerHTML = generateQrSvg(inviteUrl);
}

async function checkCastCapabilities() {
  const hasDisplayMedia = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
  let hasOpusEncoder = false;
  if (typeof AudioEncoder !== 'undefined' && AudioEncoder.isConfigSupported) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      hasOpusEncoder = Boolean(support?.supported);
    } catch {
      hasOpusEncoder = false;
    }
  }

  if (hasDisplayMedia && hasOpusEncoder) {
    el.castCapabilityText.textContent =
      "This browser supports Tab Audio Capture and WebCodecs Opus. Click CAPTURE TAB AUDIO and check 'Share tab audio'.";
  } else if (hasDisplayMedia) {
    el.castCapabilityText.textContent =
      "Tab Audio Capture is supported (will stream in PCM16 compatibility mode since WebCodecs Opus is unavailable).";
  } else {
    el.castCapabilityText.textContent =
      'Hosting Live Cast requires PC Chrome/Edge (getDisplayMedia unavailable on this device). Listeners only need a regular browser.';
  }
}

function enterRoomScreen() {
  const isHost = state.assignedRole === 'host';
  el.joinScreen.classList.add('hidden');
  el.roomScreen.classList.remove('hidden');
  el.roomNavControls.classList.remove('hidden');
  el.headerRoomCode.textContent = state.roomCode;
  el.statRole.textContent = isHost ? 'Host' : 'Speaker';
  el.statOffset.textContent = isHost ? '0.0 ms (Master)' : '--';
  el.statRtt.textContent = isHost ? '0.0 ms' : '--';
  el.testPulseBtn.textContent = 'SYNC PULSE';
  el.pickFileBtn.classList.toggle('hidden', !isHost);
  el.loadTestTrackBtn.classList.toggle('hidden', !isHost);
  el.fileDropHint.textContent = isHost
    ? 'Drop any MP3, WAV, FLAC, OGG, or M4A here — or tap Beat Test Track for instant 120 BPM calibration.'
    : 'Waiting for Host to share an audio file or Beat Test Track.';
  visualizer.drawIdleCanvas();
  renderFilesState(filesTab.getUiState());
  renderCastState(castTab.getUiState());
  renderRemoteState(remoteTab.getUiState());
  renderRequests({ items: requestQueue.items, selfId: state.peerId, isHost });
  updateWakeLockBadge();
  updateMeshBadge();
  checkCastCapabilities();
}

function leaveRoom() {
  state.joined = false;
  visualizer.stop();
  filesTab.reset();
  castTab.reset();
  remoteTab.reset();
  requestQueue.reset();
  clockSync.stopSync();
  rtcMesh.closeAll();
  if (state.ws) {
    try {
      state.ws.close(1000, 'User left');
    } catch {
      // ignore
    }
    state.ws = null;
  }
  state.peers = [];
  state.hostPeerStates.clear();
  state.hostId = null;
  state.lastTransferSig = '';
  el.isolationBanner.classList.add('hidden');
  el.hostLeftBanner.classList.add('hidden');
  el.roomNavControls.classList.add('hidden');
  el.roomScreen.classList.add('hidden');
  el.joinScreen.classList.remove('hidden');
  el.unlockJoinBtn.disabled = false;
  el.unlockJoinBtn.textContent = 'UNLOCK SPEAKER & JOIN →';
}

async function joinRoom() {
  showJoinError('');
  const rawCode = el.roomCodeInput.value.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(rawCode)) {
    showJoinError('Enter a 4–8 character room code using letters and numbers.');
    return;
  }

  const nickname = el.nicknameInput.value.trim() || defaultDeviceName(state.chosenRole === 'host');
  el.unlockJoinBtn.disabled = true;
  el.unlockJoinBtn.textContent = 'Unlocking Audio & Connecting...';

  try {
    await audioSystem.unlock();
  } catch (err) {
    showJoinError(`Could not unlock Web Audio: ${err.message}`);
    el.unlockJoinBtn.disabled = false;
    el.unlockJoinBtn.textContent = 'UNLOCK SPEAKER & JOIN →';
    return;
  }

  state.roomCode = rawCode;
  state.name = nickname;

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${location.host}/api/room/${encodeURIComponent(rawCode)}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    sendWs({
      type: 'join',
      peerId: state.peerId,
      name: state.name,
      role: state.chosenRole,
      userAgent: navigator.userAgent,
    });
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'welcome': {
        state.joined = true;
        state.assignedRole = msg.role;
        state.hostId = msg.hostId;
        state.peers = msg.peers || [];
        const isHost = state.assignedRole === 'host';

        clockSync.setHostMode(isHost);
        filesTab.setHostMode(isHost);
        castTab.setHostMode(isHost);
        remoteTab.setHostMode(isHost);
        requestQueue.setIdentity({
          selfId: state.peerId,
          selfName: state.name,
          isHost,
          hostId: state.hostId,
        });
        rtcMesh.setIdentity({ selfId: state.peerId, isHost });

        await fetchServerInfo();
        enterRoomScreen();
        pushPeerMeta({
          screenAwake: state.wakeLockActive,
          channelRole: audioSystem.channelRole,
          latencyOffsetMs: audioSystem.manualOffsetMs,
          volume: audioSystem.volume,
          connectionState: isHost ? 'host' : 'negotiating',
        });

        rtcMesh.syncRoster(state.peers, state.hostId);
        renderRoster();
        updateMeshBadge();
        break;
      }

      case 'roster': {
        const prevIds = new Set(state.peers.map((p) => p.peerId));
        state.hostId = msg.hostId;
        state.peers = msg.peers || [];
        requestQueue.setIdentity({ hostId: state.hostId });
        const currentIds = new Set(state.peers.map((p) => p.peerId));
        for (const oldId of prevIds) {
          if (!currentIds.has(oldId)) {
            filesTab.handlePeerDisconnected(oldId);
          }
        }
        el.hostLeftBanner.classList.toggle(
          'hidden',
          state.assignedRole === 'host' || Boolean(state.hostId)
        );
        rtcMesh.syncRoster(state.peers, state.hostId);
        updateMeshBadge();
        renderRoster();
        break;
      }

      case 'host-left': {
        if (state.assignedRole !== 'host') {
          el.hostLeftBanner.classList.remove('hidden');
          state.hostConnectionState = 'disconnected';
          updateMeshBadge();
        }
        break;
      }

      case 'webrtc-signal': {
        await rtcMesh.handleSignal(msg.fromId, msg.signalType, msg.payload);
        break;
      }

      case 'error': {
        showJoinError(msg.message || 'Signaling error');
        break;
      }

      default:
        break;
    }
  };

  ws.onerror = () => {
    if (!state.joined) {
      showJoinError('Could not connect to room signaling server.');
      el.unlockJoinBtn.disabled = false;
      el.unlockJoinBtn.textContent = 'UNLOCK SPEAKER & JOIN →';
    }
  };

  ws.onclose = () => {
    if (state.joined) {
      el.meshBadge.className = 'badge bad';
      el.meshBadge.innerHTML = '<span class="dot"></span> Signaling Disconnected';
    }
  };
}

function bindEvents() {
  if (el.themeToggleBtn) {
    el.themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  el.modeHostBtn.addEventListener('click', () => setJoinMode('host'));
  el.modeListenerBtn.addEventListener('click', () => setJoinMode('listener'));

  el.randomCodeBtn.addEventListener('click', () => {
    el.roomCodeInput.value = generateRoomCode(4);
  });

  el.roomCodeInput.addEventListener('input', () => {
    el.roomCodeInput.value = el.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  el.unlockJoinBtn.addEventListener('click', joinRoom);
  el.leaveRoomBtn.addEventListener('click', leaveRoom);

  for (const tabBtn of el.tabButtons) {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.tab;
      for (const btn of el.tabButtons) {
        btn.classList.toggle('active', btn.dataset.tab === target);
      }
      el.panelFiles.classList.toggle('hidden', target !== 'files');
      el.panelCast.classList.toggle('hidden', target !== 'cast');
      el.panelRemote.classList.toggle('hidden', target !== 'remote');
    });
  }

  el.testPulseBtn.addEventListener('click', triggerRoomSyncPulse);
  el.resyncClockBtn.addEventListener('click', () => {
    if (state.assignedRole === 'host') {
      rtcMesh.broadcastControl({ type: 'force-resync' });
    } else {
      clockSync.runBurst();
    }
  });

  el.pickFileBtn.addEventListener('click', () => {
    if (state.assignedRole === 'host') {
      el.fileInput.click();
    }
  });

  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      if (castTab.isCasting) castTab.stopCast();
      filesTab.loadLocalFile(file);
    }
    e.target.value = '';
  });

  el.loadTestTrackBtn.addEventListener('click', () => {
    if (castTab.isCasting) castTab.stopCast();
    filesTab.loadBuiltInTestTrack();
  });

  el.filesDropZone.addEventListener('dragover', (e) => {
    if (state.assignedRole !== 'host') return;
    e.preventDefault();
    el.filesDropZone.classList.add('dragover');
  });

  el.filesDropZone.addEventListener('dragleave', () => {
    el.filesDropZone.classList.remove('dragover');
  });

  el.filesDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.filesDropZone.classList.remove('dragover');
    if (state.assignedRole !== 'host') return;
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      if (castTab.isCasting) castTab.stopCast();
      filesTab.loadLocalFile(file);
    }
  });

  el.playPauseBtn.addEventListener('click', () => {
    if (filesTab.isPlaying) {
      filesTab.pause();
    } else {
      if (castTab.isCasting) castTab.stopCast();
      filesTab.play();
    }
  });

  el.castToggleBtn.addEventListener('click', async () => {
    if (castTab.isCasting) {
      castTab.stopCast();
    } else {
      if (filesTab.isPlaying) filesTab.pause();
      await castTab.startCast();
    }
  });

  el.castMonitorBtn.addEventListener('click', () => {
    castTab.setMonitorOnHost(!castTab.monitorOnHost);
  });

  el.castDelaySelect.addEventListener('change', (e) => {
    castTab.setPlayoutDelayMs(Number(e.target.value));
  });

  el.remoteLoadBtn.addEventListener('click', () => {
    remoteTab.loadVideo(el.remoteUrlInput.value);
  });

  el.remoteUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      remoteTab.loadVideo(el.remoteUrlInput.value);
    }
  });

  el.remoteSyncBtn.addEventListener('click', () => {
    remoteTab.forceSyncNow();
  });

  const submitSongRequest = () => {
    const val = el.requestInput.value.trim();
    if (!val) return;
    if (requestQueue.submitRequest(val)) {
      el.requestInput.value = '';
    }
  };

  el.requestAddBtn.addEventListener('click', submitSongRequest);
  el.requestInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSongRequest();
    }
  });

  el.trackSeekSlider.addEventListener('pointerdown', () => {
    state.isSeekingTrack = true;
  });

  el.trackSeekSlider.addEventListener('input', (e) => {
    state.isSeekingTrack = true;
    const pos = Number(e.target.value);
    const dur = filesTab.currentFile?.durationSec || 0;
    el.trackTime.textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
  });

  el.trackSeekSlider.addEventListener('change', (e) => {
    state.isSeekingTrack = false;
    filesTab.seek(Number(e.target.value));
  });

  el.loopToggleBtn.addEventListener('click', () => {
    filesTab.setLoop(!filesTab.loop);
  });

  el.toggleBassBtn.addEventListener('click', () => {
    const next = audioSystem.setBassBoost(!audioSystem.bassEnabled);
    el.toggleBassBtn.classList.toggle('active', next);
    el.toggleBassBtn.setAttribute('aria-pressed', String(next));
  });

  el.toggleLimiterBtn.addEventListener('click', () => {
    const next = audioSystem.setLimiter(!audioSystem.limiterEnabled);
    el.toggleLimiterBtn.classList.toggle('active', next);
    el.toggleLimiterBtn.setAttribute('aria-pressed', String(next));
  });

  el.offsetSlider.addEventListener('input', (e) => {
    setLocalOffsetMs(Number(e.target.value));
  });

  for (const btn of el.nudgeButtons) {
    btn.addEventListener('click', () => {
      const val = btn.dataset.nudge;
      if (val === 'reset') {
        setLocalOffsetMs(0);
      } else {
        setLocalOffsetMs(audioSystem.manualOffsetMs + Number(val));
      }
    });
  }

  for (const btn of el.localRoleButtons) {
    btn.addEventListener('click', () => {
      setLocalChannelRole(btn.dataset.role);
    });
  }

  el.volumeSlider.addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    el.volumeReadout.textContent = `${pct}%`;
    const vol = audioSystem.setVolume(pct / 100);
    if (state.joined) {
      pushPeerMeta({ volume: vol });
    }
  });

  el.openQrBtn.addEventListener('click', () => {
    renderQrModal();
    el.qrModal.classList.remove('hidden');
  });
  el.closeQrBtn.addEventListener('click', () => el.qrModal.classList.add('hidden'));
  el.qrModal.addEventListener('click', (e) => {
    if (e.target === el.qrModal) el.qrModal.classList.add('hidden');
  });
  el.lanIpSelect.addEventListener('change', renderQrModal);

  el.copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.inviteUrlInput.value);
      el.copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => {
        el.copyLinkBtn.textContent = 'Copy';
      }, 1500);
    } catch {
      el.inviteUrlInput.select();
      try {
        document.execCommand('copy');
        el.copyLinkBtn.textContent = 'Copied!';
        setTimeout(() => {
          el.copyLinkBtn.textContent = 'Copy';
        }, 1500);
      } catch {
        // User can copy selected text manually
      }
    }
  });

  el.openTurnBtn.addEventListener('click', () => el.turnModal.classList.remove('hidden'));
  el.closeTurnBtn.addEventListener('click', () => el.turnModal.classList.add('hidden'));
  el.turnModal.addEventListener('click', (e) => {
    if (e.target === el.turnModal) el.turnModal.classList.add('hidden');
  });

  el.retryP2pBtn.addEventListener('click', () => {
    el.isolationBanner.classList.add('hidden');
    if (state.assignedRole === 'host') {
      rtcMesh.reconnectAll();
    } else if (state.hostId) {
      sendWs({
        type: 'webrtc-signal',
        targetId: state.hostId,
        signalType: 'renegotiate-request',
        payload: {},
      });
    }
  });

  el.saveTurnBtn.addEventListener('click', () => {
    const urls = el.turnUrlInput.value.trim();
    if (urls) {
      rtcMesh.setTurnConfig({
        urls,
        username: el.turnUserInput.value.trim(),
        credential: el.turnPassInput.value,
      });
    } else {
      rtcMesh.setTurnConfig(null);
    }
    el.turnModal.classList.add('hidden');
    el.isolationBanner.classList.add('hidden');
    if (state.assignedRole === 'host') {
      rtcMesh.reconnectAll();
    } else if (state.hostId) {
      sendWs({
        type: 'webrtc-signal',
        targetId: state.hostId,
        signalType: 'renegotiate-request',
        payload: {},
      });
    }
  });

  el.clearTurnBtn.addEventListener('click', () => {
    el.turnUrlInput.value = '';
    el.turnUserInput.value = '';
    el.turnPassInput.value = '';
    rtcMesh.setTurnConfig(null);
    el.turnModal.classList.add('hidden');
  });
}

function init() {
  let savedTheme = 'dark';
  try {
    const stored = localStorage.getItem('syncstage_theme');
    if (stored === 'light' || stored === 'dark') savedTheme = stored;
  } catch {
    // ignore
  }
  applyTheme(savedTheme);

  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').trim().toUpperCase();

  if (ROOM_CODE_RE.test(urlRoom)) {
    el.roomCodeInput.value = urlRoom;
    setJoinMode('listener');
  } else {
    el.roomCodeInput.value = generateRoomCode(4);
    setJoinMode('host');
  }

  el.nicknameInput.value = defaultDeviceName(state.chosenRole === 'host');
  bindEvents();
}

init();
