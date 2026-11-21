import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MatrixInviteAcceptor } from './accept-invites.mjs';
import { DiscordImportQueue, parseGuildStatus } from './discord-import-queue.mjs';

const bot = '@discordbot:localhost';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const concurrency = Number(option('--concurrency', 3));
const adoptId = option('--adopt-in-flight', null);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error('Concurrency must be an integer from 1 to 4.');
}
const ids = (await fs.readFile(new URL('./discord-server-ids.txt', import.meta.url), 'utf8'))
  .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
if (!ids.length || ids.some(id => !/^\d{17,20}$/.test(id)) || new Set(ids).size !== ids.length) {
  throw new Error('Server list must contain unique Discord IDs, one per line.');
}
if (adoptId && !ids.includes(adoptId)) throw new Error('Active server is outside the allowed list.');

const client = new MatrixInviteAcceptor();
let stopped = false;
let watcher;
let watcherError;
let queue;
let initialCompleted = 0;
let importFinished = false;
let quietSince = Date.now();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; });

async function watchInvitations() {
  try {
    while (!stopped) {
      await client.refresh(2000);
      const result = await client.drain({ timeBudgetMs: 10000, concurrency: 3, pauseMs: 0 });
      if (result.accepted) {
        quietSince = Date.now();
        console.log('Accepted ' + result.accepted + ' room invitations (' + result.totalAccepted + ' total).');
      }
      if (client.pending.size > client.failed.size) quietSince = Date.now();
      if (Object.keys(result.errors).length) console.log('Invitation errors:', JSON.stringify(result.errors));
      if (importFinished && client.pending.size === client.failed.size && Date.now() - quietSince >= 120000) return;
      await pause(300);
    }
  } catch (err) {
    watcherError = err;
    stopped = true;
  }
}

try {
  await client.open({ deviceName: 'Local Discord bulk import' });
  const names = await client.request('/_matrix/client/v3/sync?' + new URLSearchParams({
    timeout: '0', filter: JSON.stringify({ room: { state: { types: ['m.room.name'] }, timeline: { limit: 0 } } }),
  }));
  const candidates = Object.entries(names.rooms?.join || {}).filter(([, room]) =>
    (room.state?.events || []).some(event => event.type === 'm.room.name' && event.content?.name === 'Discord bridge'));
  if (candidates.length !== 1) throw new Error('Could not uniquely identify the joined Discord bridge management room.');
  const roomId = candidates[0][0];
  const roomPath = '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId);
  const membership = await client.request(roomPath + '/state/m.room.member/' + encodeURIComponent(bot));
  if (membership.membership !== 'join') throw new Error('Discord bot is not joined to the management room.');
  console.log('Found Discord bridge room. Loaded ' + ids.length + ' server IDs; concurrency ' + concurrency + '.');
  if (process.argv.includes('--dry-run')) {
    console.log('Dry run complete. No messages sent and no invitations accepted.');
  } else {
    watcher = watchInvitations();
    const filter = JSON.stringify({ room: { rooms: [roomId], timeline: { limit: 100 }, state: { types: [] } } });
    let cursor = (await client.request('/_matrix/client/v3/sync?' + new URLSearchParams({ timeout: '0', filter }))).next_batch;
    const runId = randomUUID();
    let statusPending = false;
    let statusDue = true;
    let lastStatusSent = 0;
    let lastProgress = Date.now();
    let lastReport = 0;
    let statusSequence = 0;
    while (!stopped && (!queue || queue.completed.size < ids.length)) {
      if (watcherError) throw watcherError;
      if (Date.now() - lastProgress > 30 * 60000) throw new Error('No server completion in 30 minutes; stopping new submissions.');
      if (!statusPending && (statusDue || Date.now() - lastStatusSent >= 5000)) {
        await client.request(roomPath + '/send/m.room.message/' + runId + '-status-' + statusSequence++, {
          method: 'PUT', body: { msgtype: 'm.text', body: 'guilds status' },
        });
        statusPending = true;
        statusDue = false;
        lastStatusSent = Date.now();
      }
      if (queue && !statusPending) {
        for (const id of queue.takeAvailable()) {
          if (stopped) break;
          await client.request(roomPath + '/send/m.room.message/' + runId + '-' + id, {
            method: 'PUT', body: { msgtype: 'm.text', body: 'guilds bridge ' + id + ' --entire' },
          });
          console.log('Started server ' + id + ' (' + queue.active.size + '/' + concurrency + ' active).');
          await pause(250);
        }
      }
      const sync = await client.request('/_matrix/client/v3/sync?' + new URLSearchParams({
        timeout: '2000', filter, since: cursor,
      }));
      cursor = sync.next_batch;
      const timeline = sync.rooms?.join?.[roomId]?.timeline;
      if (timeline?.limited) throw new Error('Management timeline truncated; stopped to avoid missing confirmations.');
      for (const event of timeline?.events || []) {
        if (event.sender !== bot || event.type !== 'm.room.message') continue;
        const content = event.content || {};
        const body = content.body || '';
        if (/Error bridging guild:/i.test(body)) throw new Error('Bridge reported a server error; see the Discord bridge chat.');
        if (/Successfully bridged guild/i.test(body)) statusDue = true;
        if (/List of guilds/i.test(body || content.formatted_body || '')) {
          const statuses = parseGuildStatus(content);
          if (!queue) {
            queue = new DiscordImportQueue(ids, concurrency, statuses, adoptId);
            initialCompleted = queue.completed.size;
            console.log('Skipping ' + initialCompleted + ' completed servers; preserving ' + queue.active.size + ' active import.');
          } else {
            const before = queue.completed.size;
            queue.update(statuses);
            if (queue.completed.size > before) lastProgress = Date.now();
          }
          statusPending = false;
          console.log('Verified ' + queue.completed.size + '/' + ids.length + ' servers fully bridged; ' + queue.active.size + ' active.');
        }
      }
      if (Date.now() - lastReport > 30000 && queue) {
        console.log('Progress: ' + queue.completed.size + '/' + ids.length + ' confirmed, active servers: ' + [...queue.active].join(', '));
        lastReport = Date.now();
      }
    }
    if (watcherError) throw watcherError;
    importFinished = !stopped && queue?.completed.size === ids.length;
    quietSince = Date.now();
    if (importFinished) {
      console.log('All allowed servers confirmed. Draining late invitations.');
      await watcher;
    }
    console.log('Summary:', JSON.stringify({
      serversListed: ids.length, skippedCompleted: initialCompleted,
      submitted: queue?.submitted.size || 0, confirmed: queue?.completed.size || 0,
      outstandingServerIds: queue ? ids.filter(id => !queue.completed.has(id)) : ids,
      stopped, ...(await client.counts()),
    }));
    if (!importFinished || client.failed.size) process.exitCode = 1;
  }
} finally {
  stopped = true;
  if (watcher) await watcher;
  await client.close();
}
