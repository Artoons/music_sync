// Star-topology WebRTC DataChannel mesh with 6s Wi-Fi AP Isolation watchdog

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const ISOLATION_TIMEOUT_MS = 6000;

export class RTCMesh {
  constructor(options = {}) {
    this.selfId = options.selfId || null;
    this.isHost = Boolean(options.isHost);
    this.sendSignal = options.sendSignal || (() => {});
    this.onControlMessage = options.onControlMessage || (() => {});
    this.onAudioData = options.onAudioData || (() => {});
    this.onControlOpen = options.onControlOpen || (() => {});
    this.onAudioOpen = options.onAudioOpen || (() => {});
    this.onCastOpen = options.onCastOpen || (() => {});
    this.onCastData = options.onCastData || (() => {});
    this.onPeerStateChange = options.onPeerStateChange || (() => {});
    this.onIsolationWarning = options.onIsolationWarning || (() => {});

    this.turnServer = null;
    this.peers = new Map(); // peerId -> { pc, control, audio, watchdog, candidateQueue, remoteReady, state }
  }

  setIdentity({ selfId, isHost }) {
    this.selfId = selfId;
    this.isHost = Boolean(isHost);
  }

  setTurnConfig(turnConfig) {
    if (turnConfig && turnConfig.urls) {
      this.turnServer = {
        urls: turnConfig.urls,
        ...(turnConfig.username ? { username: turnConfig.username } : {}),
        ...(turnConfig.credential ? { credential: turnConfig.credential } : {}),
      };
    } else {
      this.turnServer = null;
    }
  }

  getIceServers() {
    if (this.turnServer) {
      return [...DEFAULT_ICE_SERVERS, this.turnServer];
    }
    return [...DEFAULT_ICE_SERVERS];
  }

  syncRoster(rosterPeers, hostId) {
    if (!this.selfId) return;

    if (this.isHost) {
      const listenerIds = new Set(
        rosterPeers
          .filter((p) => p.peerId !== this.selfId && p.role !== 'host')
          .map((p) => p.peerId)
      );

      for (const existingId of [...this.peers.keys()]) {
        if (!listenerIds.has(existingId)) {
          this.removePeer(existingId);
        }
      }

      for (const id of listenerIds) {
        if (!this.peers.has(id)) {
          this.connectToListener(id);
        }
      }
    } else if (hostId) {
      for (const existingId of [...this.peers.keys()]) {
        if (existingId !== hostId) {
          this.removePeer(existingId);
        }
      }
    }
  }

  createPeerEntry(peerId) {
    this.removePeer(peerId);

    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
    });

    const entry = {
      peerId,
      pc,
      control: null,
      audio: null,
      cast: null,
      candidateQueue: [],
      remoteReady: false,
      state: 'negotiating',
      watchdog: null,
    };

    this.peers.set(peerId, entry);
    this.onPeerStateChange(peerId, 'negotiating');

    entry.watchdog = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current) return;
      const connected =
        current.pc.connectionState === 'connected' ||
        current.pc.iceConnectionState === 'connected' ||
        current.pc.iceConnectionState === 'completed';
      if (!connected) {
        current.state = 'isolated';
        this.onPeerStateChange(peerId, 'failed');
        this.onIsolationWarning(peerId);
      }
    }, ISOLATION_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, 'ice', event.candidate.toJSON());
      }
    };

    const handleStateCheck = () => {
      const current = this.peers.get(peerId);
      if (!current) return;
      const connState = pc.connectionState;
      const iceState = pc.iceConnectionState;

      if (connState === 'connected' || iceState === 'connected' || iceState === 'completed') {
        if (current.watchdog) {
          clearTimeout(current.watchdog);
          current.watchdog = null;
        }
        if (current.state !== 'connected') {
          current.state = 'connected';
          this.onPeerStateChange(peerId, 'connected');
        }
      } else if (connState === 'failed' || iceState === 'failed') {
        if (current.watchdog) {
          clearTimeout(current.watchdog);
          current.watchdog = null;
        }
        current.state = 'failed';
        this.onPeerStateChange(peerId, 'failed');
        this.onIsolationWarning(peerId);
      } else if (connState === 'disconnected' || iceState === 'disconnected') {
        current.state = 'reconnecting';
        this.onPeerStateChange(peerId, 'reconnecting');
      }
    };

    pc.onconnectionstatechange = handleStateCheck;
    pc.oniceconnectionstatechange = handleStateCheck;

    return entry;
  }

  attachChannelHandlers(entry, channel) {
    if (channel.label === 'control') {
      entry.control = channel;
      channel.onopen = () => {
        if (entry.watchdog) {
          clearTimeout(entry.watchdog);
          entry.watchdog = null;
        }
        entry.state = 'connected';
        this.onPeerStateChange(entry.peerId, 'connected');
        this.onControlOpen(entry.peerId, channel);
      };
      channel.onclose = () => {
        if (this.peers.has(entry.peerId)) {
          this.onPeerStateChange(entry.peerId, 'disconnected');
        }
      };
      channel.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          this.onControlMessage(entry.peerId, msg);
        } catch {
          // Ignore malformed control payload
        }
      };
    } else if (channel.label === 'audio') {
      entry.audio = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = 65536;
      channel.onopen = () => {
        this.onAudioOpen(entry.peerId, channel);
      };
      channel.onmessage = (event) => {
        this.onAudioData(entry.peerId, event.data);
      };
    } else if (channel.label === 'cast') {
      entry.cast = channel;
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        this.onCastOpen(entry.peerId, channel);
      };
      channel.onmessage = (event) => {
        this.onCastData(entry.peerId, event.data);
      };
    }
  }

  async connectToListener(peerId) {
    const entry = this.createPeerEntry(peerId);
    const { pc } = entry;

    const control = pc.createDataChannel('control', { ordered: true });
    const audio = pc.createDataChannel('audio', { ordered: true });
    const cast = pc.createDataChannel('cast', { ordered: false, maxRetransmits: 0 });
    this.attachChannelHandlers(entry, control);
    this.attachChannelHandlers(entry, audio);
    this.attachChannelHandlers(entry, cast);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(peerId, 'offer', pc.localDescription.toJSON());
    } catch (err) {
      console.error('Failed creating WebRTC offer:', err);
      this.onPeerStateChange(peerId, 'failed');
    }
  }

  async handleSignal(fromId, signalType, payload) {
    if (!fromId || !signalType) return;

    if (signalType === 'renegotiate-request' && this.isHost) {
      await this.connectToListener(fromId);
      return;
    }

    if (signalType === 'offer') {
      const entry = this.createPeerEntry(fromId);
      const { pc } = entry;

      pc.ondatachannel = (event) => {
        this.attachChannelHandlers(entry, event.channel);
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        entry.remoteReady = true;
        await this.flushCandidateQueue(entry);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(fromId, 'answer', pc.localDescription.toJSON());
      } catch (err) {
        console.error('Failed handling WebRTC offer:', err);
        this.onPeerStateChange(fromId, 'failed');
      }
      return;
    }

    const entry = this.peers.get(fromId);
    if (!entry) return;

    if (signalType === 'answer') {
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(payload));
        entry.remoteReady = true;
        await this.flushCandidateQueue(entry);
      } catch (err) {
        console.error('Failed handling WebRTC answer:', err);
      }
      return;
    }

    if (signalType === 'ice' && payload) {
      if (!entry.remoteReady) {
        entry.candidateQueue.push(payload);
        return;
      }
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(payload));
      } catch {
        // Ignore stale ICE candidates
      }
    }
  }

  async flushCandidateQueue(entry) {
    while (entry.candidateQueue.length > 0) {
      const candidate = entry.candidateQueue.shift();
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore invalid ICE candidate
      }
    }
  }

  sendControlToPeer(peerId, obj) {
    const entry = this.peers.get(peerId);
    if (!entry || !entry.control || entry.control.readyState !== 'open') return false;
    try {
      entry.control.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  broadcastControl(obj) {
    const encoded = JSON.stringify(obj);
    let sent = 0;
    for (const entry of this.peers.values()) {
      if (entry.control && entry.control.readyState === 'open') {
        try {
          entry.control.send(encoded);
          sent++;
        } catch {
          // ignore
        }
      }
    }
    return sent;
  }

  sendAudioToPeer(peerId, arrayBuffer) {
    const entry = this.peers.get(peerId);
    if (!entry || !entry.audio || entry.audio.readyState !== 'open') return false;
    try {
      entry.audio.send(arrayBuffer);
      return true;
    } catch {
      return false;
    }
  }

  getOpenAudioPeerIds() {
    const ids = [];
    for (const entry of this.peers.values()) {
      if (entry.audio && entry.audio.readyState === 'open') {
        ids.push(entry.peerId);
      }
    }
    return ids;
  }

  async sendAudioChunkWithBackpressure(peerId, arrayBuffer, highWaterMark = 262144) {
    const entry = this.peers.get(peerId);
    const channel = entry?.audio;
    if (!channel || channel.readyState !== 'open') return false;

    if (channel.bufferedAmount > highWaterMark) {
      const drained = await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.removeEventListener('bufferedamountlow', onLow);
          channel.removeEventListener('close', onClose);
          resolve(ok);
        };
        const onLow = () => finish(true);
        const onClose = () => finish(false);
        const timer = setTimeout(() => {
          finish(channel.readyState === 'open' && channel.bufferedAmount <= highWaterMark * 2);
        }, 5000);

        channel.addEventListener('bufferedamountlow', onLow);
        channel.addEventListener('close', onClose);

        if (channel.bufferedAmount <= highWaterMark) {
          finish(true);
        }
      });
      if (!drained) return false;
    }

    if (channel.readyState !== 'open') return false;
    try {
      channel.send(arrayBuffer);
      return true;
    } catch {
      return false;
    }
  }

  broadcastAudio(arrayBuffer) {
    let sent = 0;
    for (const entry of this.peers.values()) {
      if (entry.audio && entry.audio.readyState === 'open') {
        try {
          entry.audio.send(arrayBuffer);
          sent++;
        } catch {
          // ignore
        }
      }
    }
    return sent;
  }

  broadcastCastPacket(arrayBuffer, maxBuffered = 65536) {
    let sent = 0;
    for (const entry of this.peers.values()) {
      const ch = entry.cast;
      if (ch && ch.readyState === 'open' && ch.bufferedAmount <= maxBuffered) {
        try {
          ch.send(arrayBuffer);
          sent++;
        } catch {
          // ignore
        }
      }
    }
    return sent;
  }

  reconnectPeer(peerId) {
    if (this.isHost) {
      this.connectToListener(peerId);
    }
  }

  reconnectAll() {
    if (!this.isHost) return;
    const ids = [...this.peers.keys()];
    for (const id of ids) {
      this.connectToListener(id);
    }
  }

  getConnectionState(peerId) {
    return this.peers.get(peerId)?.state || 'disconnected';
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    if (entry.watchdog) {
      clearTimeout(entry.watchdog);
    }
    try {
      entry.control?.close();
    } catch {
      // ignore
    }
    try {
      entry.audio?.close();
    } catch {
      // ignore
    }
    try {
      entry.cast?.close();
    } catch {
      // ignore
    }
    try {
      entry.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(peerId);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) {
      this.removePeer(id);
    }
  }
}
