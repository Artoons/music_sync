import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createDevServer } from './dev-server.js';
import { generateQrSvg } from './public/js/qrcode.js';
import { ClockSyncEngine } from './public/js/clock-sync.js';

function createMaskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

function connectTestWs(port, path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n');
      socket.write(req);
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    const dispatchMsg = (msg) => {
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (w.predicate(msg)) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      messages.push(msg);
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = buf.subarray(0, headerEnd).toString('utf8');
        if (!headerText.startsWith('HTTP/1.1 101')) {
          reject(new Error(`Unexpected handshake response: ${headerText}`));
          return;
        }
        handshakeDone = true;
        buf = buf.subarray(headerEnd + 4);
        resolve(client);
      }

      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        const frameLen = offset + maskLen + payloadLen;
        if (buf.length < frameLen) return;

        const payload = buf.subarray(offset + maskLen, frameLen);
        buf = buf.subarray(frameLen);

        if (opcode === 0x1) {
          const parsed = JSON.parse(payload.toString('utf8'));
          dispatchMsg(parsed);
        } else if (opcode === 0x8) {
          socket.end();
        }
      }
    });

    socket.on('error', reject);

    const client = {
      messages,
      sendJson(obj) {
        socket.write(createMaskedFrame(JSON.stringify(obj)));
      },
      waitFor(predicate, timeoutMs = 3000) {
        for (let i = 0; i < messages.length; i++) {
          if (predicate(messages[i])) {
            return Promise.resolve(messages.splice(i, 1)[0]);
          }
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === res);
            if (idx !== -1) waiters.splice(idx, 1);
            rej(new Error('Timed out waiting for WebSocket message'));
          }, timeoutMs);
          waiters.push({ predicate, resolve: res, timer });
        });
      },
      close() {
        socket.destroy();
      },
    };
  });
}

async function runTests() {
  const server = createDevServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Static assets & /api/info
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('SyncStage'));

    const infoRes = await fetch(`${baseUrl}/api/info`);
    assert.equal(infoRes.status, 200);
    const infoJson = await infoRes.json();
    assert.equal(infoJson.mode, 'local');
    assert.ok(Array.isArray(infoJson.lanIps));

    for (const asset of [
      '/css/styles.css',
      '/js/app.js',
      '/js/qrcode.js',
      '/js/audio-dsp.js',
      '/js/audio-unlock.js',
      '/js/clock-sync.js',
      '/js/pcm-capture-worklet.js',
      '/js/requests.js',
      '/js/rtc-mesh.js',
      '/js/tab-cast.js',
      '/js/tab-files.js',
      '/js/tab-remote.js',
      '/js/visualizer.js',
    ]) {
      const r = await fetch(`${baseUrl}${asset}`);
      assert.equal(r.status, 200, `Expected 200 for ${asset}`);
    }
    console.log('PASS: Static UI assets and /api/info served cleanly');

    // 2. Connect 1 Host and 2 Listeners to /api/room/SYNC
    const hostWs = await connectTestWs(port, '/api/room/SYNC');
    const l1Ws = await connectTestWs(port, '/api/room/SYNC');
    const l2Ws = await connectTestWs(port, '/api/room/SYNC');

    hostWs.sendJson({ type: 'join', peerId: 'host-1', name: 'Host PC', role: 'host' });
    const hostWelcome = await hostWs.waitFor((m) => m.type === 'welcome');
    assert.equal(hostWelcome.role, 'host');
    assert.equal(hostWelcome.hostId, 'host-1');
    assert.equal(hostWelcome.roomCode, 'SYNC');

    l1Ws.sendJson({ type: 'join', peerId: 'peer-1', name: 'Android 1', role: 'listener' });
    const l1Welcome = await l1Ws.waitFor((m) => m.type === 'welcome');
    assert.equal(l1Welcome.role, 'listener');
    assert.equal(l1Welcome.hostId, 'host-1');

    // Verify second host claim is downgraded to listener while host-1 is active
    l2Ws.sendJson({ type: 'join', peerId: 'peer-2', name: 'Android 2', role: 'host' });
    const l2Welcome = await l2Ws.waitFor((m) => m.type === 'welcome');
    assert.equal(l2Welcome.role, 'listener');
    assert.equal(l2Welcome.hostId, 'host-1');
    assert.equal(l2Welcome.peers.length, 3);

    const hostLatestRoster = await hostWs.waitFor(
      (m) => m.type === 'roster' && Array.isArray(m.peers) && m.peers.length === 3
    );
    assert.equal(hostLatestRoster.hostId, 'host-1');
    console.log('PASS: Room join, single-host enforcement, and 3-peer roster sync');

    // 3. Verify WebRTC signaling routes strictly between Host and Listener 1 without leaking to Listener 2
    l2Ws.messages.length = 0;

    const longSdp = `v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n${'a=candidate:test-line\r\n'.repeat(12)}`;
    hostWs.sendJson({
      type: 'webrtc-signal',
      targetId: 'peer-1',
      signalType: 'offer',
      payload: { type: 'offer', sdp: longSdp },
    });
    const offerAtL1 = await l1Ws.waitFor(
      (m) => m.type === 'webrtc-signal' && m.signalType === 'offer'
    );
    assert.equal(offerAtL1.fromId, 'host-1');
    assert.equal(offerAtL1.payload.sdp, longSdp);

    l1Ws.sendJson({
      type: 'webrtc-signal',
      targetId: 'host-1',
      signalType: 'answer',
      payload: { type: 'answer', sdp: 'v=0-fake-answer' },
    });
    const answerAtHost = await hostWs.waitFor(
      (m) => m.type === 'webrtc-signal' && m.signalType === 'answer'
    );
    assert.equal(answerAtHost.fromId, 'peer-1');
    assert.equal(answerAtHost.payload.sdp, 'v=0-fake-answer');

    hostWs.sendJson({
      type: 'webrtc-signal',
      targetId: 'peer-1',
      signalType: 'ice',
      payload: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 50000 typ host' },
    });
    const iceAtL1 = await l1Ws.waitFor(
      (m) => m.type === 'webrtc-signal' && m.signalType === 'ice'
    );
    assert.equal(iceAtL1.fromId, 'host-1');

    // Give event loop a brief tick to verify Listener 2 did NOT receive any leaked signaling
    await new Promise((r) => setTimeout(r, 50));
    const leaked = l2Ws.messages.filter((m) => m.type === 'webrtc-signal');
    assert.equal(leaked.length, 0, 'Signaling must not leak to unrelated peers');
    console.log('PASS: WebRTC offer/answer/ice routed accurately without peer leakage');

    // 4. Verify peer-meta propagation to roster
    l1Ws.sendJson({
      type: 'peer-meta',
      rttMs: 6.4,
      clockOffsetMs: -12.3,
      connectionState: 'connected',
      channelRole: 'left',
      screenAwake: true,
    });

    const rosterWithMeta = await hostWs.waitFor(
      (m) =>
        m.type === 'roster' &&
        m.peers.some(
          (p) =>
            p.peerId === 'peer-1' &&
            p.meta.rttMs === 6.4 &&
            p.meta.clockOffsetMs === -12.3 &&
            p.meta.connectionState === 'connected'
        )
    );
    const p1 = rosterWithMeta.peers.find((p) => p.peerId === 'peer-1');
    assert.equal(p1.meta.channelRole, 'left');
    assert.equal(p1.meta.screenAwake, true);
    console.log('PASS: peer-meta updates propagated cleanly to room roster');

    // 5. Verify QR SVG generator
    const svg = generateQrSvg('https://syncstage.pages.dev/?room=SYNC');
    assert.ok(svg.startsWith('<svg ') && svg.includes('<path d=') && svg.endsWith('</svg>'));
    console.log('PASS: QR code SVG generator produced valid vector QR output');

    // 6. Verify ClockSyncEngine outlier filtering (20-sample lowest-RTT 25% selection)
    const syncEngine = new ClockSyncEngine({ isHost: false });
    syncEngine._burstId = 1;
    // Inject 15 high-RTT outliers (offset wrong by +200ms) and 5 clean low-RTT samples (offset = +100ms)
    for (let i = 0; i < 15; i++) {
      syncEngine._samples.push({ rtt: 80 + i * 5, offset: 300 });
    }
    for (let i = 0; i < 5; i++) {
      syncEngine._samples.push({ rtt: 4 + i * 0.2, offset: 100 });
    }
    let syncSummary = null;
    syncEngine._onSyncUpdate = (info) => {
      syncSummary = info;
    };
    syncEngine.finalizeBurst();
    assert.ok(syncSummary);
    assert.equal(syncSummary.keptCount, 5);
    assert.equal(syncSummary.hostOffsetMs, 100);
    assert.equal(syncSummary.syncQuality, 'excellent');
    console.log('PASS: ClockSyncEngine 25% lowest-RTT outlier rejection verified');

    hostWs.close();
    l1Ws.close();
    l2Ws.close();
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests()
  .then(() => {
    console.log('\nALL RELEASE 1 CHECKS PASSED');
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error('RELEASE 1 TEST FAILED:', err);
    process.exitCode = 1;
  });
