import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordImportQueue, parseGuildStatus } from './discord-import-queue.mjs';
import { MatrixInviteAcceptor } from './accept-invites.mjs';

const ids = ['100000000000000036', '100000000000000035', '100000000000000039', '100000000000000038', '100000000000000033'];
const full = 'bridge all messages and create portals proactively';
const empty = 'never bridge messages';

test('parses HTML and plain status without rounding Discord IDs', () => {
  const html = '<li>Example (<code>' + ids[0] + '</code>) - ' + full + '</li>';
  assert.equal(parseGuildStatus({ formatted_body: html }).get(ids[0]), full);
  assert.equal(parseGuildStatus({ body: 'Example (' + ids[1] + ') - ' + empty }).get(ids[1]), empty);
});

test('skips completed servers, adopts existing work, and frees the correct slot out of order', () => {
  const statuses = new Map(ids.map(id => [id, empty]));
  statuses.set(ids[0], full);
  const queue = new DiscordImportQueue(ids, 3, statuses, ids[1]);
  assert.deepEqual(queue.takeAvailable(), [ids[2], ids[3]]);
  assert.equal(queue.active.size, 3);
  assert.deepEqual(queue.takeAvailable(), []);
  statuses.set(ids[3], full);
  queue.update(statuses);
  assert.deepEqual(queue.takeAvailable(), [ids[4]]);
  assert.equal(queue.active.size, 3);
  assert.ok(queue.active.has(ids[1]));
  assert.ok(!queue.active.has(ids[3]));
});

test('does not adopt excluded IDs or accept an incomplete status snapshot', () => {
  const statuses = new Map(ids.map(id => [id, empty]));
  assert.throws(() => new DiscordImportQueue(ids, 3, statuses, '100000000000000028'), /outside/);
  statuses.delete(ids[0]);
  assert.throws(() => new DiscordImportQueue(ids, 3, statuses), /missing/);
});

test('parallel invitation acceptance respects the worker bound and keeps failed invites', async () => {
  const client = new MatrixInviteAcceptor();
  for (let index = 0; index < 7; index++) client.pending.add('room-' + index);
  let active = 0;
  let maximum = 0;
  const seen = new Set();
  client.request = async endpoint => {
    if (endpoint.endsWith('joined_rooms')) return { joined_rooms: [] };
    const room = endpoint.split('/').pop();
    assert.ok(!seen.has(room));
    seen.add(room);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (room === 'room-4') throw Object.assign(new Error('Forbidden'), { status: 403, errcode: 'M_FORBIDDEN' });
    return {};
  };
  const result = await client.drain({ concurrency: 3, pauseMs: 0 });
  assert.equal(maximum, 3);
  assert.equal(result.accepted, 6);
  assert.equal(result.pending, 1);
  assert.equal(result.errors['403:M_FORBIDDEN'], 1);
  assert.deepEqual([...client.pending], ['room-4']);
});
