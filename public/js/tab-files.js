// Release 2: P2P chunked file transfer, procedural 120 BPM test track, scheduled playback & 200ms drift corrector

import { BASE_DELAY_SEC } from './audio-dsp.js';

export const FILE_CHUNK_SIZE = 16384; // 16 KB binary slice
const CHUNK_HEADER_BYTES = 16;

/**
 * Packs a binary audio file slice with a 16-byte little-endian header:
 * [0..3] fileId, [4..7] chunkIndex, [8..11] totalChunks, [12..15] payloadLen
 */
export function packFileChunk(fileId, chunkIndex, totalChunks, payloadUint8) {
  const payload = payloadUint8 instanceof Uint8Array
    ? payloadUint8
    : new Uint8Array(payloadUint8);
  const buffer = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, fileId >>> 0, true);
  view.setUint32(4, chunkIndex >>> 0, true);
  view.setUint32(8, totalChunks >>> 0, true);
  view.setUint32(12, payload.byteLength >>> 0, true);
  new Uint8Array(buffer, CHUNK_HEADER_BYTES).set(payload);
  return buffer;
}

/**
 * Unpacks a 16-byte framed binary audio chunk.
 */
export function unpackFileChunk(arrayBuffer) {
  let buf;
  let baseOffset = 0;
  let totalLen = 0;

  if (arrayBuffer instanceof ArrayBuffer) {
    buf = arrayBuffer;
    totalLen = arrayBuffer.byteLength;
  } else if (ArrayBuffer.isView(arrayBuffer)) {
    buf = arrayBuffer.buffer;
    baseOffset = arrayBuffer.byteOffset;
    totalLen = arrayBuffer.byteLength;
  } else {
    throw new Error('Expected ArrayBuffer or ArrayBufferView');
  }

  if (totalLen < CHUNK_HEADER_BYTES) {
    throw new Error('Chunk smaller than 16-byte header');
  }

  const view = new DataView(buf, baseOffset, totalLen);
  const fileId = view.getUint32(0, true);
  const chunkIndex = view.getUint32(4, true);
  const totalChunks = view.getUint32(8, true);
  const payloadLen = view.getUint32(12, true);

  if (CHUNK_HEADER_BYTES + payloadLen > totalLen) {
    throw new Error('Truncated file chunk payload');
  }

  const payload = new Uint8Array(buf, baseOffset + CHUNK_HEADER_BYTES, payloadLen);
  return { fileId, chunkIndex, totalChunks, payload };
}

/**
 * Computes drift correction action with hysteresis:
 * - |errorMs| >= 80ms -> hard re-anchor seek
 * - |errorMs| >= 12ms (or >= 5ms while already nudging) -> gentle ±0.2% playbackRate nudge
 * - otherwise -> hold 1.000x
 */
export function computeDriftAdjustment(errorMs, wasNudging = false) {
  const absErr = Math.abs(errorMs);
  if (!Number.isFinite(errorMs)) {
    return { action: 'hold', rate: 1.0 };
  }
  if (absErr >= 80) {
    return { action: 'seek', rate: 1.0 };
  }
  if (absErr >= 12 || (wasNudging && absErr >= 5)) {
    return {
      action: 'nudge',
      rate: errorMs > 0 ? 0.998 : 1.002,
    };
  }
  return { action: 'hold', rate: 1.0 };
}

/**
 * Synthesizes an 8-second, 44.1 kHz, 16-bit Stereo PCM WAV track at 120 BPM:
 * - Sharp 2 kHz sync clicks on beats 1, 5, 9, 13
 * - Punchy kick + bassline (65-98 Hz) to showcase psychoacoustic bass harmonics
 * - Alternating L/R stereo plucks so Left/Right speaker assignments stand out
 */
export function generateTestTrackWav(options = {}) {
  const sampleRate = 44100;
  const durationSec = options.durationSec || 8;
  const numChannels = 2;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const dataByteLength = totalSamples * numChannels * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  const beatDuration = 0.5; // 120 BPM
  const bassNotes = [65.41, 65.41, 73.42, 82.41, 98.0, 82.41, 73.42, 65.41];
  const pluckNotes = [261.63, 329.63, 392.0, 523.25];

  let bytePos = 44;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const beatIdx = Math.floor(t / beatDuration);
    const beatTime = t - beatIdx * beatDuration;

    // Kick drum on every beat
    const kickEnv = Math.exp(-beatTime * 16);
    const kickFreq = 48 + 110 * Math.exp(-beatTime * 28);
    const kick = Math.sin(2 * Math.PI * kickFreq * beatTime) * kickEnv * 0.45;

    // Sub bassline
    const bassFreq = bassNotes[beatIdx % bassNotes.length];
    const bassEnv = Math.exp(-beatTime * 4.5);
    const bass =
      (Math.sin(2 * Math.PI * bassFreq * t) * 0.7 +
        Math.sin(2 * Math.PI * bassFreq * 2 * t) * 0.25) *
      bassEnv *
      0.34;

    // Sharp 2 kHz sync click on beats 1, 5, 9, 13
    let click = 0;
    if (beatIdx % 4 === 0 && beatTime < 0.03) {
      click = Math.sin(2 * Math.PI * 2000 * beatTime) * Math.exp(-beatTime * 150) * 0.52;
    }

    // Alternating L/R stereo pluck on offbeats / beats
    const pluckFreq = pluckNotes[beatIdx % pluckNotes.length];
    const pluckEnv = Math.exp(-beatTime * 9.5);
    const pluck =
      (Math.sin(2 * Math.PI * pluckFreq * t) +
        0.35 * Math.sin(2 * Math.PI * pluckFreq * 1.5 * t)) *
      pluckEnv *
      0.24;

    const panLeft = beatIdx % 2 === 0 ? 1.0 : 0.22;
    const panRight = beatIdx % 2 === 1 ? 1.0 : 0.22;

    const leftSample = Math.max(-0.96, Math.min(0.96, kick + bass + click + pluck * panLeft));
    const rightSample = Math.max(-0.96, Math.min(0.96, kick + bass + click + pluck * panRight));

    view.setInt16(bytePos, Math.round(leftSample * 32767), true);
    view.setInt16(bytePos + 2, Math.round(rightSample * 32767), true);
    bytePos += 4;
  }

  return {
    name: 'SyncStage_Beat_Test_120BPM.wav',
    mimeType: 'audio/wav',
    arrayBuffer: buffer,
    durationSec,
  };
}

export class FilesTabController {
  constructor({ audioSystem, clockSync, rtcMesh, onStateChange }) {
    this.audioSystem = audioSystem;
    this.clockSync = clockSync;
    this.rtcMesh = rtcMesh;
    this.onStateChange = onStateChange || (() => {});

    this.isHost = false;
    this._nextFileId = 1;
    this.currentFile = null; // { fileId, name, mimeType, arrayBuffer, audioBuffer, durationSec }
    this.peerTransferState = new Map(); // peerId -> { status, percent }
    this.incoming = null; // { fileId, name, mimeType, byteLength, totalChunks, receivedCount, chunks }
    this.pendingAnchor = null;

    this.isPlaying = false;
    this.loop = true;
    this.anchorTrackOffsetSec = 0;
    this.anchorHostTimeMs = 0;

    this.sourceNode = null;
    this.sourceGain = null;
    this.estimatedTrackPosSec = 0;
    this._scheduledStartAudioTime = 0;
    this._scheduledStartTrackSec = 0;
    this._lastTickAudioTime = 0;
    this.currentRate = 1.0;
    this.wasNudging = false;
    this.lastDriftMs = 0;
    this.statusMessage = '';

    this._monitorTimer = null;
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
    const durationSec = this.currentFile?.durationSec || 0;
    let transferPercent = 100;
    let transferPhase = 'idle';

    if (this.isHost && this.currentFile) {
      const openPeers = this.rtcMesh.getOpenAudioPeerIds();
      if (openPeers.length === 0) {
        transferPhase = 'ready';
        transferPercent = 100;
      } else {
        let sum = 0;
        let readyCount = 0;
        for (const pid of openPeers) {
          const st = this.peerTransferState.get(pid);
          if (st) {
            sum += st.percent || 0;
            if (st.status === 'ready') readyCount++;
          }
        }
        transferPercent = Math.round(sum / openPeers.length);
        transferPhase = readyCount === openPeers.length ? 'ready' : 'sending';
      }
    } else if (!this.isHost) {
      if (this.incoming && (!this.currentFile || this.incoming.fileId !== this.currentFile.fileId)) {
        transferPhase = this.incoming.decoding ? 'decoding' : 'receiving';
        transferPercent = this.incoming.totalChunks > 0
          ? Math.round((this.incoming.receivedCount / this.incoming.totalChunks) * 100)
          : 0;
      } else if (this.currentFile) {
        transferPhase = 'ready';
        transferPercent = 100;
      }
    }

    let displayPosSec = this.estimatedTrackPosSec;
    if (this.isPlaying && this.currentFile?.audioBuffer && this.audioSystem.audioCtx) {
      const nowAudio = this.audioSystem.audioCtx.currentTime;
      if (nowAudio < this._scheduledStartAudioTime + BASE_DELAY_SEC) {
        displayPosSec = this._scheduledStartTrackSec;
      } else {
        displayPosSec = this._normalizeOffset(this.estimatedTrackPosSec - BASE_DELAY_SEC);
      }
    }

    return {
      isHost: this.isHost,
      hasTrack: Boolean(this.currentFile || this.incoming),
      trackReady: Boolean(this.currentFile?.audioBuffer),
      trackName: this.currentFile?.name || this.incoming?.name || '',
      durationSec,
      positionSec: Math.min(durationSec, Math.max(0, displayPosSec)),
      isPlaying: this.isPlaying,
      loop: this.loop,
      transferPhase,
      transferPercent,
      lastDriftMs: this.lastDriftMs,
      currentRate: this.currentRate,
      statusMessage: this.statusMessage,
      peerStates: new Map(this.peerTransferState),
    };
  }

  _normalizeOffset(sec) {
    const duration = this.currentFile?.durationSec || 0;
    if (duration <= 0) return 0;
    if (this.loop) {
      return ((sec % duration) + duration) % duration;
    }
    return Math.max(0, Math.min(duration, sec));
  }

  async _decodeAudio(arrayBuffer) {
    const ctx = this.audioSystem.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  async loadLocalFile(file) {
    if (!this.isHost || !file) return;
    this.statusMessage = `Decoding ${file.name}...`;
    this.emitState();
    const arrayBuffer = await file.arrayBuffer();
    await this._loadHostBuffer({
      name: file.name || 'Audio Track',
      mimeType: file.type || 'audio/mpeg',
      arrayBuffer,
    });
  }

  async loadBuiltInTestTrack() {
    if (!this.isHost) return;
    this.statusMessage = 'Generating 120 BPM beat test track...';
    this.emitState();
    const wav = generateTestTrackWav();
    await this._loadHostBuffer(wav);
  }

  async _loadHostBuffer({ name, mimeType, arrayBuffer }) {
    this._stopPlaybackLocal(true);
    this.isPlaying = false;
    this.anchorTrackOffsetSec = 0;
    this.estimatedTrackPosSec = 0;

    let audioBuffer;
    try {
      audioBuffer = await this._decodeAudio(arrayBuffer);
    } catch (err) {
      this.statusMessage = `Decode failed: ${err?.message || 'Unsupported format'}`;
      this.emitState();
      return;
    }

    const fileId = this._nextFileId++;
    this.currentFile = {
      fileId,
      name,
      mimeType,
      arrayBuffer,
      audioBuffer,
      durationSec: audioBuffer.duration,
    };
    this.peerTransferState.clear();
    this.statusMessage = '';
    this.emitState();

    const peerIds = this.rtcMesh.getOpenAudioPeerIds();
    for (const pid of peerIds) {
      this.sendFileToPeer(pid);
    }
  }

  async sendFileToPeer(peerId) {
    if (!this.isHost || !this.currentFile) return;
    const file = this.currentFile;
    const totalBytes = file.arrayBuffer.byteLength;
    const totalChunks = Math.max(1, Math.ceil(totalBytes / FILE_CHUNK_SIZE));

    this.peerTransferState.set(peerId, { status: 'sending', percent: 0 });
    this.emitState();

    const sentMeta = this.rtcMesh.sendControlToPeer(peerId, {
      type: 'file-meta',
      fileId: file.fileId,
      name: file.name,
      mimeType: file.mimeType,
      byteLength: totalBytes,
      totalChunks,
      durationSec: file.durationSec,
    });

    if (!sentMeta) {
      this.peerTransferState.set(peerId, { status: 'error', percent: 0 });
      this.emitState();
      return;
    }

    const bytes = new Uint8Array(file.arrayBuffer);
    for (let idx = 0; idx < totalChunks; idx++) {
      if (!this.currentFile || this.currentFile.fileId !== file.fileId) {
        return;
      }
      const start = idx * FILE_CHUNK_SIZE;
      const end = Math.min(totalBytes, start + FILE_CHUNK_SIZE);
      const packet = packFileChunk(file.fileId, idx, totalChunks, bytes.subarray(start, end));
      const ok = await this.rtcMesh.sendAudioChunkWithBackpressure(peerId, packet);
      if (!ok) {
        this.peerTransferState.set(peerId, { status: 'error', percent: Math.round((idx / totalChunks) * 100) });
        this.emitState();
        return;
      }
      const pct = Math.round(((idx + 1) / totalChunks) * 100);
      const existing = this.peerTransferState.get(peerId);
      if (existing && existing.status !== 'ready') {
        existing.percent = pct;
        if ((idx + 1) % 8 === 0 || idx + 1 === totalChunks) {
          this.emitState();
        }
      }
    }

    const latest = this.peerTransferState.get(peerId);
    if (latest && latest.status === 'sending') {
      latest.status = 'decoding';
      latest.percent = 100;
      this.emitState();
    }

    if (this.isPlaying) {
      this.rtcMesh.sendControlToPeer(peerId, {
        type: 'file-sync-beacon',
        fileId: file.fileId,
        isPlaying: true,
        anchorTrackOffsetSec: this.anchorTrackOffsetSec,
        anchorHostTimeMs: this.anchorHostTimeMs,
        loop: this.loop,
      });
    }
  }

  handlePeerAudioOpen(peerId) {
    if (this.isHost && this.currentFile) {
      this.sendFileToPeer(peerId);
    }
  }

  handlePeerDisconnected(peerId) {
    if (this.peerTransferState.delete(peerId)) {
      this.emitState();
    }
  }

  play(offsetSec = this.estimatedTrackPosSec) {
    if (!this.isHost || !this.currentFile?.audioBuffer) return;
    const startOffset = this._normalizeOffset(offsetSec);
    const startHostTimeMs = performance.now() + 650;

    this.isPlaying = true;
    this.anchorTrackOffsetSec = startOffset;
    this.anchorHostTimeMs = startHostTimeMs;
    this.estimatedTrackPosSec = startOffset;

    this.rtcMesh.broadcastControl({
      type: 'file-play',
      fileId: this.currentFile.fileId,
      anchorTrackOffsetSec: startOffset,
      anchorHostTimeMs: startHostTimeMs,
      loop: this.loop,
    });

    const ctx = this.audioSystem.ensureContext();
    const speakerTime = this.clockSync.hostTimeToLocalAudioTime(startHostTimeMs, ctx);
    this._startLocalSource(startOffset, speakerTime, false);
    this._startHostBeacon();
    this._startMonitorLoop();
    this.emitState();
  }

  pause() {
    if (!this.isHost || !this.currentFile) return;
    const pos = this._computeCurrentTargetSec();
    this.isPlaying = false;
    this.anchorTrackOffsetSec = pos;
    this.estimatedTrackPosSec = pos;
    this._stopPlaybackLocal(false);
    this._stopHostBeacon();

    this.rtcMesh.broadcastControl({
      type: 'file-pause',
      fileId: this.currentFile.fileId,
      positionSec: pos,
    });
    this.emitState();
  }

  seek(offsetSec) {
    if (!this.isHost || !this.currentFile?.audioBuffer) return;
    const target = this._normalizeOffset(offsetSec);
    if (this.isPlaying) {
      const startHostTimeMs = performance.now() + 350;
      this.anchorTrackOffsetSec = target;
      this.anchorHostTimeMs = startHostTimeMs;
      this.estimatedTrackPosSec = target;

      this.rtcMesh.broadcastControl({
        type: 'file-seek',
        fileId: this.currentFile.fileId,
        isPlaying: true,
        anchorTrackOffsetSec: target,
        anchorHostTimeMs: startHostTimeMs,
        loop: this.loop,
      });

      const ctx = this.audioSystem.ensureContext();
      const speakerTime = this.clockSync.hostTimeToLocalAudioTime(startHostTimeMs, ctx);
      this._startLocalSource(target, speakerTime, true);
    } else {
      this.anchorTrackOffsetSec = target;
      this.estimatedTrackPosSec = target;
      this.rtcMesh.broadcastControl({
        type: 'file-seek',
        fileId: this.currentFile.fileId,
        isPlaying: false,
        anchorTrackOffsetSec: target,
        anchorHostTimeMs: performance.now(),
        loop: this.loop,
      });
    }
    this.emitState();
  }

  setLoop(enabled) {
    this.loop = Boolean(enabled);
    if (this.sourceNode) {
      this.sourceNode.loop = this.loop;
    }
    if (this.isHost && this.currentFile) {
      this.rtcMesh.broadcastControl({
        type: 'file-loop',
        fileId: this.currentFile.fileId,
        loop: this.loop,
      });
    }
    this.emitState();
  }

  _startHostBeacon() {
    this._stopHostBeacon();
    this._beaconTimer = setInterval(() => {
      if (!this.isHost || !this.isPlaying || !this.currentFile) return;
      this.rtcMesh.broadcastControl({
        type: 'file-sync-beacon',
        fileId: this.currentFile.fileId,
        isPlaying: true,
        anchorTrackOffsetSec: this.anchorTrackOffsetSec,
        anchorHostTimeMs: this.anchorHostTimeMs,
        loop: this.loop,
      });
    }, 2000);
  }

  _stopHostBeacon() {
    if (this._beaconTimer) {
      clearInterval(this._beaconTimer);
      this._beaconTimer = null;
    }
  }

  handleControlMessage(peerId, msg) {
    if (!msg || typeof msg !== 'object') return false;

    if (this.isHost) {
      if (msg.type === 'file-progress' && this.currentFile && msg.fileId === this.currentFile.fileId) {
        const entry = this.peerTransferState.get(peerId) || { status: 'receiving', percent: 0 };
        entry.status = msg.status || 'receiving';
        entry.percent = Number(msg.percent) || 0;
        this.peerTransferState.set(peerId, entry);
        this.emitState();
        return true;
      }
      if (msg.type === 'file-ready' && this.currentFile && msg.fileId === this.currentFile.fileId) {
        this.peerTransferState.set(peerId, { status: 'ready', percent: 100 });
        this.emitState();
        return true;
      }
      if (msg.type === 'file-error' && this.currentFile && msg.fileId === this.currentFile.fileId) {
        this.peerTransferState.set(peerId, { status: 'error', percent: 0 });
        this.emitState();
        return true;
      }
      return false;
    }

    // Listener control messages
    switch (msg.type) {
      case 'file-meta': {
        this._stopPlaybackLocal(true);
        this.isPlaying = false;
        this.pendingAnchor = null;
        this.currentFile = null;
        this.estimatedTrackPosSec = 0;
        this.statusMessage = `Receiving ${msg.name}...`;
        this.incoming = {
          fileId: msg.fileId,
          name: msg.name,
          mimeType: msg.mimeType || 'audio/mpeg',
          byteLength: msg.byteLength,
          totalChunks: msg.totalChunks,
          durationSec: msg.durationSec || 0,
          receivedCount: 0,
          lastReportedPct: -1,
          decoding: false,
          chunks: new Array(msg.totalChunks),
          hostPeerId: peerId,
        };
        this.emitState();
        return true;
      }

      case 'file-play':
      case 'file-seek':
      case 'file-sync-beacon': {
        if (typeof msg.loop === 'boolean') {
          this.loop = msg.loop;
        }
        const activeId = this.currentFile?.fileId ?? this.incoming?.fileId;
        if (activeId !== msg.fileId) return true;

        const shouldPlay = msg.type === 'file-play' ? true : Boolean(msg.isPlaying);
        this.anchorTrackOffsetSec = msg.anchorTrackOffsetSec || 0;
        this.anchorHostTimeMs = msg.anchorHostTimeMs || 0;

        if (!this.currentFile?.audioBuffer) {
          this.pendingAnchor = {
            fileId: msg.fileId,
            isPlaying: shouldPlay,
            anchorTrackOffsetSec: this.anchorTrackOffsetSec,
            anchorHostTimeMs: this.anchorHostTimeMs,
            loop: this.loop,
          };
          return true;
        }

        if (shouldPlay) {
          const alreadyPlayingSame = this.isPlaying && msg.type === 'file-sync-beacon' && this.sourceNode;
          this.isPlaying = true;
          if (!alreadyPlayingSame) {
            const ctx = this.audioSystem.ensureContext();
            const speakerTime = this.clockSync.hostTimeToLocalAudioTime(this.anchorHostTimeMs, ctx);
            this._startLocalSource(this.anchorTrackOffsetSec, speakerTime, msg.type === 'file-seek');
            this._startMonitorLoop();
          } else if (this.sourceNode) {
            this.sourceNode.loop = this.loop;
          }
        } else {
          this.isPlaying = false;
          this.estimatedTrackPosSec = this._normalizeOffset(this.anchorTrackOffsetSec);
          this._stopPlaybackLocal(false);
        }
        this.emitState();
        return true;
      }

      case 'file-pause': {
        if (this.currentFile && msg.fileId === this.currentFile.fileId) {
          this.isPlaying = false;
          this.anchorTrackOffsetSec = this._normalizeOffset(msg.positionSec ?? this.estimatedTrackPosSec);
          this.estimatedTrackPosSec = this.anchorTrackOffsetSec;
          this._stopPlaybackLocal(false);
          this.emitState();
        } else if (this.pendingAnchor && msg.fileId === this.pendingAnchor.fileId) {
          this.pendingAnchor.isPlaying = false;
          this.pendingAnchor.anchorTrackOffsetSec = msg.positionSec || 0;
        }
        return true;
      }

      case 'file-loop': {
        if (this.currentFile && msg.fileId === this.currentFile.fileId) {
          this.loop = Boolean(msg.loop);
          if (this.sourceNode) this.sourceNode.loop = this.loop;
          this.emitState();
        }
        return true;
      }

      default:
        return false;
    }
  }

  async handleAudioChunk(peerId, rawData) {
    if (this.isHost || !this.incoming) return;
    let parsed;
    try {
      parsed = unpackFileChunk(rawData);
    } catch {
      return;
    }

    const inc = this.incoming;
    if (parsed.fileId !== inc.fileId || parsed.chunkIndex >= inc.totalChunks) return;

    if (!inc.chunks[parsed.chunkIndex]) {
      inc.chunks[parsed.chunkIndex] = new Uint8Array(parsed.payload);
      inc.receivedCount += 1;
    }

    const pct = Math.round((inc.receivedCount / inc.totalChunks) * 100);
    if (pct - inc.lastReportedPct >= 5 || inc.receivedCount === inc.totalChunks) {
      inc.lastReportedPct = pct;
      this.rtcMesh.sendControlToPeer(peerId, {
        type: 'file-progress',
        fileId: inc.fileId,
        status: inc.receivedCount === inc.totalChunks ? 'decoding' : 'receiving',
        percent: pct,
      });
      this.emitState();
    }

    if (inc.receivedCount === inc.totalChunks && !inc.decoding) {
      inc.decoding = true;
      this.statusMessage = `Decoding ${inc.name}...`;
      this.emitState();

      const full = new Uint8Array(inc.byteLength);
      let writeOffset = 0;
      for (let i = 0; i < inc.totalChunks; i++) {
        const piece = inc.chunks[i];
        if (!piece) {
          inc.decoding = false;
          this.statusMessage = 'Transfer incomplete';
          this.emitState();
          return;
        }
        full.set(piece, writeOffset);
        writeOffset += piece.byteLength;
      }

      try {
        const audioBuffer = await this._decodeAudio(full.buffer);
        if (!this.incoming || this.incoming.fileId !== inc.fileId) return;

        this.currentFile = {
          fileId: inc.fileId,
          name: inc.name,
          mimeType: inc.mimeType,
          arrayBuffer: full.buffer,
          audioBuffer,
          durationSec: audioBuffer.duration,
        };
        this.incoming = null;
        this.statusMessage = '';

        this.rtcMesh.sendControlToPeer(peerId, {
          type: 'file-ready',
          fileId: this.currentFile.fileId,
        });

        if (this.pendingAnchor && this.pendingAnchor.fileId === this.currentFile.fileId) {
          const anchor = this.pendingAnchor;
          this.pendingAnchor = null;
          this.loop = Boolean(anchor.loop);
          this.anchorTrackOffsetSec = anchor.anchorTrackOffsetSec;
          this.anchorHostTimeMs = anchor.anchorHostTimeMs;
          if (anchor.isPlaying) {
            this.isPlaying = true;
            const ctx = this.audioSystem.ensureContext();
            const speakerTime = this.clockSync.hostTimeToLocalAudioTime(this.anchorHostTimeMs, ctx);
            this._startLocalSource(this.anchorTrackOffsetSec, speakerTime, true);
            this._startMonitorLoop();
          } else {
            this.estimatedTrackPosSec = this._normalizeOffset(this.anchorTrackOffsetSec);
          }
        }
        this.emitState();
      } catch (err) {
        this.statusMessage = `Decode failed: ${err?.message || 'error'}`;
        this.rtcMesh.sendControlToPeer(peerId, {
          type: 'file-error',
          fileId: inc.fileId,
        });
        this.emitState();
      }
    }
  }

  _startLocalSource(trackOffsetSec, speakerTargetAudioTime, fadeIn = false) {
    if (!this.currentFile?.audioBuffer) return;
    const ctx = this.audioSystem.ensureContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    this._stopSourceNodeOnly();

    const buffer = this.currentFile.audioBuffer;
    const duration = buffer.duration;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = this.loop;

    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(this.audioSystem.getInputNode());

    const rawStart = speakerTargetAudioTime - BASE_DELAY_SEC;
    let startAt = rawStart;
    let offset = this._normalizeOffset(trackOffsetSec);

    if (rawStart < ctx.currentTime + 0.02) {
      startAt = ctx.currentTime + 0.03;
      const elapsed = startAt - rawStart;
      if (!this.loop && offset + elapsed >= duration) {
        this.isPlaying = false;
        this.estimatedTrackPosSec = 0;
        this.emitState();
        return;
      }
      offset = this._normalizeOffset(offset + elapsed);
    }

    if (fadeIn) {
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1.0, startAt + 0.01);
    } else {
      gain.gain.setValueAtTime(1.0, startAt);
    }

    src.onended = () => {
      if (this.sourceNode === src && !this.loop && this.isPlaying) {
        this.isPlaying = false;
        this.estimatedTrackPosSec = 0;
        this.anchorTrackOffsetSec = 0;
        this._stopMonitorLoop();
        this._stopHostBeacon();
        this.emitState();
      }
    };

    src.start(startAt, offset);

    this.sourceNode = src;
    this.sourceGain = gain;
    this._scheduledStartAudioTime = startAt;
    this._scheduledStartTrackSec = offset;
    this.estimatedTrackPosSec = offset;
    this._lastTickAudioTime = startAt;
    this.currentRate = 1.0;
    this.wasNudging = false;
    this.lastDriftMs = 0;
  }

  _computeCurrentTargetSec() {
    if (!this.currentFile?.audioBuffer) return 0;
    const elapsedMs = this.clockSync.getHostNowMs() - this.anchorHostTimeMs;
    if (elapsedMs <= 0) {
      return this._normalizeOffset(this.anchorTrackOffsetSec);
    }
    return this._normalizeOffset(this.anchorTrackOffsetSec + elapsedMs / 1000);
  }

  _startMonitorLoop() {
    this._stopMonitorLoop();
    this._monitorTimer = setInterval(() => {
      this._runDriftTick();
    }, 200);
  }

  _stopMonitorLoop() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  _runDriftTick() {
    if (!this.isPlaying || !this.sourceNode || !this.currentFile?.audioBuffer) return;
    const ctx = this.audioSystem.ensureContext();
    const nowAudio = ctx.currentTime;
    const duration = this.currentFile.durationSec;

    if (nowAudio <= this._scheduledStartAudioTime) {
      this.estimatedTrackPosSec = this._scheduledStartTrackSec;
      this.emitState();
      return;
    }

    const dt = Math.max(0, nowAudio - this._lastTickAudioTime);
    this._lastTickAudioTime = nowAudio;
    this.estimatedTrackPosSec = this._normalizeOffset(
      this.estimatedTrackPosSec + dt * this.currentRate
    );

    const rawAnchorAudio =
      this.clockSync.hostTimeToLocalAudioTime(this.anchorHostTimeMs, ctx) - BASE_DELAY_SEC;
    const targetRaw = this.anchorTrackOffsetSec + (nowAudio - rawAnchorAudio);

    if (!this.loop && targetRaw >= duration) {
      this.isPlaying = false;
      this.estimatedTrackPosSec = 0;
      this._stopPlaybackLocal(false);
      this._stopHostBeacon();
      this.emitState();
      return;
    }

    const targetPosSec = this._normalizeOffset(targetRaw);
    let diffSec = this.estimatedTrackPosSec - targetPosSec;
    if (this.loop && duration > 0) {
      if (diffSec > duration / 2) diffSec -= duration;
      else if (diffSec < -duration / 2) diffSec += duration;
    }

    const errorMs = diffSec * 1000;
    this.lastDriftMs = errorMs;

    const adj = computeDriftAdjustment(errorMs, this.wasNudging);
    if (adj.action === 'seek') {
      const speakerTime = this.clockSync.hostTimeToLocalAudioTime(this.anchorHostTimeMs, ctx);
      this._startLocalSource(this.anchorTrackOffsetSec, speakerTime, true);
    } else if (adj.action === 'nudge') {
      this.wasNudging = true;
      this.currentRate = adj.rate;
      this.sourceNode.playbackRate.setTargetAtTime(adj.rate, nowAudio, 0.04);
    } else {
      this.wasNudging = false;
      if (this.currentRate !== 1.0) {
        this.currentRate = 1.0;
        this.sourceNode.playbackRate.setTargetAtTime(1.0, nowAudio, 0.04);
      }
    }

    this.emitState();
  }

  _stopSourceNodeOnly() {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
      } catch {
        // ignore if already stopped
      }
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.sourceGain) {
      try {
        this.sourceGain.disconnect();
      } catch {
        // ignore
      }
      this.sourceGain = null;
    }
  }

  _stopPlaybackLocal(resetDrift = false) {
    this._stopSourceNodeOnly();
    this._stopMonitorLoop();
    this.currentRate = 1.0;
    this.wasNudging = false;
    if (resetDrift) {
      this.lastDriftMs = 0;
    }
  }

  reset() {
    this._stopPlaybackLocal(true);
    this._stopHostBeacon();
    this.isPlaying = false;
    this.currentFile = null;
    this.incoming = null;
    this.pendingAnchor = null;
    this.peerTransferState.clear();
    this.anchorTrackOffsetSec = 0;
    this.anchorHostTimeMs = 0;
    this.estimatedTrackPosSec = 0;
    this.statusMessage = '';
    this.emitState();
  }
}
