/**
 * MeshtasticService — talks to real Meshtastic nodes over their BLE GATT API.
 *
 * Transport: react-native-ble-plx (via BLEService).
 * Encoding : hand-written protobuf encoding — no @meshtastic/protobufs needed.
 *            The @meshtastic/protobufs package is pure ESM which Metro bundles
 *            incorrectly in release mode, causing silent schema lookup failures.
 *            We encode the small subset we need directly with protobuf wire types.
 *
 * Meshtastic protobuf field numbers (from meshtastic/protobufs):
 *
 * ToRadio (message 1):
 *   field 1 (packet)       : MeshPacket — wire type 2 (LEN)
 *   field 3 (want_config_id): uint32    — wire type 0 (VARINT)
 *
 * MeshPacket:
 *   field 1 (to)           : fixed32   — wire type 5
 *   field 2 (from)         : fixed32   — wire type 5
 *   field 3 (id)           : fixed32   — wire type 5
 *   field 4 (rx_time)      : fixed32   — wire type 5
 *   field 5 (rx_snr)       : float     — wire type 5
 *   field 6 (hop_limit)    : uint32    — wire type 0
 *   field 7 (want_ack)     : bool      — wire type 0
 *   field 8 (priority)     : uint32    — wire type 0
 *   field 9 (rx_rssi)      : int32     — wire type 0
 *   field 10 (delayed)     : uint32    — wire type 0
 *   field 15 (channel)     : uint32    — wire type 0
 *   field 16 (decoded/Data): Data      — wire type 2 (LEN), oneof payload_variant
 *
 * Data:
 *   field 1 (portnum)      : uint32    — wire type 0  (TEXT_MESSAGE_APP = 1)
 *   field 2 (payload)      : bytes     — wire type 2
 *
 * FromRadio (message 2):
 *   field 1 (packet)       : MeshPacket — wire type 2
 *   field 3 (my_info)      : MyNodeInfo — wire type 2
 *   field 4 (node_info)    : NodeInfo   — wire type 2
 *   field 6 (config_complete_id): uint32 — wire type 0
 *
 * MyNodeInfo: field 1 (my_node_num): uint32 — wire type 0
 * NodeInfo: field 1 (num): uint32, field 4 (user): User
 * User: field 1 (id), field 2 (long_name), field 3 (short_name) — all wire type 2
 *
 * GATT characteristics (Meshtastic firmware):
 *   Service      : 6ba1b218-15a8-461f-9fa8-5dcae273eafd
 *   ToRadio      : f75c76d2-129e-4dad-a1dd-7866124401e7   WRITE
 *   FromRadio    : 2c55e69e-4993-11ed-b878-0242ac120002   READ
 *   FromNum      : ed9da18c-a800-4f66-a670-aa7547e34453   NOTIFY
 */

import { getBLEService } from './ble-adapter';
import {
  MESHTASTIC_SERVICE_UUID,
  MESHTASTIC_TORADIO_UUID,
  MESHTASTIC_FROMRADIO_UUID,
  MESHTASTIC_FROMNUM_UUID,
} from './ble.service';
import { dlog } from './debug-log.service';

/** Meshtastic broadcast destination — primary channel flood. */
const BROADCAST_ADDR = 0xffffffff;

/** PortNum.TEXT_MESSAGE_APP = 1 */
const PORT_TEXT = 1;

export interface MeshtasticTextMessage {
  fromNodeNum: number;
  fromName: string;
  text: string;
  channel: number;
  rxTime: number;
  id: number;
}

type TextMessageCallback = (msg: MeshtasticTextMessage) => void;

// ─── Minimal protobuf codec ───────────────────────────────────────────────────

function writeVarint(buf: number[], value: number): void {
  value = value >>> 0; // treat as unsigned 32-bit
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value = value >>> 7;
  }
  buf.push(value & 0x7f);
}

function writeFixed32(buf: number[], value: number): void {
  value = value >>> 0;
  buf.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function writeTag(buf: number[], fieldNum: number, wireType: number): void {
  writeVarint(buf, (fieldNum << 3) | wireType);
}

function writeBytes(buf: number[], fieldNum: number, data: Uint8Array | number[]): void {
  writeTag(buf, fieldNum, 2); // wire type 2 = LEN
  writeVarint(buf, data.length);
  for (const b of data) buf.push(b);
}

function writeVarintField(buf: number[], fieldNum: number, value: number): void {
  if (value === 0) return; // proto3: skip defaults
  writeTag(buf, fieldNum, 0);
  writeVarint(buf, value);
}

function writeFixed32Field(buf: number[], fieldNum: number, value: number): void {
  writeTag(buf, fieldNum, 5);
  writeFixed32(buf, value);
}

/** Encode a Data message (portnum + payload bytes). */
function encodeData(portnum: number, payload: Uint8Array): Uint8Array {
  const buf: number[] = [];
  writeVarintField(buf, 1, portnum);
  writeBytes(buf, 2, payload);
  return new Uint8Array(buf);
}

/**
 * Encode a MeshPacket with a decoded (Data) payload.
 *
 * Verified field numbers from meshtastic/protobufs MeshPacket (mod-D6ytgKaP.d.ts):
 *   from      = field 1  (fixed32)
 *   to        = field 2  (fixed32)
 *   channel   = field 3  (uint32)
 *   decoded   = field 4  (LEN) — oneof payload_variant
 *   id        = field 6  (fixed32)
 *   hop_limit = field 9  (uint32)  — NOT 8 (field 8 is rx_snr float)
 *   want_ack  = field 10 (bool)
 */
function encodeMeshPacket(params: {
  to: number;
  from: number;
  id: number;
  channel: number;
  hopLimit: number;
  wantAck: boolean;
  decoded: Uint8Array;
}): Uint8Array {
  const buf: number[] = [];
  if (params.from !== 0) {
    writeFixed32Field(buf, 1, params.from);    // field 1: from (omit → firmware fills it)
  }
  writeFixed32Field(buf, 2, params.to);        // field 2: to
  if (params.channel !== 0) {
    writeVarintField(buf, 3, params.channel);  // field 3: channel (0 = primary, omit)
  }
  writeBytes(buf, 4, params.decoded);          // field 4: decoded (Data)
  writeFixed32Field(buf, 6, params.id);        // field 6: id
  writeVarintField(buf, 9, params.hopLimit);   // field 9: hop_limit
  if (params.wantAck) {
    writeVarintField(buf, 10, 1);              // field 10: want_ack = true
  }
  return new Uint8Array(buf);
}

/** Encode a ToRadio with a packet payload. */
function encodeToRadioPacket(meshPacket: Uint8Array): Uint8Array {
  const buf: number[] = [];
  writeBytes(buf, 1, meshPacket); // field 1: packet
  return new Uint8Array(buf);
}

/** Encode a ToRadio with want_config_id. */
function encodeToRadioWantConfig(configId: number): Uint8Array {
  const buf: number[] = [];
  writeVarintField(buf, 3, configId); // field 3: want_config_id
  return new Uint8Array(buf);
}

// ─── Minimal protobuf decoder ─────────────────────────────────────────────────

interface DecodedField {
  fieldNum: number;
  wireType: number;
  value: number | Uint8Array;
}

function readVarint(data: Uint8Array, pos: number): { value: number; pos: number } {
  let result = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value: result >>> 0, pos };
}

function decodeMessage(data: Uint8Array): DecodedField[] {
  const fields: DecodedField[] = [];
  let pos = 0;
  while (pos < data.length) {
    const tag = readVarint(data, pos);
    pos = tag.pos;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const v = readVarint(data, pos);
      pos = v.pos;
      fields.push({ fieldNum, wireType, value: v.value });
    } else if (wireType === 2) {
      const lenV = readVarint(data, pos);
      pos = lenV.pos;
      const bytes = data.slice(pos, pos + lenV.value);
      pos += lenV.value;
      fields.push({ fieldNum, wireType, value: bytes });
    } else if (wireType === 5) {
      const v = data[pos] | (data[pos+1]<<8) | (data[pos+2]<<16) | (data[pos+3]<<24);
      pos += 4;
      fields.push({ fieldNum, wireType, value: v >>> 0 });
    } else {
      // unknown wire type — stop decoding
      break;
    }
  }
  return fields;
}

function getField(fields: DecodedField[], num: number): DecodedField | undefined {
  return fields.find(f => f.fieldNum === num);
}

function getString(bytes: Uint8Array): string {
  try { return new TextDecoder().decode(bytes); } catch { return ''; }
}

// ─── MeshtasticService ────────────────────────────────────────────────────────

class MeshtasticService {
  private static _instance: MeshtasticService;

  private deviceId: string | null = null;
  private fromNumCleanup: (() => void) | null = null;
  private draining = false;
  private nodeNames: Map<number, string> = new Map();
  private myNodeNum = 0;
  private onTextMessage: TextMessageCallback | null = null;

  static getInstance(): MeshtasticService {
    if (!MeshtasticService._instance) {
      MeshtasticService._instance = new MeshtasticService();
    }
    return MeshtasticService._instance;
  }

  isConnected(): boolean { return this.deviceId !== null; }
  getConnectedDeviceId(): string | null { return this.deviceId; }
  setTextMessageCallback(cb: TextMessageCallback): void { this.onTextMessage = cb; }

  async connect(deviceId: string): Promise<boolean> {
    dlog.info('Meshtastic', `connect() start deviceId=${deviceId}`);

    // Step 1: Enable FromNum notifications BEFORE sending want_config.
    // Official app does this first to avoid a race condition where the
    // config_complete_id FromRadio arrives before the notify subscription
    // is registered. Without this, the notification fires but we miss it.
    dlog.info('Meshtastic', 'subscribing FromNum notify...');
    this.fromNumCleanup = getBLEService().monitorRaw(
      deviceId,
      MESHTASTIC_SERVICE_UUID,
      MESHTASTIC_FROMNUM_UUID,
      () => { this._drainFromRadio().catch(() => {}); },
    );

    // Step 2: Send want_config_id to request full NodeDB dump
    const nonce = (Math.random() * 0xffffffff) >>> 0;
    const bytes = encodeToRadioWantConfig(nonce);
    dlog.info('Meshtastic', `writing want_config nonce=${nonce} (${bytes.length} bytes)`);

    const ok = await getBLEService().writeRaw(
      deviceId,
      MESHTASTIC_SERVICE_UUID,
      MESHTASTIC_TORADIO_UUID,
      bytes,
    );
    if (!ok) {
      dlog.error('Meshtastic', 'want_config write FAILED — check bonding / GATT');
      if (this.fromNumCleanup) { this.fromNumCleanup(); this.fromNumCleanup = null; }
      return false;
    }
    dlog.info('Meshtastic', 'want_config write OK — draining config...');
    this.deviceId = deviceId;

    // Small delay matching official app's 10ms sleep after each write
    await new Promise(r => setTimeout(r, 50));

    // Step 3: Drain config frames. Official app polls until config_complete_id
    // matches nonce. Give 5s — India region with 45 nodes can take a while.
    const deadline = Date.now() + 5000;
    let configured = false;
    while (Date.now() < deadline && !configured) {
      const drained = await this._drainFromRadio(nonce);
      if (drained) configured = true;
      else await new Promise(r => setTimeout(r, 150));
    }
    if (configured) {
      dlog.info('Meshtastic', `handshake complete — myNodeNum=${this.myNodeNum}`);
    } else {
      dlog.warn('Meshtastic', `handshake timeout — myNodeNum=${this.myNodeNum}, proceeding`);
    }

    dlog.info('Meshtastic', `session ready on ${deviceId}`);
    return true;
  }

  disconnect(): void {
    if (this.fromNumCleanup) {
      try { this.fromNumCleanup(); } catch (_) {}
      this.fromNumCleanup = null;
    }
    this.deviceId = null;
    this.nodeNames.clear();
    this.myNodeNum = 0;
  }

  async sendText(text: string, channel = 0): Promise<boolean> {
    if (!this.deviceId) {
      dlog.error('Meshtastic', 'sendText: no active session');
      return false;
    }
    const textBytes = new TextEncoder().encode(text);
    const data = encodeData(PORT_TEXT, textBytes);
    const pktId = (Math.random() * 0xffffffff) >>> 0;
    const meshPkt = encodeMeshPacket({
      to: BROADCAST_ADDR,
      from: 0,          // 0 = let firmware fill in its own node number
      id: pktId,
      channel,
      hopLimit: 3,
      wantAck: false,   // false for broadcast — avoids ACK flood
      decoded: data,
    });
    const toRadio = encodeToRadioPacket(meshPkt);
    dlog.info('Meshtastic', `sendText "${text}" ch=${channel} pktId=${pktId} bytes=${toRadio.length} from=${this.myNodeNum}`);

    // Log hex so we can verify encoding if needed
    const hex = Array.from(toRadio).map(b => b.toString(16).padStart(2,'0')).join('');
    dlog.info('Meshtastic', `ToRadio hex: ${hex}`);

    const ok = await getBLEService().writeRaw(
      this.deviceId,
      MESHTASTIC_SERVICE_UUID,
      MESHTASTIC_TORADIO_UUID,
      toRadio,
    );
    if (ok) {
      dlog.info('Meshtastic', 'GATT write OK — radio queued for LoRa TX');
      // Small delay matching official app — gives radio time to process before next op
      await new Promise(r => setTimeout(r, 50));
    } else {
      dlog.error('Meshtastic', 'GATT write FAILED');
    }
    return ok;
  }

  private async _drainFromRadio(expectedConfigId?: number): Promise<boolean> {
    if (!this.deviceId || this.draining) return false;
    this.draining = true;
    let sawConfigComplete = false;
    let framesRead = 0;

    try {
      for (let i = 0; i < 100; i++) {
        const bytes = await getBLEService().readRaw(
          this.deviceId,
          MESHTASTIC_SERVICE_UUID,
          MESHTASTIC_FROMRADIO_UUID,
        );
        if (!bytes || bytes.length === 0) {
          if (i === 0 && expectedConfigId !== undefined) {
            dlog.warn('Meshtastic', 'drain: first read empty (radio may need pairing)');
          }
          break;
        }
        framesRead++;
        try {
          this._handleFromRadio(bytes, expectedConfigId, (matched) => {
            if (matched) sawConfigComplete = true;
          });
        } catch (e: any) {
          dlog.warn('Meshtastic', `bad frame: ${e?.message || e}`);
        }
      }
    } finally {
      this.draining = false;
    }

    if (framesRead > 0) {
      dlog.info('Meshtastic', `drain: ${framesRead} frames, configOk=${sawConfigComplete}`);
    }
    return sawConfigComplete;
  }

  private _handleFromRadio(
    data: Uint8Array,
    expectedConfigId: number | undefined,
    onConfigMatch: (matched: boolean) => void,
  ): void {
    const fields = decodeMessage(data);

    // field 3: my_info (MyNodeInfo)
    const myInfoField = getField(fields, 3);
    if (myInfoField && myInfoField.value instanceof Uint8Array) {
      const inner = decodeMessage(myInfoField.value);
      const numField = getField(inner, 1);
      if (numField && typeof numField.value === 'number') {
        this.myNodeNum = numField.value;
        dlog.info('Meshtastic', `myInfo: myNodeNum=${this.myNodeNum}`);
      }
    }

    // field 4: node_info (NodeInfo)
    const nodeInfoField = getField(fields, 4);
    if (nodeInfoField && nodeInfoField.value instanceof Uint8Array) {
      const inner = decodeMessage(nodeInfoField.value);
      const numF = getField(inner, 1);
      const userF = getField(inner, 4);
      if (numF && typeof numF.value === 'number' && userF && userF.value instanceof Uint8Array) {
        const userFields = decodeMessage(userF.value);
        const longName = getField(userFields, 2);
        const shortName = getField(userFields, 3);
        const name = longName && longName.value instanceof Uint8Array
          ? getString(longName.value)
          : shortName && shortName.value instanceof Uint8Array
            ? getString(shortName.value)
            : `!${numF.value.toString(16)}`;
        this.nodeNames.set(numF.value, name);
        dlog.info('Meshtastic', `nodeInfo: ${numF.value} = ${name}`);
      }
    }

    // field 7: config_complete_id (NOT field 6 — field 6 is log_record)
    const configIdField = getField(fields, 7);
    if (configIdField && typeof configIdField.value === 'number') {
      dlog.info('Meshtastic', `configCompleteId=${configIdField.value} expected=${expectedConfigId}`);
      if (expectedConfigId !== undefined && configIdField.value === expectedConfigId) {
        onConfigMatch(true);
      }
    }

    // field 2: packet (MeshPacket) — NOT field 1 (field 1 is FromRadio.id sequence counter)
    // MeshPacket field numbers: from=1 to=2 channel=3 decoded=4 id=6 rx_time=7 hop_limit=8
    const packetField = getField(fields, 2);
    if (packetField && packetField.value instanceof Uint8Array) {
      const pkt = decodeMessage(packetField.value);
      const fromF    = getField(pkt, 1); // from     = field 1 (fixed32)
      const decodedF = getField(pkt, 4); // decoded  = field 4 (LEN)
      const idF      = getField(pkt, 6); // id       = field 6 (fixed32)
      const rxTimeF  = getField(pkt, 7); // rx_time  = field 7 (fixed32)
      const channelF = getField(pkt, 3); // channel  = field 3 (uint32)

      if (fromF && typeof fromF.value === 'number' && fromF.value !== this.myNodeNum) {
        const fromNum = fromF.value;
        if (decodedF && decodedF.value instanceof Uint8Array) {
          const dataFields = decodeMessage(decodedF.value);
          const portnumF = getField(dataFields, 1);
          const payloadF = getField(dataFields, 2);
          if (
            portnumF && portnumF.value === PORT_TEXT &&
            payloadF && payloadF.value instanceof Uint8Array
          ) {
            const text = getString(payloadF.value);
            const fromName = this.nodeNames.get(fromNum) || `!${fromNum.toString(16)}`;
            dlog.info('Meshtastic', `incoming text from ${fromName}: "${text}"`);
            this.onTextMessage?.({
              fromNodeNum: fromNum,
              fromName,
              text,
              channel: channelF && typeof channelF.value === 'number' ? channelF.value : 0,
              rxTime: rxTimeF && typeof rxTimeF.value === 'number' ? rxTimeF.value : 0,
              id: idF && typeof idF.value === 'number' ? idF.value : 0,
            });
          }
        }
      }
    }
  }
}

export default MeshtasticService;

export function getMeshtasticService(): MeshtasticService {
  return MeshtasticService.getInstance();
}
