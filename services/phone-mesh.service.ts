/**
 * PhoneMeshService — phone-to-phone BLE mesh via advertisement broadcasting.
 *
 * Architecture (no GATT server required):
 *   - Each phone ADVERTISES messages inside BLE manufacturer data packets
 *   - Each phone SCANS using react-native-ble-advertiser's own scanner
 *   - Uses the SAME library for both send and receive (critical for reliability)
 *   - No BLE connection required — works purely via beacon broadcast
 *   - Messages are chunked into small advertisement payloads
 *
 * BLE Advertisement Packet Format (manufacturer data):
 *   [0-1]  "DM"  — DisasterMesh identifier (filter non-app traffic)
 *   [2]    type   — 0x01=message chunk | 0x02=presence beacon
 *
 *   For message chunks (type=0x01):
 *   [3-6]  msgId  — first 4 bytes of message UUID (hex)
 *   [7]    chunk  — chunk index (0-based)
 *   [8]    total  — total chunk count for this message
 *   [9-10] srcId  — source device ID (2 bytes)
 *   [11]   hops   — relay hop count (max 15)
 *   [12-21] pay   — 10 bytes of UTF-8 message payload
 *
 *   For presence beacons (type=0x02):
 *   [3-8]  devId  — device ID (6 bytes)
 *   [9+]   name   — display name (up to 10 bytes UTF-8)
 *
 * Requires: react-native-ble-advertiser
 * Platform: Android only (iOS restricts background BLE advertising)
 */

import { Platform, DeviceEventEmitter } from 'react-native';
import { Buffer } from 'buffer';
import { MessagePacket } from '@/types';
import { MESH_SERVICE_UUID } from './ble.service';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Internal BLE company ID for DisasterMesh (0xFFFF = test/internal use) */
const COMPANY_ID = 0xffff;

/** 2-byte header that identifies a DisasterMesh advertisement */
const DM_HEADER = [0x44, 0x4d]; // ASCII: "DM"

const TYPE_MESSAGE = 0x01;
const TYPE_PRESENCE = 0x02;

/** Bytes per chunk payload */
const CHUNK_SIZE = 10;

/** How long each chunk is broadcast before the next one (ms) */
const CHUNK_INTERVAL_MS = 400;

/**
 * Repeat each chunk this many times per pass.
 * At 400 ms each: 5 repeats = 2 seconds per chunk of advertisement time,
 * giving the receiver plenty of scan windows to catch it.
 */
const CHUNK_REPEATS = 5;

/**
 * After the first full broadcast pass, wait this many ms and then send
 * all chunks once more. This second pass catches receivers that were
 * temporarily busy during the first pass.
 */
const SECOND_PASS_DELAY_MS = 1200;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MessageChunk {
  type: 'message';
  msgIdHex: string;
  chunkIndex: number;
  totalChunks: number;
  srcIdHex: string;
  hops: number;
  payload: number[];
}

export interface PresenceBeacon {
  type: 'presence';
  deviceIdHex: string;
  displayName: string;
}

export type ParsedAdvertisement = MessageChunk | PresenceBeacon;

/** Accumulator for reassembling chunked messages */
interface ChunkBuffer {
  chunks: Map<number, number[]>;
  totalChunks: number;
  hops: number;
  srcIdHex: string;
  firstSeen: number;
}

// ── PhoneMeshService ──────────────────────────────────────────────────────────

class PhoneMeshService {
  private static _instance: PhoneMeshService;

  private isReceiving = false;
  private broadcastQueue: number[][] = [];
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Holds the full set of chunks for the last message so a second pass can resend them */
  private lastMessageChunks: number[][] = [];

  /** Accumulate chunks per message ID hex until all arrive */
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();

  /**
   * Service-level dedup set — tracks message IDs already delivered to the
   * callback. Prevents the same message from firing the callback more than
   * once even if chunks arrive repeatedly (retries, relay echoes, etc.).
   * Capped at 300 entries to prevent unbounded growth.
   */
  private seenMids: Set<string> = new Set();

  /**
   * Set of 4-char srcIdHex prefixes that belong to THIS device. Populated
   * automatically by broadcastMessage() and by setMyIdentity(). Any incoming
   * chunk whose srcIdHex is in this set is our own packet echoed back by a
   * relay or by the Android <=11 self-scan. Used as the most reliable
   * own-message guard — works even when setMyIdentity() was never called.
   */
  private myOwnSrcIds: Set<string> = new Set();

  /** Callback when a message is fully reassembled */
  private onMessageReassembled: ((raw: Partial<MessagePacket>) => void) | null = null;

  /** Callback when a presence beacon is detected */
  public onPresenceDetected: ((beacon: PresenceBeacon) => void) | null = null;

  /** Listener subscription */
  private scanListener: any = null;

  /** This device's own identity — used to resume presence beacon after message sends */
  private myDeviceId: string = '';
  private myDisplayName: string = '';

  static getInstance(): PhoneMeshService {
    if (!PhoneMeshService._instance) {
      PhoneMeshService._instance = new PhoneMeshService();
    }
    return PhoneMeshService._instance;
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  /**
   * Store this device's own identity so the presence beacon can be
   * automatically restarted after message chunk broadcasting finishes.
   * Also registers the 4-char srcIdHex prefix so incoming echoes of our
   * own messages are dropped at the earliest possible point.
   */
  setMyIdentity(deviceId: string, displayName: string): void {
    this.myDeviceId = deviceId;
    this.myDisplayName = displayName;
    const shortSrc = deviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
    if (shortSrc) this.myOwnSrcIds.add(shortSrc);
  }

  /**
   * Check whether a 4-char srcIdHex belongs to this device. Used by the
   * BLE scan listener to drop self-echoed chunks before any buffering.
   */
  isOwnSrcId(srcIdHex: string): boolean {
    if (!srcIdHex) return false;
    return this.myOwnSrcIds.has(srcIdHex.toLowerCase());
  }

  /**
   * Pre-mark a message ID as seen so that when our own broadcast echoes back
   * from peers (relay), the service-level dedup immediately discards it.
   * Call this from sendMessage() before broadcastMessage() to prevent the
   * sender from receiving their own message.
   * Always normalizes to lowercase so hex IDs from BLE bytes (always lowercase)
   * match UUIDs that may contain uppercase chars on some platforms.
   */
  markMessageSeen(msgIdHex: string): void {
    this.seenMids.add(msgIdHex.toLowerCase());
  }

  /**
   * Check if a message ID has already been seen or pre-marked.
   * Used by the BLE scan listener for early dedup before handleChunk.
   */
  isMessageSeen(msgIdHex: string): boolean {
    return this.seenMids.has(msgIdHex.toLowerCase());
  }

  // ── Callbacks ───────────────────────────────────────────────────────────────

  setMessageCallback(cb: (raw: Partial<MessagePacket>) => void): void {
    this.onMessageReassembled = cb;
  }

  setPresenceCallback(cb: (beacon: PresenceBeacon) => void): void {
    this.onPresenceDetected = cb;
  }

  // ── Receiving (Scanning) ────────────────────────────────────────────────────

  /**
   * Start scanning for DisasterMesh advertisements from other phones.
   * Uses react-native-ble-advertiser's own scanner so manufacturer data
   * is guaranteed to be readable (same library on both sides).
   */
  async startReceiving(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    if (this.isReceiving) return true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      BLEAdvertiser.setCompanyId(COMPANY_ID);

      // Remove any previous listener
      if (this.scanListener) {
        this.scanListener.remove();
        this.scanListener = null;
      }

      // Listen for scan results
      this.scanListener = DeviceEventEmitter.addListener(
        'onDeviceFound',
        (event: any) => {
          this._handleScanResult(event);
        },
      );

      // Start scanning for devices advertising our mesh service UUID
      await BLEAdvertiser.scanByService(MESH_SERVICE_UUID.toUpperCase(), {
        scanMode: 2, // LOW_LATENCY for fastest message delivery
        numberOfMatches: 3, // MAX_ADVERTISEMENT
        matchMode: 1, // AGGRESSIVE
      });

      this.isReceiving = true;
      console.log('[PhoneMesh] Receiver started — listening for mesh broadcasts');
      return true;
    } catch (err) {
      console.warn('[PhoneMesh] Start receiving failed:', err);
      return false;
    }
  }

  /** Stop scanning for advertisements */
  async stopReceiving(): Promise<void> {
    if (!this.isReceiving) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      await BLEAdvertiser.stopScan();
    } catch (_) {}

    if (this.scanListener) {
      this.scanListener.remove();
      this.scanListener = null;
    }
    this.isReceiving = false;
    console.log('[PhoneMesh] Receiver stopped');
  }

  /** Handle a scan result from react-native-ble-advertiser */
  private _handleScanResult(event: any): void {
    try {
      const manufData = event?.manufData;
      if (!manufData) return;

      // manufData from BLEAdvertiser is an array of numbers (bytes)
      let bytes: number[];
      if (Array.isArray(manufData)) {
        bytes = manufData;
      } else if (typeof manufData === 'object') {
        // Some versions return a map/object — convert to array
        bytes = Object.values(manufData).map(Number);
      } else {
        return;
      }

      if (bytes.length < 3) return;

      // Check for "DM" header
      if (bytes[0] !== 0x44 || bytes[1] !== 0x4d) return;

      const type = bytes[2];

      if (type === TYPE_MESSAGE && bytes.length >= 12) {
        const chunk: MessageChunk = {
          type: 'message',
          msgIdHex: bytes.slice(3, 7).map(b => b.toString(16).padStart(2, '0')).join(''),
          chunkIndex: bytes[7],
          totalChunks: bytes[8],
          srcIdHex: bytes.slice(9, 11).map(b => b.toString(16).padStart(2, '0')).join(''),
          hops: bytes[11] ?? 0,
          payload: bytes.slice(12, 22),
        };

        console.log(`[PhoneMesh] Received chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} for msg ${chunk.msgIdHex}`);
        this.handleChunk(chunk);
      } else if (type === TYPE_PRESENCE && bytes.length >= 9) {
        const beacon: PresenceBeacon = {
          type: 'presence',
          deviceIdHex: bytes.slice(3, 9).map(b => b.toString(16).padStart(2, '0')).join(''),
          displayName: String.fromCharCode(...bytes.slice(9).filter(b => b !== 0)).trim(),
        };

        this.onPresenceDetected?.(beacon);
      }
    } catch (err) {
      console.warn('[PhoneMesh] Parse error:', err);
    }
  }

  // ── Advertising ─────────────────────────────────────────────────────────────

  /**
   * Broadcast a presence beacon so other phones discover us.
   */
  async startPresenceBeacon(deviceId: string, displayName: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      BLEAdvertiser.setCompanyId(COMPANY_ID);

      // Always stop the current advertisement first — Android only allows
      // one active advertisement at a time, so calling broadcast() while
      // already advertising will throw "already advertising" error.
      try { await BLEAdvertiser.stopBroadcast(); } catch (_) {}

      const idBytes = hexToBytes(deviceId.replace(/-/g, '').slice(0, 12), 6);
      const nameBytes = stringToBytes(displayName.slice(0, 10));
      const data = [...DM_HEADER, TYPE_PRESENCE, ...idBytes, ...nameBytes];

      await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
        advertiseMode: 1, // BALANCED
        txPowerLevel: 2,  // MEDIUM
        connectable: false,
        includeDeviceName: false,
        includeTxPowerLevel: false,
      });

      console.log(`[PhoneMesh] Presence beacon started: "${displayName}"`);
      return true;
    } catch (err) {
      console.warn('[PhoneMesh] Beacon failed:', err);
      return false;
    }
  }

  /**
   * Broadcast a message packet — chunked across multiple advertisement bursts.
   */
  async broadcastMessage(packet: MessagePacket): Promise<void> {
    if (Platform.OS !== 'android') return;

    const payloadBytes = stringToBytes(packet.pay);
    const totalChunks = Math.max(1, Math.ceil(payloadBytes.length / CHUNK_SIZE));
    const msgIdBytes = hexToBytes(packet.mid.replace(/-/g, ''), 4);
    const srcIdBytes = hexToBytes(packet.src.replace(/-/g, ''), 2);

    // Failsafe self-identification: the exact bytes we are about to put on
    // the air are the bytes that come back when a relay echoes us. Register
    // them now so the echo is recognized even if setMyIdentity() was never
    // called (e.g. sender relays a message whose src is another phone's id).
    const outgoingSrcHex = srcIdBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    const outgoingMidHex = msgIdBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    this.seenMids.add(outgoingMidHex);
    // Only register the srcId prefix as "ours" if it matches our stored
    // identity — never mark relay packets (src=original sender) as own.
    if (this.myDeviceId) {
      const myShort = this.myDeviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
      if (myShort === outgoingSrcHex) this.myOwnSrcIds.add(myShort);
    }

    console.log(`[PhoneMesh] Broadcasting message: ${totalChunks} chunks, payload: "${packet.pay}"`);

    // Build one copy of each unique chunk advertisement
    const uniqueChunks: number[][] = [];
    for (let i = 0; i < totalChunks; i++) {
      const slice = payloadBytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const padded = [...slice, ...new Array(CHUNK_SIZE - slice.length).fill(0)];

      uniqueChunks.push([
        ...DM_HEADER,                        // [0-1]  "DM"
        TYPE_MESSAGE,                        // [2]    chunk type
        ...msgIdBytes,                       // [3-6]  message ID
        i,                                   // [7]    chunk index
        totalChunks,                         // [8]    total chunks
        ...srcIdBytes,                       // [9-10] source ID
        Math.min(packet.hops ?? 0, 15),      // [11]   hops
        ...padded,                           // [12-21] payload chunk
      ]);
    }

    // Save for the second-pass retry
    this.lastMessageChunks = uniqueChunks;

    // First pass: queue each chunk CHUNK_REPEATS times
    for (const chunk of uniqueChunks) {
      for (let r = 0; r < CHUNK_REPEATS; r++) {
        this.broadcastQueue.push(chunk);
      }
    }

    this._processQueue();

    // Second pass: after first pass completes + a short gap, resend each chunk once
    // This catches receivers that were temporarily busy during the first pass.
    const firstPassDuration = totalChunks * CHUNK_REPEATS * CHUNK_INTERVAL_MS;
    setTimeout(() => {
      if (this.lastMessageChunks.length > 0) {
        for (const chunk of this.lastMessageChunks) {
          this.broadcastQueue.push(chunk);
        }
        this._processQueue();
      }
    }, firstPassDuration + SECOND_PASS_DELAY_MS);
  }

  async stopAdvertising(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      await BLEAdvertiser.stopBroadcast();
    } catch (_) {}
  }

  /**
   * Cancel any pending broadcast queue and stop the current advertisement.
   * Call this when the user explicitly stops the mesh (Stop Scan button).
   * Unlike stopAdvertising(), this also clears the chunk queue so no further
   * chunks go out after the user asks to stop.
   */
  async stopAllBroadcasting(): Promise<void> {
    // Clear pending chunks so the timer chain doesn't resume advertising
    this.broadcastQueue = [];
    this.lastMessageChunks = [];
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    await this.stopAdvertising();
  }

  // ── Receiving / Parsing ──────────────────────────────────────────────────────

  /**
   * Parse base64-encoded BLE manufacturer data (from react-native-ble-plx scan).
   * Also handles raw byte arrays. Returns null if not a DM packet.
   */
  parseAdvertisement(manufacturerDataBase64: string | null): ParsedAdvertisement | null {
    if (!manufacturerDataBase64) return null;

    try {
      const buf = Buffer.from(manufacturerDataBase64, 'base64');
      let offset = 0;

      // Some devices prepend company ID bytes
      if (buf[offset] === 0xff && buf[offset + 1] === 0xff) offset += 2;

      if (buf[offset] !== 0x44 || buf[offset + 1] !== 0x4d) return null;

      const type = buf[offset + 2];

      if (type === TYPE_MESSAGE) {
        return {
          type: 'message',
          msgIdHex: buf.subarray(offset + 3, offset + 7).toString('hex'),
          chunkIndex: buf[offset + 7],
          totalChunks: buf[offset + 8],
          srcIdHex: buf.subarray(offset + 9, offset + 11).toString('hex'),
          hops: buf[offset + 11] ?? 0,
          payload: Array.from(buf.subarray(offset + 12, offset + 22)),
        };
      }

      if (type === TYPE_PRESENCE) {
        return {
          type: 'presence',
          deviceIdHex: buf.subarray(offset + 3, offset + 9).toString('hex'),
          displayName: buf
            .subarray(offset + 9)
            .toString('utf8')
            .replace(/\0/g, '')
            .trim(),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Feed a parsed chunk into the reassembly buffer.
   * Fires onMessageReassembled when all chunks for a message arrive.
   */
  handleChunk(chunk: MessageChunk): void {
    // ── Own-message guard (ABSOLUTE FIRST — runs before every other check) ──
    // Compares the srcIdHex from the BLE packet (first 4 hex chars / 2 bytes of
    // the source UUID) against our own identity. This catches:
    //   • Android ≤11 self-scan: the device receives its own advertisements
    //   • Relay echo: a peer relays our message back and we receive it again
    // Must be first because seenMids may be transiently empty (fresh restart,
    // cleared by destroy(), or pre-mark not yet flushed).
    //
    // Two-layer own-id check:
    //   1. myOwnSrcIds — populated by setMyIdentity() + broadcastMessage().
    //      Catches the case where the identity was set at any point in the
    //      session, even if myDeviceId gets transiently cleared.
    //   2. myDeviceId direct comparison — belt-and-braces fallback.
    if (this.myOwnSrcIds.has(chunk.srcIdHex.toLowerCase())) {
      console.log(`[PhoneMesh] Dropping own message chunk via myOwnSrcIds (src=${chunk.srcIdHex})`);
      return;
    }
    if (this.myDeviceId) {
      const myShortId = this.myDeviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
      if (chunk.srcIdHex.toLowerCase() === myShortId) {
        console.log(`[PhoneMesh] Dropping own message chunk (src=${chunk.srcIdHex})`);
        return;
      }
    }

    const key = chunk.msgIdHex.toLowerCase();

    // Fast-path dedup: already delivered or pre-marked (outgoing) — skip buffering entirely
    if (this.seenMids.has(key)) return;

    if (!this.chunkBuffers.has(key)) {
      this.chunkBuffers.set(key, {
        chunks: new Map(),
        totalChunks: chunk.totalChunks,
        hops: chunk.hops,
        srcIdHex: chunk.srcIdHex,
        firstSeen: Date.now(),
      });
    }

    const buf = this.chunkBuffers.get(key)!;
    buf.chunks.set(chunk.chunkIndex, chunk.payload);

    // Prune stale incomplete messages (>30 seconds old)
    if (Date.now() - buf.firstSeen > 30_000) {
      this.chunkBuffers.delete(key);
      return;
    }

    // Check if we have all chunks
    if (buf.chunks.size === buf.totalChunks) {
      this.chunkBuffers.delete(key);

      // ── Service-level dedup (double-check after reassembly) ──────────────
      if (this.seenMids.has(key)) return;

      // Mark as seen — cap the set to prevent unbounded growth
      this.seenMids.add(key);
      if (this.seenMids.size > 300) {
        this.seenMids.delete(this.seenMids.values().next().value!);
      }

      const payload = this._reassemble(buf);
      console.log(`[PhoneMesh] ✅ Message reassembled: "${payload}"`);

      this.onMessageReassembled?.({
        mid: key,
        src: buf.srcIdHex,
        sn: 'Peer',
        pay: payload,
        ts: Date.now(),
        ttl: 86400,
        hops: buf.hops ?? 0,
      });
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  private _processQueue(): void {
    if (this.broadcastTimer !== null) return;

    if (this.broadcastQueue.length === 0) {
      // All chunks sent — resume the presence beacon so peers still see us
      if (this.myDeviceId && this.myDisplayName) {
        this.startPresenceBeacon(this.myDeviceId, this.myDisplayName).catch(() => {});
      }
      return;
    }

    const next = this.broadcastQueue.shift()!;
    this._sendAdvertisement(next);

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this._processQueue();
    }, CHUNK_INTERVAL_MS);
  }

  private async _sendAdvertisement(data: number[]): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BLEAdvertiser = require('react-native-ble-advertiser');
    BLEAdvertiser.setCompanyId(COMPANY_ID);

    // Always stop cleanly before starting — Android only supports one active
    // advertiser at a time. Give it a small settle gap (50 ms) after stopping.
    try { await BLEAdvertiser.stopBroadcast(); } catch (_) {}
    await new Promise(r => setTimeout(r, 50));

    try {
      await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
        advertiseMode: 2, // LOW_LATENCY — fastest delivery
        txPowerLevel: 3,  // HIGH — maximum range
        connectable: false,
        includeDeviceName: false,
        includeTxPowerLevel: false,
      });
    } catch (err) {
      console.warn('[PhoneMesh] Broadcast error:', err);
    }
    // Chunk stays live for the full interval; _processQueue stops it via
    // the next stopBroadcast() call at the start of the following send.
  }

  private _reassemble(buf: ChunkBuffer): string {
    const allBytes: number[] = [];
    for (let i = 0; i < buf.totalChunks; i++) {
      const chunk = buf.chunks.get(i);
      if (chunk) {
        for (const b of chunk) {
          if (b !== 0) allBytes.push(b); // trim null padding
        }
      }
    }
    return Buffer.from(allBytes).toString('utf8');
  }

  destroy(): void {
    this.stopReceiving();
    this.stopAdvertising();
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.broadcastQueue = [];
    this.lastMessageChunks = [];
    this.chunkBuffers.clear();
    this.seenMids.clear();
    this.myOwnSrcIds.clear();
  }
}

// ── Utility Functions ─────────────────────────────────────────────────────────

function hexToBytes(hex: string, length: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) {
    const slice = hex.slice(i * 2, i * 2 + 2);
    bytes.push(slice ? parseInt(slice, 16) : 0xff);
  }
  return bytes;
}

function stringToBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    bytes.push(str.charCodeAt(i) & 0xff);
  }
  return bytes;
}

export default PhoneMeshService;
