import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BASE_DELAY_SEC } from './public/js/audio-dsp.js';
import {
  CAST_CODEC_OPUS,
  CAST_CODEC_PCM16,
  CAST_HEADER_BYTES,
  packCastFrame,
  unpackCastFrame,
  float32StereoToInt16Interleaved,
  int16InterleavedToFloat32Stereo,
  computeCastPlayoutAudioTime,
} from './public/js/tab-cast.js';
import {
  extractYouTubeVideoId,
  computeRemoteSyncAction,
} from './public/js/tab-remote.js';
import {
  sortRequests,
  RequestQueueController,
} from './public/js/requests.js';

function testCastFraming() {
  const opusPayload = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0xde, 0xad, 0xbe, 0xef]);
  const timestampMs = 123456.789125;
  const packet = packCastFrame({
    streamId: 7,
    seq: 42,
    captureHostTimeMs: timestampMs,
    codecId: CAST_CODEC_OPUS,
    channels: 2,
    sampleRate: 48000,
    payload: opusPayload,
  });

  assert.equal(packet.byteLength, CAST_HEADER_BYTES + opusPayload.byteLength);
  const decoded = unpackCastFrame(packet);
  assert.equal(decoded.streamId, 7);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.captureHostTimeMs, timestampMs);
  assert.equal(decoded.codecId, CAST_CODEC_OPUS);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.sampleRate, 48000);
  assert.deepEqual(decoded.payload, opusPayload);

  // PCM16 round-trip through packet framing + clipping guard
  const left = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
  const right = new Float32Array([0.25, -0.25, 0.75, -1.2, 1.2]);
  const int16 = float32StereoToInt16Interleaved(left, right);
  assert.equal(int16[6], 32767);
  assert.equal(int16[8], -32768);
  assert.equal(int16[7], -32768);
  assert.equal(int16[9], 32767);

  const pcmPacket = packCastFrame({
    streamId: 9,
    seq: 1,
    captureHostTimeMs: 5000.25,
    codecId: CAST_CODEC_PCM16,
    channels: 2,
    sampleRate: 44100,
    payload: new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength),
  });
  const pcmUnpacked = unpackCastFrame(pcmPacket);
  assert.equal(pcmUnpacked.codecId, CAST_CODEC_PCM16);
  assert.equal(pcmUnpacked.sampleRate, 44100);
  const restored = int16InterleavedToFloat32Stereo(pcmUnpacked.payload);
  assert.ok(Math.abs(restored.left[1] - 0.5) < 0.0001);
  assert.ok(Math.abs(restored.right[2] - 0.75) < 0.0001);

  const mockClock = {
    hostTimeToLocalAudioTime: (hostTimeMs) => hostTimeMs / 1000,
  };
  const playTime = computeCastPlayoutAudioTime(1000, 650, mockClock, { currentTime: 0 });
  assert.ok(Math.abs(playTime - (1.65 - BASE_DELAY_SEC)) < 1e-6);

  console.log('PASS: Cast binary framing, float64 timestamps, PCM16 conversion & playout math verified');
}

function testYouTubeRemoteHelpers() {
  assert.equal(extractYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD1'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractYouTubeVideoId('too-short'), null);
  assert.equal(extractYouTubeVideoId(''), null);

  const within = computeRemoteSyncAction(10.2, 10.5, 0.45);
  assert.equal(within.shouldSeek, false);
  const drifted = computeRemoteSyncAction(10.0, 10.6, 0.45);
  assert.equal(drifted.shouldSeek, true);
  assert.equal(drifted.targetPosSec, 10.6);

  console.log('PASS: YouTube URL parser & remote sync drift threshold verified');
}

function testRequestQueue() {
  const sentToHost = [];
  const broadcasts = [];
  const mockMesh = {
    sendControlToPeer: (peerId, msg) => {
      sentToHost.push({ peerId, msg });
      return true;
    },
    broadcastControl: (msg) => {
      broadcasts.push(msg);
      return 1;
    },
  };

  const hostQueue = new RequestQueueController({ rtcMesh: mockMesh });
  hostQueue.setIdentity({ selfId: 'host-1', selfName: 'Host', isHost: true, hostId: 'host-1' });

  // Host adds first song (1 vote)
  assert.equal(hostQueue.submitRequest('Daft Punk - One More Time'), true);
  assert.equal(hostQueue.items.length, 1);

  // Listener sends a second song via control channel
  hostQueue.handleControlMessage('peer-1', {
    type: 'req-add',
    text: 'Justice - Genesis',
    byName: 'Alex',
  });
  assert.equal(hostQueue.items.length, 2);

  // Second listener upvotes the second song -> it should jump to #1 (2 votes vs 1 vote)
  const secondId = hostQueue.items[1].id;
  hostQueue.handleControlMessage('peer-2', { type: 'req-upvote', reqId: secondId });
  assert.equal(hostQueue.items[0].id, secondId);
  assert.equal(hostQueue.items[0].votes.length, 2);

  // Duplicate upvote from same peer toggles vote off
  hostQueue.handleControlMessage('peer-2', { type: 'req-upvote', reqId: secondId });
  assert.equal(hostQueue.items.find((i) => i.id === secondId).votes.length, 1);

  // Host removes first song
  assert.equal(hostQueue.removeRequest(secondId), true);
  assert.equal(hostQueue.items.length, 1);

  // Listener submits & receives sync
  const listenerQueue = new RequestQueueController({ rtcMesh: mockMesh });
  listenerQueue.setIdentity({ selfId: 'peer-1', selfName: 'Alex', isHost: false, hostId: 'host-1' });
  listenerQueue.submitRequest('M83 - Midnight City');
  assert.equal(sentToHost.length, 1);
  assert.equal(sentToHost[0].peerId, 'host-1');
  assert.equal(sentToHost[0].msg.type, 'req-add');

  const sorted = sortRequests([
    { id: 'a', votes: ['u1'], createdAt: 10 },
    { id: 'b', votes: ['u1', 'u2'], createdAt: 20 },
  ]);
  assert.equal(sorted[0].id, 'b');

  console.log('PASS: RequestQueueController add, upvote toggle, sorting & removal verified');
}

function testDomIds() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const js = fs.readFileSync('public/js/app.js', 'utf8');
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `Missing DOM IDs in index.html: ${missing.join(', ')}`);
  console.log(`PASS: All ${ids.length} DOM IDs referenced in app.js exist in index.html`);
}

testCastFraming();
testYouTubeRemoteHelpers();
testRequestQueue();
testDomIds();
console.log('\nALL RELEASES 3-5 CHECKS PASSED');
