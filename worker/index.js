import { DurableObject } from 'cloudflare:workers';

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/info') {
      return jsonResponse({
        mode: 'cloudflare',
        timestamp: Date.now(),
      });
    }

    const roomMatch = pathname.match(/^\/api\/room\/([^/]+)$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]).trim().toUpperCase();
      if (!ROOM_CODE_RE.test(code)) {
        return jsonResponse({ error: 'Invalid room code. Use 4-8 alphanumeric characters.' }, 400);
      }
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = `/api/room/${code}`;
      return stub.fetch(new Request(forwardedUrl.toString(), request));
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

export class RoomSession extends DurableObject {
  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'Expected WebSocket upgrade' }, 426);
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([^/]+)$/);
    const roomCode = match ? decodeURIComponent(match[1]).toUpperCase() : 'SYNC';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      peerId: null,
      name: 'Guest',
      role: 'listener',
      roomCode,
      joinedAt: Date.now(),
      userAgent: '',
      meta: {},
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  getPeers(excludeWs = null) {
    const peers = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (!att || !att.peerId) continue;
      peers.push({
        peerId: att.peerId,
        name: att.name,
        role: att.role,
        joinedAt: att.joinedAt,
        meta: att.meta || {},
      });
    }
    return peers;
  }

  getHostId(excludeWs = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (att && att.peerId && att.role === 'host') {
        return att.peerId;
      }
    }
    return null;
  }

  sendJson(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore sockets that closed mid-broadcast
    }
  }

  broadcastJson(payload, excludeWs = null) {
    const encoded = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (!att || !att.peerId) continue;
      try {
        ws.send(encoded);
      } catch {
        // Ignore broken sockets
      }
    }
  }

  async webSocketMessage(ws, rawMessage) {
    let text;
    if (typeof rawMessage === 'string') {
      text = rawMessage;
    } else if (rawMessage instanceof ArrayBuffer) {
      text = new TextDecoder().decode(rawMessage);
    } else {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;
    const current = ws.deserializeAttachment() || {
      peerId: null,
      name: 'Guest',
      role: 'listener',
      roomCode: 'SYNC',
      joinedAt: Date.now(),
      userAgent: '',
      meta: {},
    };

    switch (msg.type) {
      case 'join': {
        const requestedPeerId =
          typeof msg.peerId === 'string' && msg.peerId.trim()
            ? msg.peerId.trim().slice(0, 64)
            : crypto.randomUUID();
        const name = sanitizeName(msg.name);
        const requestedRole = msg.role === 'host' ? 'host' : 'listener';
        const existingHostId = this.getHostId(ws);

        let assignedRole = 'listener';
        if (requestedRole === 'host' && (!existingHostId || existingHostId === requestedPeerId)) {
          assignedRole = 'host';
        }

        const updated = {
          peerId: requestedPeerId,
          name,
          role: assignedRole,
          roomCode: current.roomCode,
          joinedAt: current.joinedAt || Date.now(),
          userAgent: typeof msg.userAgent === 'string' ? msg.userAgent.slice(0, 128) : '',
          meta: {
            channelRole: 'full',
            connectionState: assignedRole === 'host' ? 'host' : 'signaling',
            volume: 1,
            screenAwake: false,
            ...(current.meta || {}),
          },
        };

        ws.serializeAttachment(updated);

        const hostId = this.getHostId();
        const peers = this.getPeers();

        this.sendJson(ws, {
          type: 'welcome',
          peerId: updated.peerId,
          name: updated.name,
          role: updated.role,
          roomCode: updated.roomCode,
          hostId,
          peers,
        });

        this.broadcastJson({
          type: 'roster',
          hostId,
          peers,
        });
        break;
      }

      case 'webrtc-signal': {
        if (!current.peerId || typeof msg.targetId !== 'string') return;
        for (const targetWs of this.ctx.getWebSockets()) {
          const targetAtt = targetWs.deserializeAttachment();
          if (targetAtt && targetAtt.peerId === msg.targetId) {
            this.sendJson(targetWs, {
              type: 'webrtc-signal',
              fromId: current.peerId,
              fromName: current.name,
              signalType: msg.signalType,
              payload: msg.payload,
            });
            break;
          }
        }
        break;
      }

      case 'peer-meta': {
        if (!current.peerId) return;
        const patch = extractMetaPatch(msg);
        const updated = {
          ...current,
          meta: {
            ...(current.meta || {}),
            ...patch,
          },
        };
        ws.serializeAttachment(updated);

        this.broadcastJson({
          type: 'roster',
          hostId: this.getHostId(),
          peers: this.getPeers(),
        });
        break;
      }

      case 'ping-signal': {
        this.sendJson(ws, {
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

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment();
    try {
      ws.close(code || 1000, reason || 'Closed');
    } catch {
      // Socket already closed
    }
    this.handleDisconnect(ws, att);
  }

  async webSocketError(ws) {
    const att = ws.deserializeAttachment();
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Socket already closed
    }
    this.handleDisconnect(ws, att);
  }

  handleDisconnect(ws, att) {
    if (!att || !att.peerId) return;
    if (att.role === 'host') {
      this.broadcastJson(
        {
          type: 'host-left',
          hostId: att.peerId,
        },
        ws
      );
    }
    this.broadcastJson(
      {
        type: 'roster',
        hostId: this.getHostId(ws),
        peers: this.getPeers(ws),
      },
      ws
    );
  }
}
