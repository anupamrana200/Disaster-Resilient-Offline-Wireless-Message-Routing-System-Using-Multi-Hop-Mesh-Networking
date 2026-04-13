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
import { v4 as uuidv4 } from 'uuid';
import { showMessageNotification } from '@/services/notification.service';
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

/**
 * Module-level permanent dedup set.
 *
 * This lives OUTSIDE the React component so it is:
 *   - Never reset by re-renders
 *   - Never stale due to React closure capture
 *   - Shared across EVERY useMesh() call in the app
 *
 * Populated in two places:
 *   1. sendMessage()      — our own outgoing messages (both full UUID + 8-char hex)
 *   2. phoneMesh callback — messages we receive and process
 *
 * Any message ID already in this set is immediately discarded, even if the
 * service-level seenMids or Redux seenIds somehow missed it.
 *
 * Never cleared — kept for the lifetime of the app process.
 */
const _processedMids = new Set<string>();

/**
 * Module-level auto-start guard — prevents multiple useMesh() instances
 * (e.g. ChatScreen + NodesScreen both mounted as tabs) from each registering
 * their own BLE scan listener. Only the first instance starts scanning;
 * the rest skip the auto-start so there is exactly ONE active listener.
 */
let _autoStarted = false;

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

  // Always-fresh refs — updated on every render so callbacks never read stale
  // Redux state through a frozen closure (the root cause of duplicate messages,
  // wrong sender names, and the sender receiving their own notifications).
  const seenIdsRef = useRef<string[]>([]);
  const myNodeIdRef = useRef<string>('');
  const nearbyNodesRef = useRef<typeof nodesSlice.nearbyNodes>([]);
  seenIdsRef.current = msgsSlice.seenIds;
  myNodeIdRef.current = nodesSlice.myNodeId;
  nearbyNodesRef.current = nodesSlice.nearbyNodes;

  // ─── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    msgsSlice.dispatch(msgsSlice.loadMessagesAsync());
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []);

  // ─── Auto-start discovery ──────────────────────────────────────────────────
  // Start scanning + presence beacon as soon as BLE is ready and we have an
  // identity. Uses a module-level flag (_autoStarted) so that only the FIRST
  // useMesh() instance triggers the scan — ChatScreen and NodesScreen both
  // mount and call useMesh(), and without this guard each would register its
  // own DeviceEventEmitter listener causing duplicate chunk processing.
  useEffect(() => {
    if (ble.isReady && nodesSlice.myNodeId && !_autoStarted) {
      _autoStarted = true;
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

      // Layer 1 — own-message filter (FIRST — most reliable, restart-proof).
      // raw.src is the originator's srcIdHex (first 4 hex chars of their UUID,
      // encoded as 2 bytes in the BLE advertisement packet). We compare it
      // against the same 4-char prefix of our own UUID. If they match, this
      // is our own message echoed back by a relay phone — drop it immediately.
      // This MUST run before _processedMids so it works even after an app
      // restart when the module-level Set is freshly empty, and also covers
      // the edge case where myNodeIdRef.current was not yet populated when
      // _processedMids was checked.
      const myId = myNodeIdRef.current;
      if (myId) {
        const myShortId = myId.replace(/-/g, '').slice(0, 4);
        if (raw.src === myShortId) return;
      }

      // Layer 2 — module-level permanent Set (fast dedup for all other msgs).
      if (_processedMids.has(raw.mid)) return;

      // Layer 3 — Redux seenIds via always-fresh ref (backup check)
      if (seenIdsRef.current.includes(raw.mid)) return;

      // Mark seen at ALL layers before doing any work so that if this callback
      // is somehow re-entered (e.g. rapid relay echo), it's immediately blocked.
      _processedMids.add(raw.mid);
      msgsSlice.dispatch(msgsSlice.addSeenId(raw.mid));

      // Resolve sender display name — read through ref so we always get the
      // latest nearbyNodes list, even if the presence beacon arrived after
      // this callback was first registered.
      const srcHex = raw.src ?? '';
      const peerNode = nearbyNodesRef.current.find(n =>
        n.node_id.replace('phone-', '').startsWith(srcHex),
      );
      const sourceName = peerNode?.name || `Peer-${srcHex.slice(0, 4)}`;

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
        // Notify user — single vibration + notification panel entry
        showMessageNotification(sourceName, msg.payload).catch(() => {});
        // Relay via BLE advertisement so phones not directly in range of the
        // original sender can still receive the message (multi-hop delivery)
        phoneMesh.broadcastMessage(messageToPacket(msg)).catch(() => {});
        // Relay to any connected ESP32 nodes
        transmitToAllNodes(msg);
        // Increment relay count for the source node so the Nodes screen shows it
        if (peerNode) {
          nodesSlice.dispatch(nodesSlice.incrementRelayCount(peerNode.node_id));
        }
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

      // Mark the message ID as seen at ALL dedup layers BEFORE any async
      // operation. This closes the timing window where a relay echo could
      // arrive during the await below and slip past the checks.
      //
      //   _processedMids — module-level permanent Set, shared across all
      //                    useMesh() instances, never reset, never stale
      //   seenMids        — service-level Set inside PhoneMeshService
      //   Redux seenIds   — for the useRef-based hook-level check
      //
      // Both the 8-char BLE chunk ID and the full UUID are added so that
      // no matter which form appears in a relay's raw.mid, it is blocked.
      const shortMid = msg.message_id.replace(/-/g, '').slice(0, 8);
      _processedMids.add(shortMid);
      _processedMids.add(msg.message_id);
      msgsSlice.dispatch(msgsSlice.addSeenId(shortMid));
      getPhoneMeshService().markMessageSeen(shortMid);

      // Optimistically add to local history
      await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));

      const packet = messageToPacket(msg);
      let broadcastOk = false;

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

        // ── Own-message guard ─────────────────────────────────────────────────
        // packet.src is the originator's full UUID (written by sendMessage →
        // messageToPacket). If it matches our device ID this message was sent
        // by us and is now being echoed back by an ESP32 relay — drop it.
        // This check uses myNodeIdRef (loaded from AsyncStorage) so it works
        // correctly even after an app restart when _processedMids is empty.
        if (myNodeIdRef.current && packet.src === myNodeIdRef.current) return;

        // Use module-level permanent dedup first (same as phoneMesh path)
        if (_processedMids.has(packet.mid)) return;
        if (seenIdsRef.current.includes(packet.mid)) return;

        _processedMids.add(packet.mid);
        msgsSlice.dispatch(msgsSlice.addSeenId(packet.mid));

        const msg = packetToMessage(packet);
        if (isExpired(msg) || msg.hops > MAX_HOPS) return;

        await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));
        // Notify user — single vibration + notification panel entry
        showMessageNotification(msg.source_name, msg.payload).catch(() => {});

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
    // Stop scanning — no new messages or nodes will be received
    ble.stopScan();
    // Clear broadcast queue + stop advertising — no more chunks go out
    const phoneMesh = getPhoneMeshService();
    phoneMesh.stopAllBroadcasting().catch((_: any) => {});
    // Reset module-level auto-start flag so the next startDiscovery()
    // (or app re-navigation) can trigger a fresh scan.
    _autoStarted = false;
  }, [ble.stopScan]);

  return {
    messages: msgsSlice.messages,
    pendingCount: msgsSlice.pendingQueue.length,
    nearbyNodes: nodesSlice.nearbyNodes,
    connectedNodeIds: nodesSlice.connectedNodeIds,
    // Use Redux isScanning (shared state) instead of ble.isScanning (local to
    // this useBLE instance). Multiple tab screens each create their own useMesh
    // → useBLE instance. When the Nodes screen stops scanning, its useBLE local
    // state updates but the Chat screen's useBLE instance still reads true.
    // Redux isScanning is updated by whichever instance calls stopScan() and
    // reflects the real state across all screens immediately.
    isScanning: nodesSlice.isScanning,
    myNodeId: nodesSlice.myNodeId,
    myDisplayName: nodesSlice.myDisplayName,
    sendMessage,
    startDiscovery,
    stopDiscovery,
    connectToNode: ble.connectToNode,
    disconnectFromNode: ble.disconnectFromNode,
  };
}
