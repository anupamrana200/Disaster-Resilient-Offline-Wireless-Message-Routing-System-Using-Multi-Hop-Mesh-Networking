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
const CHUNK_INTERVAL_MS = 600;

/** Repeat each chunk N times for reliability */
const CHUNK_REPEATS = 3;

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

  /** Accumulate chunks per message ID hex until all arrive */
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();

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
   */
  setMyIdentity(deviceId: string, displayName: string): void {
    this.myDeviceId = deviceId;
    this.myDisplayName = displayName;
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

    console.log(`[PhoneMesh] Broadcasting message: ${totalChunks} chunks, payload: "${packet.pay}"`);

    for (let i = 0; i < totalChunks; i++) {
      const slice = payloadBytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const padded = [...slice, ...new Array(CHUNK_SIZE - slice.length).fill(0)];

      const advertisement = [
        ...DM_HEADER,                        // [0-1]  "DM"
        TYPE_MESSAGE,                        // [2]    chunk type
        ...msgIdBytes,                       // [3-6]  message ID
        i,                                   // [7]    chunk index
        totalChunks,                         // [8]    total chunks
        ...srcIdBytes,                       // [9-10] source ID
        Math.min(packet.hops ?? 0, 15),      // [11]   hops
        ...padded,                           // [12-21] payload chunk
      ];

      // Queue each chunk CHUNK_REPEATS times for reliability
      for (let r = 0; r < CHUNK_REPEATS; r++) {
        this.broadcastQueue.push(advertisement);
      }
    }

    this._processQueue();
  }

  async stopAdvertising(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      await BLEAdvertiser.stopBroadcast();
    } catch (_) {}
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
    const key = chunk.msgIdHex;

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
      const payload = this._reassemble(buf);
      this.chunkBuffers.delete(key);

      console.log(`[PhoneMesh] ✅ Message reassembled: "${payload}"`);

      if (this.onMessageReassembled) {
        this.onMessageReassembled({
          mid: key,
          src: buf.srcIdHex,
          sn: 'Peer',
          pay: payload,
          ts: Date.now(),
          ttl: 86400,
          hops: (buf.hops ?? 0) + 1,
        });
      }
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      BLEAdvertiser.setCompanyId(COMPANY_ID);

      // Stop any current advertisement before starting new one
      try { await BLEAdvertiser.stopBroadcast(); } catch (_) {}

      await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
        advertiseMode: 2, // LOW_LATENCY for fastest delivery
        txPowerLevel: 3,  // HIGH power for maximum range
        connectable: false,
        includeDeviceName: false,
        includeTxPowerLevel: false,
      });

      // Keep advertising for the interval duration, then stop
      setTimeout(async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const BLEAdv = require('react-native-ble-advertiser');
          await BLEAdv.stopBroadcast();
        } catch (_) {}
      }, CHUNK_INTERVAL_MS - 100);
    } catch (err) {
      console.warn('[PhoneMesh] Broadcast error:', err);
    }
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
    this.chunkBuffers.clear();
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
