/**
 * MessageStatus represents the delivery lifecycle of a mesh message.
 * - pending:   stored locally, no node in range yet
 * - sent:      handed off to a BLE node (ESP32 or phone peer)
 * - delivered: acknowledged by the final destination
 * - relayed:   forwarded by an intermediate hop node
 * - expired:   TTL elapsed before delivery
 */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'relayed' | 'expired';

/**
 * Core message packet for the offline mesh network.
 * Keeps all fields small to fit within a single BLE MTU frame (≤512 bytes).
 */
export interface Message {
  /** UUID v4 — uniquely identifies this packet across the network */
  message_id: string;

  /** Node ID of the originating device */
  source_id: string;

  /** Node ID of the target device, or '*' for broadcast to all */
  destination_id: string;

  /** Human-readable display name of the sender */
  source_name: string;

  /** Plaintext payload (AES-encryption hook-ready) */
  payload: string;

  /** Unix timestamp in milliseconds when the message was created */
  timestamp: number;

  /** Time-to-live in seconds (e.g. 86400 = 24 hours) */
  ttl: number;

  /** Delivery/relay status */
  status: MessageStatus;

  /** Number of relay hops this packet has traversed (loop prevention) */
  hops: number;

  /**
   * Which transport delivered (or was used to send) this message on THIS
   * device. Purely local metadata — never serialized into MessagePacket —
   * used by the UI to render a "(Mesh)" tag on Meshtastic-delivered messages
   * so the user can tell LoRa hops apart from phone-mesh hops.
   */
  via?: 'meshtastic' | 'phone-mesh' | 'gatt';
}

/**
 * Sent over BLE as a compact JSON frame.
 * Receivers parse this, then re-hydrate into a full Message.
 */
export interface MessagePacket {
  mid: string;       // message_id
  src: string;       // source_id
  dst: string;       // destination_id
  sn: string;        // source_name
  pay: string;       // payload
  ts: number;        // timestamp
  ttl: number;       // ttl
  hops: number;      // hops
}

/** Convert a full Message to a compact wire packet */
export function messageToPacket(msg: Message): MessagePacket {
  return {
    mid: msg.message_id,
    src: msg.source_id,
    dst: msg.destination_id,
    sn: msg.source_name,
    pay: msg.payload,
    ts: msg.timestamp,
    ttl: msg.ttl,
    hops: msg.hops,
  };
}

/** Reconstruct a Message from a received wire packet */
export function packetToMessage(pkt: MessagePacket): Message {
  return {
    message_id: pkt.mid,
    source_id: pkt.src,
    destination_id: pkt.dst,
    source_name: pkt.sn,
    payload: pkt.pay,
    timestamp: pkt.ts,
    ttl: pkt.ttl,
    status: 'relayed',
    hops: pkt.hops + 1,
  };
}

/** Check if a message has expired based on creation timestamp + TTL */
export function isExpired(msg: Message): boolean {
  const expiresAt = msg.timestamp + msg.ttl * 1000;
  return Date.now() > expiresAt;
}
