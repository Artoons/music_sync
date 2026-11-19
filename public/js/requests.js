// Release 4: P2P Friend Song Request Queue with per-peer upvoting & sorting

export function sortRequests(items) {
  return [...items].sort((a, b) => {
    const diff = (b.votes?.length || 0) - (a.votes?.length || 0);
    if (diff !== 0) return diff;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RequestQueueController {
  constructor({ rtcMesh, onStateChange }) {
    this.rtcMesh = rtcMesh;
    this.onStateChange = onStateChange || (() => {});
    this.selfId = null;
    this.selfName = 'Guest';
    this.isHost = false;
    this.hostId = null;
    this.items = [];
  }

  setIdentity({ selfId, selfName, isHost, hostId }) {
    if (selfId !== undefined) this.selfId = selfId;
    if (selfName !== undefined) this.selfName = selfName;
    if (isHost !== undefined) this.isHost = Boolean(isHost);
    if (hostId !== undefined) this.hostId = hostId;
    this.emit();
  }

  emit() {
    this.onStateChange({
      items: this.items,
      selfId: this.selfId,
      isHost: this.isHost,
    });
  }

  _broadcastSync() {
    this.rtcMesh.broadcastControl({
      type: 'req-sync',
      items: this.items,
    });
  }

  submitRequest(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim().slice(0, 120) : '';
    if (!text) return false;

    if (this.isHost) {
      const item = {
        id: makeId(),
        text,
        byName: this.selfName || 'Host',
        byPeerId: this.selfId,
        votes: this.selfId ? [this.selfId] : [],
        createdAt: Date.now(),
      };
      this.items = sortRequests([...this.items, item]);
      this._broadcastSync();
      this.emit();
      return true;
    }

    if (this.hostId) {
      return this.rtcMesh.sendControlToPeer(this.hostId, {
        type: 'req-add',
        text,
        byName: this.selfName || 'Speaker',
      });
    }
    return false;
  }

  toggleUpvote(reqId) {
    if (!reqId || !this.selfId) return false;

    if (this.isHost) {
      return this._applyVote(reqId, this.selfId);
    }

    if (this.hostId) {
      return this.rtcMesh.sendControlToPeer(this.hostId, {
        type: 'req-upvote',
        reqId,
      });
    }
    return false;
  }

  _applyVote(reqId, voterId) {
    let changed = false;
    const updated = this.items.map((item) => {
      if (item.id !== reqId) return item;
      changed = true;
      const votes = new Set(item.votes || []);
      if (votes.has(voterId)) {
        votes.delete(voterId);
      } else {
        votes.add(voterId);
      }
      return { ...item, votes: [...votes] };
    });

    if (!changed) return false;
    this.items = sortRequests(updated);
    this._broadcastSync();
    this.emit();
    return true;
  }

  removeRequest(reqId) {
    if (!this.isHost || !reqId) return false;
    const next = this.items.filter((item) => item.id !== reqId);
    if (next.length === this.items.length) return false;
    this.items = next;
    this._broadcastSync();
    this.emit();
    return true;
  }

  syncPeer(peerId) {
    if (!this.isHost || !peerId) return;
    this.rtcMesh.sendControlToPeer(peerId, {
      type: 'req-sync',
      items: this.items,
    });
  }

  handleControlMessage(peerId, msg) {
    if (!msg || typeof msg !== 'object') return false;

    if (this.isHost) {
      if (msg.type === 'req-add') {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 120) : '';
        if (!text) return true;
        const item = {
          id: makeId(),
          text,
          byName: typeof msg.byName === 'string' && msg.byName.trim()
            ? msg.byName.trim().slice(0, 32)
            : 'Speaker',
          byPeerId: peerId,
          votes: peerId ? [peerId] : [],
          createdAt: Date.now(),
        };
        this.items = sortRequests([...this.items, item]);
        this._broadcastSync();
        this.emit();
        return true;
      }

      if (msg.type === 'req-upvote') {
        this._applyVote(msg.reqId, peerId);
        return true;
      }

      return false;
    }

    if (msg.type === 'req-sync' && Array.isArray(msg.items)) {
      this.items = sortRequests(msg.items);
      this.emit();
      return true;
    }

    return false;
  }

  reset() {
    this.items = [];
    this.emit();
  }
}
