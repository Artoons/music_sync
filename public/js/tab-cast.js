// Release 3: Live PC Tab Audio Cast via AudioWorklet, WebCodecs Opus / PCM16, and fixed-delay Web Audio playout

import { BASE_DELAY_SEC } from './audio-dsp.js';

export const CAST_CODEC_OPUS = 1;
export const CAST_CODEC_PCM16 = 2;
export const CAST_HEADER_BYTES = 20;

const WORKLET_URL = '/js/pcm-capture-worklet.js';

export function packCastFrame({
  streamId,
  seq,
  captureHostTimeMs,
  codecId,
  channels = 2,
  sampleRate = 48000,
  payload,
}) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buffer = new ArrayBuffer(CAST_HEADER_BYTES + bytes.byteLength);
  const view = new DataView(buffer);

  view.setUint32(0, streamId >>> 0, true);
  view.setUint32(4, seq >>> 0, true);
  view.setFloat64(8, Number(captureHostTimeMs) || 0, true);
  view.setUint8(16, codecId & 0xff);
  view.setUint8(17, channels & 0xff);
  view.setUint16(18, Math.round((sampleRate || 48000) / 100), true);

  new Uint8Array(buffer, CAST_HEADER_BYTES).set(bytes);
  return buffer;
}

export function unpackCastFrame(arrayBuffer) {
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

  if (totalLen < CAST_HEADER_BYTES) {
    throw new Error('Cast packet shorter than 20-byte header');
  }

  const view = new DataView(buf, baseOffset, totalLen);
  const streamId = view.getUint32(0, true);
  const seq = view.getUint32(4, true);
  const captureHostTimeMs = view.getFloat64(8, true);
  const codecId = view.getUint8(16);
  const channels = view.getUint8(17);
  const sampleRate = view.getUint16(18, true) * 100;
  const payload = new Uint8Array(buf, baseOffset + CAST_HEADER_BYTES, totalLen - CAST_HEADER_BYTES);

  return {
    streamId,
    seq,
    captureHostTimeMs,
    codecId,
    channels,
    sampleRate,
    payload,
  };
}

export function float32StereoToInt16Interleaved(left, right) {
  const len = Math.min(left.length, right.length);
  const out = new Int16Array(len * 2);
  for (let i = 0; i < len; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    out[i * 2] = l < 0 ? Math.round(l * 32768) : Math.round(l * 32767);
    out[i * 2 + 1] = r < 0 ? Math.round(r * 32768) : Math.round(r * 32767);
  }
  return out;
}

export function int16InterleavedToFloat32Stereo(input) {
  let int16;
  if (input instanceof Int16Array) {
    int16 = input;
  } else if (ArrayBuffer.isView(input)) {
    if (input.byteOffset % 2 === 0) {
      int16 = new Int16Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 2));
    } else {
      const copy = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      int16 = new Int16Array(copy);
    }
  } else {
    int16 = new Int16Array(input);
  }

  const frames = Math.floor(int16.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = int16[i * 2] / 32768;
    right[i] = int16[i * 2 + 1] / 32768;
  }
  return { left, right };
}

export function computeCastPlayoutAudioTime(captureHostTimeMs, playoutDelayMs, clockSync, audioCtx) {
  const targetHostTimeMs = captureHostTimeMs + playoutDelayMs;
  return clockSync.hostTimeToLocalAudioTime(targetHostTimeMs, audioCtx) - BASE_DELAY_SEC;
}

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class CastTabController {
  constructor({ audioSystem, clockSync, rtcMesh, onStateChange }) {
    this.audioSystem = audioSystem;
    this.clockSync = clockSync;
    this.rtcMesh = rtcMesh;
    this.onStateChange = onStateChange || (() => {});

    this.isHost = false;
    this.isCasting = false;
    this.isReceiving = false;
    this.streamId = 1;
    this._seq = 0;
    this.codecId = CAST_CODEC_OPUS;
    this.playoutDelayMs = 650;
    this.monitorOnHost = true;

    this.packetsSent = 0;
    this.packetsReceived = 0;
    this.droppedLate = 0;
    this.statusMessage = '';
    this.errorMessage = '';

    this._captureStream = null;
    this._mediaSource = null;
    this._workletNode = null;
    this._silentGain = null;
    this._workletLoadedCtx = null;

    this._encoder = null;
    this._decoder = null;
    this._encoderDescriptionB64 = null;
    this._pendingEncodeMeta = new Map();
    this._pendingDecodeMeta = new Map();

    this._nextFrameEndTime = 0;
    this._scheduledSources = new Set();
    this._statsTimer = null;
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
      isCasting: this.isCasting,
      isReceiving: this.isReceiving,
      codecId: this.codecId,
      codecLabel: this.codecId === CAST_CODEC_OPUS ? 'OPUS 128k' : 'PCM16',
      playoutDelayMs: this.playoutDelayMs,
      monitorOnHost: this.monitorOnHost,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      droppedLate: this.droppedLate,
      statusMessage: this.statusMessage,
      errorMessage: this.errorMessage,
    };
  }

  setPlayoutDelayMs(ms) {
    const val = Math.max(200, Math.min(1500, Math.round(Number(ms) || 650)));
    this.playoutDelayMs = val;
    if (this.isHost && this.isCasting) {
      this.rtcMesh.broadcastControl({
        type: 'cast-delay',
        streamId: this.streamId,
        playoutDelayMs: this.playoutDelayMs,
      });
    }
    this.emitState();
  }

  setMonitorOnHost(enabled) {
    this.monitorOnHost = Boolean(enabled);
    this.emitState();
  }

  async _supportsOpusEncoder(sampleRate) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      return false;
    }
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  }

  async _supportsOpusDecoder(sampleRate, description = null) {
    if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
      return false;
    }
    try {
      const cfg = { codec: 'opus', sampleRate, numberOfChannels: 2 };
      if (description) cfg.description = description;
      const res = await AudioDecoder.isConfigSupported(cfg);
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  }

  async startCast() {
    if (!this.isHost || this.isCasting) return;
    this.errorMessage = '';
    this.statusMessage = 'Requesting tab audio share...';
    this.emitState();

    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.errorMessage = 'This browser does not support tab audio capture (use PC Chrome or Edge).';
      this.statusMessage = '';
      this.emitState();
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        },
      });
    } catch (err) {
      this.errorMessage = err?.name === 'NotAllowedError'
        ? 'Screen/tab share cancelled.'
        : `Capture failed: ${err?.message || 'Permission denied'}`;
      this.statusMessage = '';
      this.emitState();
      return;
    }

    const audioTracks = stream.getAudioTracks();
    for (const vt of stream.getVideoTracks()) {
      vt.stop();
      stream.removeTrack(vt);
    }

    if (audioTracks.length === 0) {
      this.errorMessage = "No audio captured — check 'Share tab audio' in the share dialog.";
      this.statusMessage = '';
      this.emitState();
      return;
    }

    const ctx = this.audioSystem.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    try {
      if (this._workletLoadedCtx !== ctx) {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        this._workletLoadedCtx = ctx;
      }
    } catch (err) {
      for (const t of audioTracks) t.stop();
      this.errorMessage = `Failed loading capture worklet: ${err?.message || 'error'}`;
      this.statusMessage = '';
      this.emitState();
      return;
    }

    this.streamId += 1;
    this._seq = 0;
    this.packetsSent = 0;
    this.droppedLate = 0;
    this._nextFrameEndTime = 0;
    this._encoderDescriptionB64 = null;
    this._pendingEncodeMeta.clear();
    this._captureStream = stream;

    const useOpus = await this._supportsOpusEncoder(ctx.sampleRate);
    this.codecId = useOpus ? CAST_CODEC_OPUS : CAST_CODEC_PCM16;

    if (useOpus) {
      this._initOpusEncoder(ctx.sampleRate);
    }

    const audioTrack = audioTracks[0];
    audioTrack.onended = () => {
      this.stopCast();
    };

    const audioOnlyStream = new MediaStream([audioTrack]);
    this._mediaSource = ctx.createMediaStreamSource(audioOnlyStream);
    this._workletNode = new AudioWorkletNode(ctx, 'pcm-capture-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    this._silentGain = ctx.createGain();
    this._silentGain.gain.value = 0;

    this._workletNode.port.onmessage = (event) => {
      this._handleCapturedFrame(event.data);
    };

    this._mediaSource.connect(this._workletNode);
    this._workletNode.connect(this._silentGain);
    this._silentGain.connect(ctx.destination);

    this.isCasting = true;
    this.statusMessage = 'Live tab audio casting';
    this.rtcMesh.broadcastControl({
      type: 'cast-start',
      streamId: this.streamId,
      codecId: this.codecId,
      sampleRate: ctx.sampleRate,
      channels: 2,
      playoutDelayMs: this.playoutDelayMs,
    });

    this._startStatsTimer();
    this.emitState();
  }

  _initOpusEncoder(sampleRate) {
    this._closeEncoder();
    const activeStreamId = this.streamId;

    this._encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (!this.isCasting || activeStreamId !== this.streamId) return;
        const meta = this._pendingEncodeMeta.get(chunk.timestamp);
        if (meta) {
          this._pendingEncodeMeta.delete(chunk.timestamp);
        }

        if (metadata?.decoderConfig?.description && !this._encoderDescriptionB64) {
          const descBytes = new Uint8Array(metadata.decoderConfig.description);
          this._encoderDescriptionB64 = uint8ToBase64(descBytes);
        }

        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);

        const packet = packCastFrame({
          streamId: activeStreamId,
          seq: meta?.seq ?? 0,
          captureHostTimeMs: meta?.captureHostTimeMs ?? performance.now(),
          codecId: CAST_CODEC_OPUS,
          channels: 2,
          sampleRate,
          payload,
        });

        this.rtcMesh.broadcastCastPacket(packet);
        this.packetsSent += 1;
      },
      error: () => {
        if (this.isCasting) {
          this._switchHostToPcmFallback();
        }
      },
    });

    this._encoder.configure({
      codec: 'opus',
      sampleRate,
      numberOfChannels: 2,
      bitrate: 128000,
    });
  }

  _switchHostToPcmFallback() {
    if (!this.isHost || !this.isCasting || this.codecId === CAST_CODEC_PCM16) return;
    this._closeEncoder();
    this.codecId = CAST_CODEC_PCM16;
    this.streamId += 1;
    this._seq = 0;
    this.statusMessage = 'Switched to PCM16 compatibility mode';
    const sr = this.audioSystem.audioCtx?.sampleRate || 48000;
    this.rtcMesh.broadcastControl({
      type: 'cast-start',
      streamId: this.streamId,
      codecId: CAST_CODEC_PCM16,
      sampleRate: sr,
      channels: 2,
      playoutDelayMs: this.playoutDelayMs,
    });
    this.emitState();
  }

  _handleCapturedFrame(frame) {
    if (!this.isCasting || !frame?.left || !frame?.right) return;
    const { left, right, frameCount, sampleRate } = frame;
    const captureHostTimeMs = performance.now();
    const seq = this._seq++;

    if (this.monitorOnHost) {
      this._scheduleDecodedPcmFrame(left, right, sampleRate, captureHostTimeMs);
    }

    if (this.codecId === CAST_CODEC_OPUS && this._encoder && this._encoder.state === 'configured') {
      const timestampUs = seq * 20000;
      this._pendingEncodeMeta.set(timestampUs, { seq, captureHostTimeMs });
      if (this._pendingEncodeMeta.size > 200) {
        const oldestKey = this._pendingEncodeMeta.keys().next().value;
        this._pendingEncodeMeta.delete(oldestKey);
      }

      const planar = new Float32Array(frameCount * 2);
      planar.set(left, 0);
      planar.set(right, frameCount);

      try {
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: 2,
          timestamp: timestampUs,
          data: planar,
        });
        this._encoder.encode(audioData);
        audioData.close();
      } catch {
        this._pendingEncodeMeta.delete(timestampUs);
      }
      return;
    }

    const int16 = float32StereoToInt16Interleaved(left, right);
    const payload = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    const packet = packCastFrame({
      streamId: this.streamId,
      seq,
      captureHostTimeMs,
      codecId: CAST_CODEC_PCM16,
      channels: 2,
      sampleRate,
      payload,
    });
    this.rtcMesh.broadcastCastPacket(packet);
    this.packetsSent += 1;
  }

  stopCast() {
    const wasCasting = this.isCasting;
    this.isCasting = false;
    this._stopCaptureNodes();
    this._closeEncoder();
    this._stopAllScheduledSources();
    this._stopStatsTimer();
    this._nextFrameEndTime = 0;
    this.statusMessage = '';

    if (wasCasting && this.isHost) {
      this.rtcMesh.broadcastControl({
        type: 'cast-stop',
        streamId: this.streamId,
      });
    }
    this.emitState();
  }

  handlePeerCastOpen(peerId) {
    if (!this.isHost || !this.isCasting) return;
    const sr = this.audioSystem.audioCtx?.sampleRate || 48000;
    this.rtcMesh.sendControlToPeer(peerId, {
      type: 'cast-start',
      streamId: this.streamId,
      codecId: this.codecId,
      sampleRate: sr,
      channels: 2,
      playoutDelayMs: this.playoutDelayMs,
      descriptionB64: this._encoderDescriptionB64,
    });
  }

  async handleControlMessage(peerId, msg) {
    if (!msg || typeof msg !== 'object') return false;

    if (this.isHost) {
      if (msg.type === 'cast-codec-fallback') {
        this._switchHostToPcmFallback();
        return true;
      }
      return false;
    }

    if (msg.type === 'cast-start') {
      this._stopAllScheduledSources();
      this._closeDecoder();
      this.streamId = msg.streamId || 1;
      this.codecId = msg.codecId || CAST_CODEC_OPUS;
      this.playoutDelayMs = msg.playoutDelayMs || 650;
      this.packetsReceived = 0;
      this.droppedLate = 0;
      this._nextFrameEndTime = 0;
      this._pendingDecodeMeta.clear();
      this.isReceiving = true;
      this.errorMessage = '';

      const sampleRate = msg.sampleRate || 48000;
      const desc = msg.descriptionB64 ? base64ToUint8(msg.descriptionB64) : null;

      if (this.codecId === CAST_CODEC_OPUS) {
        const supported = await this._supportsOpusDecoder(sampleRate, desc);
        if (!supported) {
          this.statusMessage = 'Requesting PCM16 compatibility stream...';
          this.rtcMesh.sendControlToPeer(peerId, { type: 'cast-codec-fallback' });
          this.emitState();
          return true;
        }
        this._initOpusDecoder(sampleRate, desc);
      }

      this.statusMessage = `Receiving live ${this.codecId === CAST_CODEC_OPUS ? 'Opus' : 'PCM16'} cast`;
      this._startStatsTimer();
      this.emitState();
      return true;
    }

    if (msg.type === 'cast-delay') {
      if (msg.streamId === this.streamId && Number.isFinite(msg.playoutDelayMs)) {
        this.playoutDelayMs = msg.playoutDelayMs;
        this.emitState();
      }
      return true;
    }

    if (msg.type === 'cast-stop') {
      if (!msg.streamId || msg.streamId === this.streamId) {
        this.isReceiving = false;
        this._closeDecoder();
        this._stopAllScheduledSources();
        this._stopStatsTimer();
        this._nextFrameEndTime = 0;
        this.statusMessage = '';
        this.emitState();
      }
      return true;
    }

    return false;
  }

  _initOpusDecoder(sampleRate, description = null) {
    this._closeDecoder();
    const activeStreamId = this.streamId;

    this._decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          if (!this.isReceiving || activeStreamId !== this.streamId) {
            return;
          }
          const captureHostTimeMs = this._pendingDecodeMeta.get(audioData.timestamp);
          if (captureHostTimeMs !== undefined) {
            this._pendingDecodeMeta.delete(audioData.timestamp);
          }

          const frameCount = audioData.numberOfFrames;
          const channels = audioData.numberOfChannels;
          const sr = audioData.sampleRate;
          let left = new Float32Array(frameCount);
          let right = new Float32Array(frameCount);

          if (audioData.format && audioData.format.endsWith('-planar')) {
            audioData.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
            if (channels > 1) {
              audioData.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
            } else {
              right = left;
            }
          } else {
            const interleaved = new Float32Array(frameCount * channels);
            audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
            for (let i = 0; i < frameCount; i++) {
              left[i] = interleaved[i * channels];
              right[i] = channels > 1 ? interleaved[i * channels + 1] : left[i];
            }
          }

          if (captureHostTimeMs !== undefined) {
            this._scheduleDecodedPcmFrame(left, right, sr, captureHostTimeMs);
          }
        } finally {
          audioData.close();
        }
      },
      error: () => {
        // Ignore single malformed packet decode errors
      },
    });

    const cfg = {
      codec: 'opus',
      sampleRate,
      numberOfChannels: 2,
    };
    if (description) cfg.description = description;
    this._decoder.configure(cfg);
  }

  handleCastPacket(_peerId, rawData) {
    if (this.isHost || !this.isReceiving) return;

    let frame;
    try {
      frame = unpackCastFrame(rawData);
    } catch {
      return;
    }

    if (frame.streamId !== this.streamId) return;
    this.packetsReceived += 1;

    if (frame.codecId === CAST_CODEC_OPUS) {
      if (!this._decoder || this._decoder.state !== 'configured') return;
      const timestampUs = frame.seq * 20000;
      this._pendingDecodeMeta.set(timestampUs, frame.captureHostTimeMs);
      if (this._pendingDecodeMeta.size > 200) {
        const oldestKey = this._pendingDecodeMeta.keys().next().value;
        this._pendingDecodeMeta.delete(oldestKey);
      }

      try {
        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: timestampUs,
          data: frame.payload,
        });
        this._decoder.decode(chunk);
      } catch {
        this._pendingDecodeMeta.delete(timestampUs);
      }
      return;
    }

    if (frame.codecId === CAST_CODEC_PCM16) {
      const { left, right } = int16InterleavedToFloat32Stereo(frame.payload);
      this._scheduleDecodedPcmFrame(left, right, frame.sampleRate, frame.captureHostTimeMs);
    }
  }

  _scheduleDecodedPcmFrame(left, right, sampleRate, captureHostTimeMs) {
    if (!left || left.length === 0) return;
    const ctx = this.audioSystem.ensureContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const rawSchedule = computeCastPlayoutAudioTime(
      captureHostTimeMs,
      this.playoutDelayMs,
      this.clockSync,
      ctx
    );

    if (rawSchedule < ctx.currentTime - 0.25) {
      this.droppedLate += 1;
      return;
    }

    const isContinuous =
      this._nextFrameEndTime > 0 && Math.abs(rawSchedule - this._nextFrameEndTime) < 0.015;
    const scheduleAt = isContinuous
      ? this._nextFrameEndTime
      : Math.max(ctx.currentTime + 0.02, rawSchedule);

    const frameCount = left.length;
    const buffer = ctx.createBuffer(2, frameCount, sampleRate || ctx.sampleRate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const gain = ctx.createGain();
    if (isContinuous) {
      gain.gain.setValueAtTime(1.0, scheduleAt);
    } else {
      gain.gain.setValueAtTime(0.0001, scheduleAt);
      gain.gain.linearRampToValueAtTime(1.0, scheduleAt + 0.002);
    }

    src.connect(gain);
    gain.connect(this.audioSystem.getInputNode());

    this._scheduledSources.add(src);
    src.onended = () => {
      this._scheduledSources.delete(src);
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        // ignore
      }
    };

    src.start(scheduleAt);
    this._nextFrameEndTime = scheduleAt + frameCount / (sampleRate || ctx.sampleRate);
  }

  _startStatsTimer() {
    this._stopStatsTimer();
    this._statsTimer = setInterval(() => {
      if (this.isCasting || this.isReceiving) {
        this.emitState();
      }
    }, 500);
  }

  _stopStatsTimer() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  _stopCaptureNodes() {
    if (this._workletNode) {
      try {
        this._workletNode.port.onmessage = null;
        this._workletNode.disconnect();
      } catch {
        // ignore
      }
      this._workletNode = null;
    }
    if (this._mediaSource) {
      try {
        this._mediaSource.disconnect();
      } catch {
        // ignore
      }
      this._mediaSource = null;
    }
    if (this._silentGain) {
      try {
        this._silentGain.disconnect();
      } catch {
        // ignore
      }
      this._silentGain = null;
    }
    if (this._captureStream) {
      for (const track of this._captureStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this._captureStream = null;
    }
  }

  _closeEncoder() {
    if (this._encoder) {
      try {
        if (this._encoder.state !== 'closed') this._encoder.close();
      } catch {
        // ignore
      }
      this._encoder = null;
    }
    this._pendingEncodeMeta.clear();
  }

  _closeDecoder() {
    if (this._decoder) {
      try {
        if (this._decoder.state !== 'closed') this._decoder.close();
      } catch {
        // ignore
      }
      this._decoder = null;
    }
    this._pendingDecodeMeta.clear();
  }

  _stopAllScheduledSources() {
    for (const src of this._scheduledSources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this._scheduledSources.clear();
  }

  reset() {
    this.stopCast();
    this.isReceiving = false;
    this._closeDecoder();
    this.packetsSent = 0;
    this.packetsReceived = 0;
    this.droppedLate = 0;
    this.errorMessage = '';
    this.statusMessage = '';
    this.emitState();
  }
}
