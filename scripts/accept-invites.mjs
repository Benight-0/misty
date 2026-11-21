import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class MatrixInviteAcceptor {
  constructor() {
    this.base = 'http://127.0.0.1:8008';
    this.token = null;
    this.since = null;
    this.pending = new Set();
    this.failed = new Map();
    this.accepted = 0;
    this.platforms = new Map();
    this.acceptedByPlatform = {};
  }

  async request(endpoint, { method = 'GET', body, retries = 5 } = {}) {
    let serverRetries = 0;
    for (;;) {
      const headers = {};
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(this.base + endpoint, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      if (response.status === 429) {
        const headerDelay = Number(response.headers.get('Retry-After')) * 1000;
        const delay = Math.max(1000, data.retry_after_ms || headerDelay || 10000);
        for (let remaining = delay; remaining > 0; remaining -= 30000) {
          await pause(Math.min(30000, remaining));
        }
        continue;
      }
      if (response.status >= 500 && serverRetries++ < retries) {
        await pause(Math.min(1000 * 2 ** serverRetries, 15000));
        continue;
      }
      const err = new Error('Matrix request failed: HTTP ' + response.status + ' ' + (data.errcode || ''));
      err.status = response.status;
      err.errcode = data.errcode || 'UNKNOWN';
      throw err;
    }
  }

  async open({ deviceName = 'Local invitation import' } = {}) {
    const password = (await fs.readFile(path.join(workspace, 'data/owner-password.txt'), 'utf8')).trim();
    const login = await this.request('/_matrix/client/v3/login', {
      method: 'POST', body: {
        type: 'm.login.password', identifier: { type: 'm.id.user', user: 'owner' },
        password, initial_device_display_name: deviceName,
      },
    });
    if (login.user_id !== '@owner:localhost' || !login.access_token) {
      throw new Error('Unexpected Matrix account returned by login');
    }
    this.token = login.access_token;
    await this.refresh();
    return this.counts();
  }

  async refresh(timeout = 0) {
    const query = new URLSearchParams({ timeout: String(timeout), filter: JSON.stringify({ room: { timeline: { limit: 0 } } }) });
    if (this.since) query.set('since', this.since);
    const sync = await this.request('/_matrix/client/v3/sync?' + query);
    this.since = sync.next_batch;
    for (const roomId of Object.keys(sync.rooms?.join || {})) {
      this.pending.delete(roomId);
      this.failed.delete(roomId);
    }
    for (const roomId of Object.keys(sync.rooms?.leave || {})) {
      this.pending.delete(roomId);
      this.failed.delete(roomId);
    }
    for (const [roomId, room] of Object.entries(sync.rooms?.invite || {})) {
      this.pending.add(roomId);
      const inviter = (room.invite_state?.events || []).find(e => e.type === 'm.room.member' && e.state_key === '@owner:localhost' && e.content?.membership === 'invite')?.sender || '';
      const platform = ['whatsapp', 'discord', 'instagram', 'telegram'].find(name => inviter.startsWith('@' + name)) || 'other';
      this.platforms.set(roomId, platform);
    }
    return this.pending.size;
  }

  async drain({ timeBudgetMs = Infinity, concurrency = 1, pauseMs = 250 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || pauseMs < 0) throw new Error('Invalid invitation worker settings');
    const started = Date.now();
    const joined = new Set((await this.request('/_matrix/client/v3/joined_rooms')).joined_rooms || []);
    for (const roomId of joined) this.pending.delete(roomId);
    let accepted = 0;
    const errors = {};
    const queue = Array.from(this.pending).filter(roomId => !this.failed.has(roomId));
    let index = 0;
    const worker = async () => {
    while (index < queue.length && Date.now() - started < timeBudgetMs) {
      const roomId = queue[index++];
      try {
        await this.request('/_matrix/client/v3/join/' + encodeURIComponent(roomId), { method: 'POST', body: {} });
        this.pending.delete(roomId);
        this.accepted++;
        const platform = this.platforms.get(roomId) || 'other';
        this.acceptedByPlatform[platform] = (this.acceptedByPlatform[platform] || 0) + 1;
        accepted++;
      } catch (err) {
        const code = String(err.status || 'network') + ':' + (err.errcode || 'UNKNOWN');
        this.failed.set(roomId, code);
        errors[code] = (errors[code] || 0) + 1;
      }
      if (pauseMs) await pause(pauseMs);
    }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { accepted, totalAccepted: this.accepted, pending: this.pending.size, errors };
  }

  async counts() {
    const joined = (await this.request('/_matrix/client/v3/joined_rooms')).joined_rooms || [];
    return { joined: joined.length, pending: this.pending.size, failed: this.failed.size, accepted: this.accepted, acceptedByPlatform: this.acceptedByPlatform };
  }

  async close() {
    if (this.token) {
      try { await this.request('/_matrix/client/v3/logout', { method: 'POST', body: {} }); }
      finally { this.token = null; }
    }
  }
}

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : Number(process.argv[index + 1]);
  };
  const watchMinutes = arg('--watch-minutes', 30);
  const quietSeconds = arg('--quiet-seconds', 120);
  if (!(watchMinutes > 0 && quietSeconds >= 0)) throw new Error('Invalid watch duration');
  const client = new MatrixInviteAcceptor();
  try {
    console.log('Initial:', JSON.stringify(await client.open()));
    if (process.argv.includes('--restore-owner-limits')) {
      await client.request('/_synapse/admin/v1/users/' + encodeURIComponent('@owner:localhost') + '/override_ratelimit', { method: 'DELETE' });
      console.log('Owner rate limits restored to server defaults.');
    } else {
    const deadline = Date.now() + watchMinutes * 60000;
    let quietSince = Date.now();
    do {
      const result = await client.drain();
      if (result.accepted || Object.keys(result.errors).length) {
        console.log('Acceptance:', JSON.stringify(result));
        quietSince = Date.now();
      }
      if (client.failed.size) break;
      if (!client.pending.size && Date.now() - quietSince >= quietSeconds * 1000) break;
      await client.refresh(20000);
      if (client.pending.size) quietSince = Date.now();
    } while (Date.now() < deadline || client.pending.size);
    console.log('Final:', JSON.stringify(await client.counts()));
    if (client.failed.size) process.exitCode = 1;
    }
  } finally { await client.close(); }
}
