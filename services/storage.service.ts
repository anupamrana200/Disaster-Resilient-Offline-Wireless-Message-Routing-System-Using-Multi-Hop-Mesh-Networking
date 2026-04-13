/**
 * StorageService — AsyncStorage wrapper for offline mesh messaging.
 *
 * Key schema:
 *   mesh:device       → LocalDevice (own identity)
 *   mesh:messages     → Message[]   (all messages)
 *   mesh:pending      → Message[]   (unsent queue)
 *   mesh:seen_ids     → string[]    (dedup cache of received message_ids)
 *   mesh:nodes        → MeshNode[]  (last-known peer list)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Message, MeshNode, LocalDevice, isExpired } from '@/types';

// ─── Storage Keys ───────────────────────────────────────────────────────────

const KEYS = {
  DEVICE: 'mesh:device',
  MESSAGES: 'mesh:messages',
  PENDING: 'mesh:pending',
  SEEN_IDS: 'mesh:seen_ids',
  NODES: 'mesh:nodes',
} as const;

// ─── Generic Helpers ─────────────────────────────────────────────────────────

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// ─── Device Identity ─────────────────────────────────────────────────────────

/**
 * Retrieve the persisted local device identity.
 * Returns null if never set (first launch).
 */
export async function getLocalDevice(): Promise<LocalDevice | null> {
  const raw = await AsyncStorage.getItem(KEYS.DEVICE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalDevice;
  } catch {
    return null;
  }
}

/** Persist the local device identity (call once on first launch). */
export async function saveLocalDevice(device: LocalDevice): Promise<void> {
  await writeJSON(KEYS.DEVICE, device);
}

// ─── Message Storage ─────────────────────────────────────────────────────────

/** Load all stored messages (received + sent history). */
export async function getMessages(): Promise<Message[]> {
  return readJSON<Message[]>(KEYS.MESSAGES, []);
}

/**
 * Returns the 8-character short hex prefix of a message_id.
 * Handles both full UUIDs ("460c8400-e29b-...") and already-truncated IDs ("460c8400").
 */
function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** Append a single message to the stored list. */
export async function saveMessage(msg: Message): Promise<void> {
  const existing = await getMessages();
  // Dedup by BOTH exact ID AND 8-char short prefix.
  // Relay messages arrive with a truncated message_id ("460c8400") while the
  // original sent message has a full UUID ("460c8400-e29b-..."). Exact-match
  // alone would let the relay through as a second entry. Short-prefix match
  // catches this even when the IDs differ in length.
  const msgShort = shortId(msg.message_id);
  const alreadyExists = existing.some(m =>
    m.message_id === msg.message_id || shortId(m.message_id) === msgShort,
  );
  if (alreadyExists) return;
  await writeJSON(KEYS.MESSAGES, [...existing, msg]);
}

/** Update the status of a specific message by ID. */
export async function updateMessageStatus(
  id: string,
  status: Message['status'],
): Promise<void> {
  const msgs = await getMessages();
  const updated = msgs.map(m => (m.message_id === id ? { ...m, status } : m));
  await writeJSON(KEYS.MESSAGES, updated);
}

/**
 * Remove messages whose TTL has elapsed.
 * Returns the number of messages pruned.
 */
export async function deleteExpiredMessages(): Promise<number> {
  const msgs = await getMessages();
  const valid = msgs.filter(m => !isExpired(m));
  await writeJSON(KEYS.MESSAGES, valid);

  // Also prune pending queue
  const pending = await getPendingQueue();
  const validPending = pending.filter(m => !isExpired(m));
  await writeJSON(KEYS.PENDING, validPending);

  return msgs.length - valid.length;
}

/** Get all message IDs currently stored (for manifest exchange). */
export async function getStoredMessageIds(): Promise<string[]> {
  const msgs = await getMessages();
  return msgs.map(m => m.message_id);
}

// ─── Pending Queue (Store-and-Forward) ──────────────────────────────────────

/** Get the outbound pending queue (messages waiting to be relayed). */
export async function getPendingQueue(): Promise<Message[]> {
  return readJSON<Message[]>(KEYS.PENDING, []);
}

/** Add a message to the pending outbound queue. */
export async function enqueueMessage(msg: Message): Promise<void> {
  const queue = await getPendingQueue();
  const alreadyQueued = queue.some(m => m.message_id === msg.message_id);
  if (!alreadyQueued) {
    await writeJSON(KEYS.PENDING, [...queue, msg]);
  }
}

/** Remove a message from the pending queue (after successful send). */
export async function dequeueMessage(messageId: string): Promise<void> {
  const queue = await getPendingQueue();
  await writeJSON(
    KEYS.PENDING,
    queue.filter(m => m.message_id !== messageId),
  );
}

/** Clear the entire pending queue. */
export async function clearPendingQueue(): Promise<void> {
  await writeJSON(KEYS.PENDING, []);
}

// ─── Seen IDs Cache (Deduplication) ─────────────────────────────────────────

/** Load the set of already-processed message IDs. */
export async function getSeenIds(): Promise<Set<string>> {
  const arr = await readJSON<string[]>(KEYS.SEEN_IDS, []);
  return new Set(arr);
}

/** Mark a message ID as seen (persist to storage). */
export async function markAsSeen(messageId: string): Promise<void> {
  const arr = await readJSON<string[]>(KEYS.SEEN_IDS, []);
  if (!arr.includes(messageId)) {
    // Cap the seen-IDs cache at 2000 entries (FIFO eviction)
    const capped = arr.length >= 2000 ? arr.slice(-1999) : arr;
    await writeJSON(KEYS.SEEN_IDS, [...capped, messageId]);
  }
}

/** Check if we have already processed this message ID. */
export async function hasBeenSeen(messageId: string): Promise<boolean> {
  const arr = await readJSON<string[]>(KEYS.SEEN_IDS, []);
  return arr.includes(messageId);
}

// ─── Peer Node Cache ─────────────────────────────────────────────────────────

/** Save the latest discovered node list. */
export async function saveNodes(nodes: MeshNode[]): Promise<void> {
  await writeJSON(KEYS.NODES, nodes);
}

/** Retrieve the last-known list of nearby nodes. */
export async function getSavedNodes(): Promise<MeshNode[]> {
  return readJSON<MeshNode[]>(KEYS.NODES, []);
}

// ─── Full Reset ───────────────────────────────────────────────────────────────

/** Wipe all mesh data from storage (useful for hard reset / testing). */
export async function clearAllMeshData(): Promise<void> {
  await AsyncStorage.multiRemove(Object.values(KEYS));
}
