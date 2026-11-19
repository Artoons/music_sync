import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
const ALLOWED_META_KEYS = [
  'rttMs',
  'clockOffsetMs',
  'syncQuality',
  'channelRole',
  'connectionState',
  'volume',
  'screenAwake',
  'latencyOffsetMs',
  'backgrounded',
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

function getLanIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Guest';
  const trimmed = raw.trim().slice(0, 32);
  return trimmed || 'Guest';
}

function extractMetaPatch(msg) {
  const source = msg.meta && typeof msg.meta === 'object' ? msg.meta : msg;
  const patch = {};
  for (const key of ALLOWED_META_KEYS) {
    if (source[key] !== undefined) {
      patch[key] = source[key];
    }
  }
  return patch;
}

function encodeWsFrame(opcode, payloadBuf) {
  const length = payloadBuf.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendWsText(client, text) {
  if (!client.socket.writable || client.closed) return;
  try {
    client.socket.write(encodeWsFrame(0x1, Buffer.from(text, 'utf8')));
  } catch {
    // Ignore write failure on closing socket
  }
}

function sendWsJson(client, payload) {
  sendWsText(client, JSON.stringify(payload));
}

function createRoomManager() {
  const rooms = new Map();

  function getOrCreateRoom(code) {
    let room = rooms.get(code);
    if (!room) {
      room = new Set();
      rooms.set(code, room);
    }
    return room;
  }

  function getPeers(room, excludeClient = null) {
    const peers = [];
    for (const c of room) {
      if (c === excludeClient || !c.state.peerId) continue;
      peers.push({
        peerId: c.state.peerId,
        name: c.state.name,
        role: c.state.role,
        joinedAt: c.state.joinedAt,
        meta: c.state.meta || {},
      });
    }
    return peers;
  }

  function getHostId(room, excludeClient = null) {
    for (const c of room) {
      if (c === excludeClient) continue;
      if (c.state.peerId && c.state.role === 'host') {
        return c.state.peerId;
      }
    }
    return null;
  }

  function broadcast(room, payload, excludeClient = null) {
    const encoded = JSON.stringify(payload);
    for (const c of room) {
      if (c === excludeClient || !c.state.peerId) continue;
      sendWsText(c, encoded);
    }
  }

  function handleMessage(client, roomCode, rawText) {
    const room = getOrCreateRoom(roomCode);
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      sendWsJson(client, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'join': {
        const requestedPeerId =
          typeof msg.peerId === 'string' && msg.peerId.trim()
            ? msg.peerId.trim().slice(0, 64)
            : crypto.randomUUID();
        const name = sanitizeName(msg.name);
        const requestedRole = msg.role === 'host' ? 'host' : 'listener';
        const existingHostId = getHostId(room, client);

        let assignedRole = 'listener';
        if (requestedRole === 'host' && (!existingHostId || existingHostId === requestedPeerId)) {
          assignedRole = 'host';
        }

        client.state = {
          peerId: requestedPeerId,
          name,
          role: assignedRole,
          roomCode,
          joinedAt: client.state.joinedAt || Date.now(),
          userAgent: typeof msg.userAgent === 'string' ? msg.userAgent.slice(0, 128) : '',
          meta: {
            channelRole: 'full',
            connectionState: assignedRole === 'host' ? 'host' : 'signaling',
            volume: 1,
            screenAwake: false,
            ...(client.state.meta || {}),
          },
        };

        const hostId = getHostId(room);
        const peers = getPeers(room);

        sendWsJson(client, {
          type: 'welcome',
          peerId: client.state.peerId,
          name: client.state.name,
          role: client.state.role,
          roomCode,
          hostId,
          peers,
        });

        broadcast(room, {
          type: 'roster',
          hostId,
          peers,
        });
        break;
      }

      case 'webrtc-signal': {
        if (!client.state.peerId || typeof msg.targetId !== 'string') return;
        for (const target of room) {
          if (target.state.peerId === msg.targetId) {
            sendWsJson(target, {
              type: 'webrtc-signal',
              fromId: client.state.peerId,
              fromName: client.state.name,
              signalType: msg.signalType,
              payload: msg.payload,
            });
            break;
          }
        }
        break;
      }

      case 'peer-meta': {
        if (!client.state.peerId) return;
        const patch = extractMetaPatch(msg);
        client.state.meta = {
          ...(client.state.meta || {}),
          ...patch,
        };
        broadcast(room, {
          type: 'roster',
          hostId: getHostId(room),
          peers: getPeers(room),
        });
        break;
      }

      case 'ping-signal': {
        sendWsJson(client, {
          type: 'pong-signal',
          clientTime: msg.clientTime ?? null,
          serverTime: Date.now(),
        });
        break;
      }

      default:
        break;
    }
  }

  function addClient(roomCode, socket) {
    const room = getOrCreateRoom(roomCode);
    const client = {
      socket,
      closed: false,
      state: {
        peerId: null,
        name: 'Guest',
        role: 'listener',
        roomCode,
        joinedAt: Date.now(),
        userAgent: '',
        meta: {},
      },
    };
    room.add(client);

    let rxBuffer = Buffer.alloc(0);
    let fragmentedChunks = [];
    let fragmentedOpcode = null;

    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      room.delete(client);

      if (client.state.peerId) {
        if (client.state.role === 'host') {
          broadcast(room, {
            type: 'host-left',
            hostId: client.state.peerId,
          });
        }
        broadcast(room, {
          type: 'roster',
          hostId: getHostId(room),
          peers: getPeers(room),
        });
      }

      if (room.size === 0) {
        rooms.delete(roomCode);
      }
    };

    socket.on('data', (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      while (rxBuffer.length >= 2) {
        const firstByte = rxBuffer[0];
        const secondByte = rxBuffer[1];
        const fin = (firstByte & 0x80) !== 0;
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (rxBuffer.length < 4) return;
          payloadLen = rxBuffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuffer.length < 10) return;
          const bigLen = rxBuffer.readBigUInt64BE(2);
          if (bigLen > 10_000_000n) {
            socket.destroy();
            cleanup();
            return;
          }
          payloadLen = Number(bigLen);
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        const frameLen = offset + maskLen + payloadLen;
        if (rxBuffer.length < frameLen) return;

        let payload = rxBuffer.subarray(offset + maskLen, frameLen);
        if (masked) {
          const maskKey = rxBuffer.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ maskKey[i & 3];
          }
          payload = unmasked;
        } else {
          payload = Buffer.from(payload);
        }

        rxBuffer = rxBuffer.subarray(frameLen);

        if (opcode === 0x8) {
          try {
            socket.write(encodeWsFrame(0x8, Buffer.alloc(0)));
          } catch {
            // ignore
          }
          socket.end();
          cleanup();
          return;
        }

        if (opcode === 0x9) {
          try {
            socket.write(encodeWsFrame(0xA, payload));
          } catch {
            // ignore
          }
          continue;
        }

        if (opcode === 0xA) {
          continue;
        }

        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            if (opcode === 0x1) {
              handleMessage(client, roomCode, payload.toString('utf8'));
            }
          } else {
            fragmentedOpcode = opcode;
            fragmentedChunks = [payload];
          }
        } else if (opcode === 0x0 && fragmentedOpcode !== null) {
          fragmentedChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(fragmentedChunks);
            if (fragmentedOpcode === 0x1) {
              handleMessage(client, roomCode, full.toString('utf8'));
            }
            fragmentedOpcode = null;
            fragmentedChunks = [];
          }
        }
      }
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('end', cleanup);
  }

  return { addClient };
}

export function createDevServer() {
  const roomManager = createRoomManager();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/api/info') {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3000;
      const body = JSON.stringify({
        mode: 'local',
        port,
        lanIps: getLanIps(),
        timestamp: Date.now(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    let relPath = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.normalize(path.join(PUBLIC_DIR, relPath));
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      const targetFile = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
      const data = await fs.readFile(targetFile);
      const ext = path.extname(targetFile).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });

  server.on('upgrade', (req, socket) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const match = reqUrl.pathname.match(/^\/api\/room\/([^/]+)$/);

    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const code = decodeURIComponent(match[1]).trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(`${key}${WS_MAGIC}`)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n',
      ].join('\r\n')
    );

    socket.setNoDelay(true);
    roomManager.addClient(code, socket);
  });

  return server;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createDevServer();

  server.listen(port, host, () => {
    const lanIps = getLanIps();
    console.log(`\nSyncStage local server listening on http://localhost:${port}`);
    if (lanIps.length > 0) {
      console.log('LAN URLs (for phones on the same Wi-Fi):');
      for (const ip of lanIps) {
        console.log(`  -> http://${ip}:${port}`);
      }
      console.log(
        'Note: Mobile browsers restrict Web Audio/WakeLock on non-HTTPS LAN IPs unless accessed over HTTPS (Cloudflare) or chrome://flags.\n'
      );
    }
  });
}
