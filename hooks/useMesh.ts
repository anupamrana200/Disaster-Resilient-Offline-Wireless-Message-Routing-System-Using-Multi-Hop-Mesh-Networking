/**
 * useMesh — high-level mesh networking hook combining BLE + PhoneMesh + DTN.
 *
 * Communication channels:
 *   1. ESP32 LoRa nodes  — GATT over BLE (via useBLE / BLEService)
 *   2. Phone peers        — BLE advertisement broadcast (via PhoneMeshService)
 *
 * Both channels run simultaneously. Messages received from either are:
 *   - Deduped (by message_id)
 *   - Stored locally
 *   - Re-broadcast on all channels (relay/forwarding)
 *
 * Usage:
 *   const { messages, sendMessage, nearbyNodes, startDiscovery } = useMesh();
 */

import { useEffect, useCallback, useRef } from 'react';
import { Vibration } from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import { useBLE } from './useBLE';
import { useNodesSlice } from '@/slices/nodes.slice';
import { useMessagesSlice } from '@/slices/messages.slice';
import {
  Message,
  messageToPacket,
  packetToMessage,
  MessagePacket,
  isExpired,
} from '@/types';
import { getBLEService } from '@/services/ble-adapter';
import { getPhoneMeshService } from '@/services/phone-mesh-adapter';

const MAX_HOPS = 5;

interface UseMeshResult {
  messages: Message[];
  pendingCount: number;
  nearbyNodes: ReturnType<typeof useNodesSlice>['nearbyNodes'];
  connectedNodeIds: ReturnType<typeof useNodesSlice>['connectedNodeIds'];
  isScanning: boolean;
  myNodeId: string;
  myDisplayName: string;
  sendMessage: (text: string, destinationId?: string) => Promise<void>;
  startDiscovery: () => void;
  stopDiscovery: () => void;
  connectToNode: (nodeId: string) => Promise<boolean>;
  disconnectFromNode: (nodeId: string) => Promise<void>;
}

export function useMesh(): UseMeshResult {
  const ble = useBLE();
  const nodesSlice = useNodesSlice();
  const msgsSlice = useMessagesSlice();

  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupListeners = useRef<Map<string, () => void>>(new Map());
  const hasAutoStarted = useRef(false);

  // ─── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    msgsSlice.dispatch(msgsSlice.loadMessagesAsync());
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []);

  // ─── Auto-start discovery ──────────────────────────────────────────────────
  // Start scanning + presence beacon as soon as BLE is ready and we have an
  // identity. Users should never need to tap "Start Scan" manually.
  useEffect(() => {
    if (ble.isReady && nodesSlice.myNodeId && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      console.log('[Mesh] Auto-starting BLE discovery...');
      ble.startScan();
    }
  }, [ble.isReady, nodesSlice.myNodeId]);

  // ─── Setup PhoneMesh callbacks (phone-to-phone channel) ────────────────────
  // Depends on ble.isReady so the presence beacon is (re)started even when
  // BLE finishes initializing after the identity was already loaded.
  useEffect(() => {
    const phoneMesh = getPhoneMeshService();

    // Inform the service of our own identity so it can resume presence
    // beacon automatically after message chunks finish broadcasting
    if (nodesSlice.myNodeId) {
      phoneMesh.setMyIdentity(nodesSlice.myNodeId, nodesSlice.myDisplayName);
    }

    // When a reassembled message arrives from a peer phone
    phoneMesh.setMessageCallback((raw: Partial<MessagePacket>) => {
      if (!raw.mid || !raw.pay) return;

      // Dedup — also blocks our own broadcast echoing back to us
      if (msgsSlice.seenIds.includes(raw.mid)) return;

      // Ignore messages we sent ourselves (srcIdHex is first 4 hex chars of our UUID)
      const myShortId = nodesSlice.myNodeId.replace(/-/g, '').slice(0, 4);
      if (raw.src === myShortId) return;

      // Mark seen immediately — before relay — so our own re-broadcast
      // doesn't echo back and get processed again
      msgsSlice.dispatch(msgsSlice.addSeenId(raw.mid));

      // Resolve sender display name from known nearby nodes.
      // The srcIdHex (4 hex chars = 2 bytes) is the prefix of the deviceIdHex
      // used in presence beacons (12 hex chars), so a startsWith match works.
      const srcHex = raw.src ?? '';
      const peerNode = nodesSlice.nearbyNodes.find(n =>
        n.node_id.replace('phone-', '').startsWith(srcHex),
      );
      const sourceName = peerNode?.name || `Peer-${srcHex.slice(0, 4)}`;

      // Vibrate to notify user of incoming message
      Vibration.vibrate([0, 200, 100, 200]); // short-short pattern

      const msg: Message = {
        message_id: raw.mid,
        source_id: raw.src ?? 'unknown',
        destination_id: '*',
        source_name: sourceName,
        payload: raw.pay,
        timestamp: raw.ts ?? Date.now(),
        ttl: raw.ttl ?? 86400,
        status: 'relayed',
        hops: (raw.hops ?? 0) + 1,
      };

      if (!isExpired(msg) && msg.hops <= MAX_HOPS) {
        msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));
        // Relay via BLE advertisement so phones not directly in range of the
        // original sender can still receive the message (multi-hop delivery)
        phoneMesh.broadcastMessage(messageToPacket(msg)).catch(() => {});
        // Relay to any connected ESP32 nodes
        transmitToAllNodes(msg);
      }
    });

    // When a phone peer is detected via presence beacon
    phoneMesh.setPresenceCallback((beacon: { type: string; deviceIdHex: string; displayName: string }) => {
      // Ignore our own presence beacon
      const myHex = nodesSlice.myNodeId.replace(/-/g, '').slice(0, 12);
      if (beacon.deviceIdHex === myHex) return;

      nodesSlice.dispatch(
        nodesSlice.upsertNode({
          node_id: `phone-${beacon.deviceIdHex}`,
          name: beacon.displayName || `Phone-${beacon.deviceIdHex.slice(0, 4)}`,
          rssi: -70, // unknown — not in presence beacon
          type: 'ble-phone',
          last_seen: Date.now(),
          is_connected: false,
          relay_count: 0,
        }),
      );
    });

    // Start presence beacon so we appear in other phones' node lists.
    // Guard with ble.isReady — broadcast() will fail silently if BLE is off.
    if (nodesSlice.myNodeId && ble.isReady) {
      phoneMesh.startPresenceBeacon(nodesSlice.myNodeId, nodesSlice.myDisplayName)
        .then((ok: boolean) => console.log('[Mesh] Presence beacon:', ok ? 'started' : 'failed'))
        .catch((e: any) => console.warn('[Mesh] Presence beacon error:', e));
    }
  }, [nodesSlice.myNodeId, nodesSlice.myDisplayName, ble.isReady]);

  // ─── GATT channel: listen to connected ESP32 nodes ────────────────────────
  useEffect(() => {
    getBLEService();

    for (const nodeId of nodesSlice.connectedNodeIds) {
      if (cleanupListeners.current.has(nodeId)) continue;
      const stopListening = ble.listenToNode(nodeId, (_deviceId, rawJson) => {
        handleIncomingGATTMessage(rawJson, nodeId);
      });
      cleanupListeners.current.set(nodeId, stopListening);
    }

    // Cleanup listeners for disconnected nodes
    for (const [nodeId, cleanup] of cleanupListeners.current.entries()) {
      if (!nodesSlice.connectedNodeIds.includes(nodeId)) {
        cleanup();
        cleanupListeners.current.delete(nodeId);
      }
    }
  }, [nodesSlice.connectedNodeIds]);

  // ─── Periodic sync: flush pending queue ────────────────────────────────────
  useEffect(() => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);

    syncIntervalRef.current = setInterval(() => {
      flushPendingQueue();
      msgsSlice.dispatch(msgsSlice.pruneExpiredAsync());
    }, 10_000);

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, [nodesSlice.connectedNodeIds, msgsSlice.pendingQueue]);

  // ─── Compose and Send ──────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string, destinationId = '*') => {
      if (!nodesSlice.myNodeId) {
        console.warn('[Mesh] myNodeId not ready');
        return;
      }

      const msg: Message = {
        message_id: uuidv4(),
        source_id: nodesSlice.myNodeId,
        destination_id: destinationId,
        source_name: nodesSlice.myDisplayName,
        payload: text,
        timestamp: Date.now(),
        ttl: nodesSlice.defaultTtl,
        status: 'pending',
        hops: 0,
      };

      // Optimistically add to local history
      await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));

      const packet = messageToPacket(msg);
      let broadcastOk = false;

      // Mark the truncated message ID (used in BLE chunks) as seen so we don't
      // process our own advertisement broadcast as an incoming message
      const shortMid = msg.message_id.replace(/-/g, '').slice(0, 8);
      msgsSlice.dispatch(msgsSlice.addSeenId(shortMid));

      // Channel 1: Broadcast via BLE advertisement (phone-to-phone)
      // This works connectionlessly — no GATT needed
      try {
        const phoneMesh = getPhoneMeshService();
        await phoneMesh.broadcastMessage(packet);
        console.log('[Mesh] Message broadcast via BLE advertisement');
        broadcastOk = true;
        // Mark as sent — the message was broadcast via BLE advertising
        msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'sent' }));
      } catch (err) {
        console.warn('[Mesh] BLE broadcast failed:', err);
      }

      // Channel 2: Also send to connected ESP32 nodes via GATT (if any)
      if (nodesSlice.connectedNodeIds.length > 0) {
        const sentViaGATT = await transmitToAllNodes(msg);
        if (sentViaGATT) {
          broadcastOk = true;
          msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'sent' }));
        }
      }

      // Only queue for later if NO channel succeeded at all
      if (!broadcastOk) {
        msgsSlice.dispatch(msgsSlice.enqueueMessageAsync({ ...msg, status: 'pending' }));
      }
    },
    [nodesSlice.myNodeId, nodesSlice.myDisplayName, nodesSlice.connectedNodeIds],
  );

  // ─── Transmit via GATT to all connected ESP32 nodes ────────────────────────

  const transmitToAllNodes = async (msg: Message): Promise<boolean> => {
    if (nodesSlice.connectedNodeIds.length === 0) return false;
    const json = JSON.stringify(messageToPacket(msg));
    let anyOk = false;
    for (const nodeId of nodesSlice.connectedNodeIds) {
      const ok = await ble.sendToNode(nodeId, json);
      if (ok) anyOk = true;
    }
    return anyOk;
  };

  // ─── Flush pending queue when nodes available ──────────────────────────────

  const flushPendingQueue = useCallback(async () => {
    if (nodesSlice.connectedNodeIds.length === 0) return;

    for (const msg of msgsSlice.pendingQueue) {
      if (isExpired(msg)) {
        msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'expired' }));
        msgsSlice.dispatch(msgsSlice.dequeueMessageAsync(msg.message_id));
        continue;
      }
      const sent = await transmitToAllNodes(msg);
      if (sent) {
        msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'sent' }));
        msgsSlice.dispatch(msgsSlice.dequeueMessageAsync(msg.message_id));
      }
    }
  }, [nodesSlice.connectedNodeIds, msgsSlice.pendingQueue]);

  // ─── Handle message from GATT (ESP32 relay) ───────────────────────────────

  const handleIncomingGATTMessage = useCallback(
    async (rawJson: string, _fromNodeId: string) => {
      try {
        const packet: MessagePacket = JSON.parse(rawJson);
        if (msgsSlice.seenIds.includes(packet.mid)) return;

        const msg = packetToMessage(packet);
        if (isExpired(msg) || msg.hops > MAX_HOPS) return;

        await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));

        // Relay: re-broadcast via phone mesh + other GATT nodes
        const phoneMesh = getPhoneMeshService();
        phoneMesh.broadcastMessage(messageToPacket(msg));

        if (msg.destination_id === '*' || msg.destination_id !== nodesSlice.myNodeId) {
          await transmitToAllNodes(msg);
        }
      } catch (err) {
        console.warn('[Mesh] GATT parse error:', err);
      }
    },
    [msgsSlice.seenIds, nodesSlice.myNodeId, nodesSlice.connectedNodeIds],
  );

  // ─── Discovery ─────────────────────────────────────────────────────────────

  const startDiscovery = useCallback(() => {
    const phoneMesh = getPhoneMeshService();

    // Start presence beacon so other DM phones can see our display name
    if (nodesSlice.myNodeId) {
      phoneMesh.startPresenceBeacon(nodesSlice.myNodeId, nodesSlice.myDisplayName)
        .then((ok: boolean) => console.log('[Mesh] Presence beacon started:', ok))
        .catch((e: any) => console.warn('[Mesh] Presence beacon error:', e));
    }

    // Start the unified BLE advertiser scanner
    // This single scanner handles: node discovery + presence + message receiving
    ble.startScan();
  }, [ble.startScan, nodesSlice.myNodeId, nodesSlice.myDisplayName]);

  const stopDiscovery = useCallback(() => {
    ble.stopScan();
    const phoneMesh = getPhoneMeshService();
    phoneMesh.stopAdvertising().catch((_: any) => {});
  }, [ble.stopScan]);

  return {
    messages: msgsSlice.messages,
    pendingCount: msgsSlice.pendingQueue.length,
    nearbyNodes: nodesSlice.nearbyNodes,
    connectedNodeIds: nodesSlice.connectedNodeIds,
    isScanning: ble.isScanning,
    myNodeId: nodesSlice.myNodeId,
    myDisplayName: nodesSlice.myDisplayName,
    sendMessage,
    startDiscovery,
    stopDiscovery,
    connectToNode: ble.connectToNode,
    disconnectFromNode: ble.disconnectFromNode,
  };
}
