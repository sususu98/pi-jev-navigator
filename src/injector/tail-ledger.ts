import { createHash } from 'node:crypto';
import type { ContextWithSystemEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendNavigationTail } from './context-transform.js';

type Messages = ContextWithSystemEvent['messages'];
type Message = Messages[number];
export const NAVIGATION_TAIL_ENTRY = 'jev-navigation-tail-v1';
export const MAX_NAVIGATION_TAIL_CHARS = 256 * 1024;
// Never publish a tail that a later replay would reject. Preserve whole guidance
// or freeze absence; clipping could remove essential constraints or SOP paths.
const boundedGuidance = (guidance: string) => guidance.length <= MAX_NAVIGATION_TAIL_CHARS ? guidance : '';
export interface CurrentTail {
  index: number; guidance: string; userEntryId?: string; bind?: (id: string) => void;
}
interface FrozenTail {
  version: 1;
  userEntryId: string;
  userTimestamp: number;
  userContentHash: string;
  guidance: string;
}

function canonicalContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalContent(item)]),
  );
  return value;
}
const contentJSON = (value: unknown) => JSON.stringify(canonicalContent(value));

export function navigationMessageKey(message: Message): string {
  if (message.role !== 'user') return '';
  return `${message.timestamp}:${createHash('sha256').update(contentJSON(message.content)).digest('hex')}`;
}
const fingerprint = (message: Message) => navigationMessageKey(message).slice(String(message.timestamp).length + 1);

function validRecord(value: unknown): value is FrozenTail {
  if (!value || typeof value !== 'object') return false;
  const r = value as FrozenTail;
  return r.version === 1 && typeof r.userEntryId === 'string' && Number.isFinite(r.userTimestamp)
    && typeof r.userContentHash === 'string' && /^[a-f0-9]{64}$/.test(r.userContentHash)
    && typeof r.guidance === 'string' && r.guidance.length <= MAX_NAVIGATION_TAIL_CHARS;
}

function sameUser(message: Message, source: Message, record?: FrozenTail): boolean {
  if (message.role !== 'user' || source.role !== 'user' || message.timestamp !== source.timestamp) return false;
  if (fingerprint(message) === fingerprint(source)) return true;
  // Idempotence for handlers given an already-transformed request clone.
  const transformed = record ? appendNavigationTail(source, record.guidance) : undefined;
  return transformed?.role === 'user' && contentJSON(message.content) === contentJSON(transformed.content);
}

/** Immutable, branch-local wire history. Custom entries are never model messages.
 * Original user entries stay unchanged; each request replays exactly the first frozen tail.
 * Even an empty first decision is frozen so a retry cannot retroactively add navigation.
 */
export class NavigationTailLedger {
  // Compatibility for minimal library/test hosts without a SessionManager branch API.
  // Real Pi uses durable branch entries, not this volatile fallback.
  private fallback = new Map<string, Map<string, FrozenTail>>();
  private failedSaves = new Map<string, Map<string, FrozenTail>>();
  constructor(private pi: ExtensionAPI) {}

  public clearFallback(sessionKey: string): void {
    this.fallback.delete(sessionKey);
    this.failedSaves.delete(sessionKey);
  }

  public replay(messages: Messages, ctx: ExtensionContext, sessionKey: string,
    current?: CurrentTail | CurrentTail[]): Messages {
    const manager = ctx.sessionManager;
    if (typeof manager.getBranch !== 'function') return this.replayFallback(messages, sessionKey, current);
    const branch = manager.getBranch();
    const users = branch.filter((entry): entry is Extract<(typeof branch)[number], { type: 'message' }> =>
      entry.type === 'message' && entry.message.role === 'user');
    const usersById = new Map(users.map(entry => [entry.id, entry]));
    const records = new Map<string, FrozenTail>();
    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== NAVIGATION_TAIL_ENTRY || !validRecord(entry.data)) continue;
      const r = entry.data;
      const user = usersById.get(r.userEntryId);
      if (!user || user.message.timestamp !== r.userTimestamp || fingerprint(user.message) !== r.userContentHash) continue;
      if (!records.has(r.userEntryId)) records.set(r.userEntryId, r); // first wire decision wins
    }
    for (const [id, r] of this.failedSaves.get(sessionKey) ?? []) {
      const user = usersById.get(id);
      // A native append can update the in-memory tree before its disk write throws.
      // Failed publication must override that uncommitted non-empty record.
      if (user && user.message.timestamp === r.userTimestamp
        && fingerprint(user.message) === r.userContentHash) records.set(id, r);
    }
    const bindings = new Map<number, string>();
    // The native projection preserves source entry IDs after compaction/context edits.
    // Use its ordering when hashes/timestamps collide within the same active branch.
    if (typeof manager.buildSessionProjection === 'function') {
      const projected = manager.buildSessionProjection().entries.flatMap(entry =>
        entry.sourceEntry.type === 'message' && entry.sourceEntry.message.role === 'user'
          ? entry.messages.filter(message => message.role === 'user').map(() => entry.sourceEntry) : []);
      const contextUsers = messages.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user');
      if (projected.length === contextUsers.length && projected.every((entry, i) =>
        entry.type === 'message' && entry.message.timestamp === contextUsers[i].message.timestamp)) {
        for (const [i, entry] of projected.entries()) {
          if (entry.type === 'message' && sameUser(contextUsers[i].message, entry.message, records.get(entry.id))) {
            bindings.set(contextUsers[i].index, entry.id);
          }
        }
      }
    }
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user' || bindings.has(index)) continue;
      const matches = users.filter(entry => sameUser(message, entry.message, records.get(entry.id)));
      if (matches.length === 1) bindings.set(index, matches[0].id); // refuse ambiguous timestamps/content
    }
    const currentList = Array.isArray(current) ? current : current ? [current] : [];
    for (const cur of currentList) {
      const id = bindings.get(cur.index);
      const user = id ? usersById.get(id) : undefined;
      if (id && user && (!cur.userEntryId || cur.userEntryId === id)) {
        cur.bind?.(id);
      }
      if (id && user && (!cur.userEntryId || cur.userEntryId === id) && !records.has(id)) {
        const record: FrozenTail = {
          version: 1, userEntryId: id, userTimestamp: user.message.timestamp,
          userContentHash: fingerprint(user.message), guidance: boundedGuidance(cur.guidance),
        };
        // Persist BEFORE publishing a new tail. On failure do not create another ephemeral
        // prefix that cannot survive reload. Existing historical tails remain replayable.
        try {
          if (typeof this.pi.appendEntry === 'function') {
            this.pi.appendEntry(NAVIGATION_TAIL_ENTRY, record);
            records.set(id, record);
          }
        } catch {
          // Freeze absence for the remainder of this session instance. Retrying a failed
          // save later must not add a tail to a user already sent upstream without one.
          let failed = this.failedSaves.get(sessionKey);
          if (!failed) { failed = new Map(); this.failedSaves.set(sessionKey, failed); }
          // SessionManager retains the data object when append precedes a failed save.
          // It has never been published: freeze this new record to absence so even a
          // later full-tree flush/reload cannot backfill an unsent tail.
          record.guidance = '';
          const empty = record;
          failed.set(id, empty);
          records.set(id, empty);
        }
      }
    }
    let result = messages;
    for (const [index, id] of bindings) {
      const r = records.get(id);
      if (!r?.guidance) continue;
      const transformed = appendNavigationTail(messages[index], r.guidance);
      if (transformed !== messages[index]) {
        if (result === messages) result = messages.slice();
        result[index] = transformed;
      }
    }
    return result;
  }

  private replayFallback(messages: Messages, key: string, current?: CurrentTail | CurrentTail[]): Messages {
    let records = this.fallback.get(key);
    if (!records) { records = new Map(); this.fallback.set(key, records); }
    const currentList = Array.isArray(current) ? current : current ? [current] : [];
    for (const cur of currentList) {
      const message = messages[cur.index];
      if (!message) continue;
      const id = navigationMessageKey(message);
      if (!records.has(id)) records.set(id, {
        version: 1, userEntryId: id, userTimestamp: message.timestamp,
        userContentHash: fingerprint(message), guidance: boundedGuidance(cur.guidance),
      });
    }
    let result = messages;
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user') continue;
      let record = records.get(navigationMessageKey(message));
      if (!record) record = [...records.values()].find(r => r.userTimestamp === message.timestamp && r.guidance &&
        (typeof message.content === 'string' ? message.content.endsWith(r.guidance)
          : message.content.some(part => part.type === 'text' && part.text === r.guidance)));
      if (!record?.guidance) continue;
      const transformed = appendNavigationTail(message, record.guidance);
      if (transformed !== message) {
        if (result === messages) result = messages.slice();
        result[index] = transformed;
      }
    }
    return result;
  }
}
