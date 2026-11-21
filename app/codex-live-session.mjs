import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';

// Private, versioned Codex client coordination protocol. Never claim thread ownership.
export const LIVE_EXTENSION_VERSION = '26.51007.21434';
// Both installed releases use stream v11, queue updates v2 and follower queue v1.
// Keep this explicit: an unvalidated future release must still fail closed.
export const LIVE_EXTENSION_VERSIONS = Object.freeze([LIVE_EXTENSION_VERSION, '26.51021.22027']);
const PIPE = '\\\\.\\pipe\\codex-ipc';
const MAX_FRAME = 64 * 1024 * 1024;
export class CoordinationError extends Error {
 constructor(code) { super(`Codex session: ${code}`); this.code = code; }
}

export function checkLiveCompatibility(binary) {
 try {
  const extensionRoot = path.resolve(path.dirname(binary), '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (!LIVE_EXTENSION_VERSIONS.includes(manifest.version)) return false;
  const inventory = path.join(path.dirname(extensionRoot), 'extensions.json');
  if (fs.existsSync(inventory)) {
   const registered = JSON.parse(fs.readFileSync(inventory, 'utf8')).filter(e => e.identifier?.id === 'openai.chatgpt');
   // VS Code stages updates on disk before its currently running owner reloads.
   // Both sides must be tested versions; they need not be the same release.
   if (registered.length !== 1 || !LIVE_EXTENSION_VERSIONS.includes(registered[0].version)) return false;
  }
  return true;
 } catch { return false; }
}

export function resolveCodexBinary(configured) {
 const extensionRoot = path.resolve(path.dirname(configured), '../..');
 const inventory = path.join(path.dirname(extensionRoot), 'extensions.json');
 if (!fs.existsSync(inventory)) return configured;
 const registered = JSON.parse(fs.readFileSync(inventory, 'utf8')).filter(e => e.identifier?.id === 'openai.chatgpt');
 if (registered.length !== 1 || !LIVE_EXTENSION_VERSIONS.includes(registered[0].version)) throw new CoordinationError('unsupported-extension-version');
 const relative = registered[0].relativeLocation;
 if (typeof relative !== 'string' || path.basename(relative) !== relative) throw new CoordinationError('unsupported-extension-version');
 const binary = path.join(path.dirname(extensionRoot), relative, 'bin', path.basename(path.dirname(configured)), path.basename(configured));
 if (!fs.existsSync(binary) || !checkLiveCompatibility(binary)) throw new CoordinationError('unsupported-extension-version');
 return binary;
}

export class CodexCoordination extends EventEmitter {
 constructor({connect = () => net.connect(PIPE), timeout = 10000} = {}) {
  super(); this.connectSocket = connect; this.timeout = timeout;
  this.clientId = 'initializing-client'; this.pending = new Map(); this.buffer = Buffer.alloc(0); this.closed = true;
 }
 async connect() {
  this.closed = false; this.buffer = Buffer.alloc(0); this.clientId = 'initializing-client'; this.socket = this.connectSocket();
  this.socket.on('data', bytes => this.receiveBytes(bytes));
  this.socket.on('error', () => this.finish());
  this.socket.on('close', () => this.finish());
  await new Promise((resolve, reject) => {
   const timer = setTimeout(() => { this.close(); reject(new CoordinationError('connect-timeout')); }, this.timeout);
   const finish = fn => () => { clearTimeout(timer); this.socket.off('connect', ok); this.socket.off('error', bad); fn(); };
   const ok = finish(resolve), bad = finish(() => reject(new CoordinationError('unavailable')));
   this.socket.once('connect', ok); this.socket.once('error', bad);
  });
  const initialized = await this.request('initialize', {clientType:'misty-relay'}, {version:0});
  if (typeof initialized.result?.clientId !== 'string') { this.close(); throw new CoordinationError('invalid-initialize'); }
  this.clientId = initialized.result.clientId;
  return this;
 }
 receiveBytes(bytes) {
  this.buffer = Buffer.concat([this.buffer, bytes]);
  try {
   while (this.buffer.length >= 4) {
    const size = this.buffer.readUInt32LE(0);
    if (!size || size > MAX_FRAME) throw new Error('frame-size');
    if (this.buffer.length < size + 4) break;
    const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
    this.buffer = this.buffer.subarray(size + 4); this.receive(message);
   }
  } catch { this.close(); }
 }
 receive(message) {
  if (message.type === 'client-discovery-request') {
   this.write({type:'client-discovery-response', requestId:message.requestId, response:{canHandle:false}});
  } else if (message.type === 'response') {
   const pending = this.pending.get(message.requestId);
   if (!pending) return;
   this.pending.delete(message.requestId); clearTimeout(pending.timer);
   if (message.resultType !== 'success') pending.reject(new CoordinationError(String(message.error || 'request-failed').slice(0,180)));
   else if (pending.target && message.handledByClientId !== pending.target) pending.reject(new CoordinationError('wrong-owner'));
   else pending.resolve(message);
  } else if (message.type === 'broadcast') this.emit('broadcast', message);
 }
 write(message) {
  if (this.closed || this.socket.destroyed) throw new CoordinationError('disconnected');
  const bytes = Buffer.from(JSON.stringify(message));
  if (bytes.length > MAX_FRAME) throw new CoordinationError('frame-too-large');
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  this.socket.write(Buffer.concat([header, bytes]));
 }
 request(method, params, {version = 1, targetClientId, timeout = this.timeout} = {}) {
  return new Promise((resolve, reject) => {
   const requestId = randomUUID();
   const timer = setTimeout(() => { this.pending.delete(requestId); reject(new CoordinationError('request-timeout')); }, timeout);
   this.pending.set(requestId, {resolve, reject, timer, target:targetClientId});
   try { this.write({type:'request', requestId, sourceClientId:this.clientId, method, version, params, ...(targetClientId ? {targetClientId} : {})}); }
   catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
  });
 }
 broadcast(method, version, params, target) {
  this.write({type:'broadcast', sourceClientId:this.clientId, method, version, params, targetClientIds:[target]});
 }
 async owner(threadId) {
  try {
   const response = await this.request('thread-owner-discovery', {hostId:'local', conversationId:threadId});
   const owner = response.result?.ownerClientId || response.handledByClientId;
   if (typeof owner !== 'string' || !owner) throw new CoordinationError('invalid-owner');
   return owner;
  } catch (error) { if (error.code === 'no-client-found') return null; throw error; }
 }
 finish() {
  if (this.closed) return;
  this.closed = true;
  for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CoordinationError('disconnected')); }
  this.pending.clear(); this.emit('closed');
 }
 close() { this.socket?.destroy(); this.finish(); }
}

export class LiveThread {
 constructor(connection, threadId, owner) {
  this.connection = connection; this.threadId = threadId; this.owner = owner;
  this.listener = message => {
   const p = message.params;
   if (message.method === 'client-status-changed' && p?.clientId === this.owner && p.status === 'disconnected') this.ownerGone = true;
   if (message.sourceClientId !== this.owner || p?.conversationId !== this.threadId || p.hostId !== 'local') return;
   if (message.method === 'thread-stream-state-changed' && message.version === 11 && p.change?.type === 'snapshot') {
    if (p.change.conversationState?.id !== this.threadId) return;
    this.state = p.change.conversationState; this.revision = p.change.revision;
    this.needsSnapshot = false;
    this.waiting?.resolve(this.state);
   }
   if (message.method === 'thread-stream-state-changed' && message.version === 11 && p.change?.type === 'patches') {
    if (!this.state || p.change.baseRevision !== this.revision || this.needsSnapshot) this.needsSnapshot = true;
    else {
     try { this.state = applyStreamPatches(this.state, p.change.patches); if (this.state.id !== this.threadId || this.state.hostId !== 'local') throw new Error('wrong-state'); this.revision = p.change.revision; }
     catch { this.needsSnapshot = true; }
    }
   }
   if (message.method === 'thread-queued-followups-changed' && message.version === 2 && Array.isArray(p.messages)) this.queue = p.messages;
   if (message.method === 'thread-stream-following-status-requested') this.follow(true);
  };
  connection.on('broadcast', this.listener);
  this.onClosed = () => this.waiting?.reject(new CoordinationError('disconnected'));
  connection.on('closed', this.onClosed);
 }
 follow(following) {
  this.connection.broadcast('thread-stream-following-changed', 1, {conversationId:this.threadId, hostId:'local', following}, this.owner);
 }
 async snapshot() {
  // Re-follow is an explicit fresh snapshot request, avoiding partial text patch assembly.
  if (this.waiting) return this.waiting.promise;
  let resolve, reject;
  const promise = new Promise((a,b) => { resolve=a; reject=b; });
  const timer = setTimeout(() => reject(new CoordinationError('snapshot-timeout')), this.connection.timeout);
  this.waiting = {promise, resolve, reject};
  try { this.follow(true); return await promise; }
  finally { clearTimeout(timer); this.waiting = null; }
 }
 close() {
  try { if (!this.connection.closed) this.follow(false); } catch {}
  this.connection.off('broadcast', this.listener);
  this.connection.off('closed', this.onClosed);
 }
}

export function applyStreamPatches(state, patches) {
 if (!Array.isArray(patches)) throw new CoordinationError('invalid-patches');
 for (const patch of patches) {
  if (!Array.isArray(patch.path) || patch.path.some(key => ['__proto__','constructor','prototype'].includes(key)) || !['add','replace','remove'].includes(patch.op)) throw new CoordinationError('invalid-patch');
  if (!patch.path.length) { if (patch.op === 'remove') throw new CoordinationError('invalid-root-patch'); state = patch.value; continue; }
  let parent = state;
  for (const key of patch.path.slice(0,-1)) {
   if (!parent || !Object.hasOwn(parent,key)) throw new CoordinationError('missing-patch-parent');
   parent = parent[key];
  }
  const key = patch.path.at(-1);
  if (!parent || typeof parent !== 'object') throw new CoordinationError('invalid-patch-parent');
  if (Array.isArray(parent)) {
   if (!Number.isInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key === parent.length)) throw new CoordinationError('invalid-array-patch');
   if (patch.op === 'add') parent.splice(key,0,patch.value);
   else if (patch.op === 'remove') parent.splice(key,1);
   else parent[key] = patch.value;
  } else if (patch.op === 'remove') delete parent[key];
  else parent[key] = patch.value;
 }
 return state;
}

export function liveTurns(state) {
 if (state?.turnHistory?.kind === 'canonical') {
  return Object.values(state.turnHistory.history?.entitiesByKey || {}).filter(t => t && Array.isArray(t.items));
 }
 return state?.turns || [];
}

function sameWorkspace(a, b) {
 return typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export class LiveSessions {
 constructor(binary, {connection = new CodexCoordination(), stateFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json')} = {}) {
  this.compatible = checkLiveCompatibility(binary); this.connection = connection; this.stateFile = stateFile; this.sessions = new Map();
 }
 readQueue(threadId) {
  // Read only. All writes go through the owner, which persists and executes its queue.
  const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
  const queues = state['queued-follow-ups'] ?? {};
  if (!queues || typeof queues !== 'object' || Array.isArray(queues)) throw new CoordinationError('queue-schema-changed');
  const queue = queues[threadId] ?? [];
  if (!Array.isArray(queue) || queue.some(m => !m || typeof m.id !== 'string')) throw new CoordinationError('queue-schema-changed');
  return queue;
 }
 async open(threadId, cwd) {
  if (this.connection.closed) {
   try { await this.connection.connect(); }
   catch (error) { this.connection.close(); if (error.code === 'unavailable') return null; throw error; }
  }
  const owner = await this.connection.owner(threadId);
  if (!owner) return null;
  if (!this.compatible) throw new CoordinationError('unsupported-extension-version');
  let session = this.sessions.get(threadId);
  if (session?.owner !== owner || session?.ownerGone) { session?.close(); session = new LiveThread(this.connection, threadId, owner); this.sessions.set(threadId, session); }
  const state = await session.snapshot();
  if (!sameWorkspace(state.cwd, cwd) || state.hostId !== 'local') throw new CoordinationError('approved-workspace-mismatch');
  return session;
 }
 async refresh(session) {
  if (!session || session.ownerGone || this.connection.closed) return null;
  if (session.needsSnapshot) await session.snapshot();
  return session;
 }
 busy(session) {
  const state = session.state;
  return state.resumeState !== 'resumed' || state.threadRuntimeStatus?.type === 'active' ||
   liveTurns(state).some(t => t.status === 'inProgress') || (state.unconfirmedTurnSubmissions?.length || 0) > 0 ||
   this.readQueue(session.threadId).length > 0;
 }
 async enqueue(session, job) {
  // This internal follower operation replaces the queue. Never replace an observed
  // existing queue: wait locally instead. The native coordinator rechecks idleness
  // before execution, so a turn starting during admission is allowed to finish.
  if (this.readQueue(session.threadId).length) return {blocked:true};
  const message = {
   id:job.id, text:job.prompt, cwd:job.target.cwd, createdAt:Date.now(), requiresExistingOwner:true,
   context:{prompt:job.prompt, addedFiles:[], fileAttachments:[], imageAttachments:[], ideContext:null, workspaceRoots:[job.target.cwd]},
   submission:{hostId:'local', status:'queued', queueModeOverride:'queue'}
  };
  const response = await this.connection.request('thread-follower-set-queued-follow-ups-state', {
   conversationId:session.threadId, state:{[session.threadId]:[message]}
  }, {version:1, targetClientId:session.owner, timeout:30000});
  if (response.result?.ok !== true) throw new CoordinationError('invalid-queue-receipt');
  return {queued:true};
 }
 findTurn(session, clientId, turnId) {
  if (session?.ownerGone || this.connection.closed) return undefined;
  return liveTurns(session?.state).find(t => turnId ? t.turnId === turnId : t.params?.clientUserMessageId === clientId);
 }
 close() { for (const session of this.sessions.values()) session.close(); this.sessions.clear(); this.connection.close(); }
}
