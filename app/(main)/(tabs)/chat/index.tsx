/**
 * Chat Screen — main WhatsApp-style offline mesh messaging interface.
 *
 * Features:
 *   - Real-time message list (FlatList, auto-scrolls to bottom)
 *   - Connectivity status banner
 *   - Message bubbles with status icons + relay hop count
 *   - Text input with send button
 *   - Initializes device identity and BLE on mount
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  FlatList,
  Text,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNodeId } from '@/hooks/useNodeId';
import { useMesh } from '@/hooks/useMesh';
import MessageBubble from '@/components/chat/MessageBubble';
import ChatInput from '@/components/chat/ChatInput';
import StatusBanner from '@/components/chat/StatusBanner';
import { Message, MeshNode } from '@/types';

/**
 * Resolve the latest display name for a message sender by looking them up in
 * the live nearbyNodes list. The source_id of peer messages is 4 hex chars
 * (first 2 bytes of their device UUID), which matches the prefix of their
 * presence beacon's deviceIdHex. Falls back to the name stored on the message.
 */
function resolveSenderName(msg: Message, nearbyNodes: MeshNode[]): string {
  const peer = nearbyNodes.find(n => n.node_id.replace('phone-', '').startsWith(msg.source_id));
  return peer?.name || msg.source_name;
}

type RouteToast = { message: string; color: string } | null;

export default function ChatScreen() {
  const { deviceId, displayName: myDisplayName, isReady: nodeReady } = useNodeId();
  const {
    messages,
    pendingCount,
    nearbyNodes,
    connectedNodeIds,
    isScanning,
    sendMessage,
    // Pulled in additionally so the new SOS button can dispatch via the same
    // mesh — does not affect any of the existing chat-send behaviour.
    sendSOS,
  } = useMesh();

  // For status: count both GATT connections AND nearby phone peers
  const phonepeersCount = nearbyNodes.filter(n => n.type === 'ble-phone').length;
  const totalMeshPeers = connectedNodeIds.length + phonepeersCount;

  const listRef = useRef<FlatList<Message>>(null);

  // ─── Route toast ───────────────────────────────────────────────────────────
  const [routeToast, setRouteToast] = useState<RouteToast>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extended union — adds the two SOS-only outcomes ('no-permission' / 'no-fix')
  // so they can be surfaced to the user via the same toast affordance.
  type SOSRoute = 'meshtastic' | 'phone-mesh' | 'queued' | 'no-permission' | 'no-fix';
  const showRouteToast = useCallback(
    (route: SOSRoute) => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      const config: Record<SOSRoute, RouteToast> = {
        meshtastic: { message: '📡 Sent via Meshtastic (LoRa)', color: '#ff9f0a' },
        'phone-mesh': { message: '📱 Broadcasting via phone mesh', color: '#60b4ff' },
        queued: { message: '⏳ Queued — no nodes nearby', color: '#ff453a' },
        // Distinct messages for the SOS-only failure modes so users know what to fix
        'no-permission': { message: '🚫 Location permission needed for SOS', color: '#ff453a' },
        'no-fix': { message: '📡 Could not get GPS fix — try outdoors', color: '#ff9f0a' },
      };
      setRouteToast(config[route]);
      toastOpacity.setValue(0);
      Animated.sequence([
        Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(2200),
        Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => setRouteToast(null));
    },
    [toastOpacity],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const route = await sendMessage(text);
      showRouteToast(route);
    },
    [sendMessage, showRouteToast],
  );

  // SOS handler — delegates to useMesh.sendSOS() then surfaces the result via
  // the same toast component. No additional UI gating because sendSOS handles
  // permission + GPS errors internally and reports them through the route token.
  const handleSOS = useCallback(async () => {
    const route = await sendSOS();
    showRouteToast(route);
  }, [sendSOS, showRouteToast]);

  // ─── Receiver location (best-effort) ─────────────────────────────────────
  // Used only by SOSCard to render "X km NE of you" — purely a UX nicety,
  // never blocks anything else. GPS module is required lazily so a missing
  // expo-location won't break the chat screen.
  const [myLocation, setMyLocation] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Location = require('expo-location');
        // Don't request permissions here — only consume what the user already
        // granted. The SOS-send path explicitly requests permission when needed.
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;
        // Cached last-known position is good enough for distance hints. We
        // intentionally avoid a fresh GPS fix here so the chat screen mounts fast.
        const fix = await Location.getLastKnownPositionAsync();
        if (fix?.coords) {
          setMyLocation({ lat: fix.coords.latitude, lon: fix.coords.longitude });
        }
      } catch (_) {
        // Module missing / any other error — silently leave myLocation as null.
        // SOSCard handles the null case by simply omitting the distance line.
      }
    })();
  }, []);

  // Scanning starts automatically inside useMesh once BLE is ready.

  // Auto-scroll to latest message
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length]);

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>📡</Text>
      <Text style={styles.emptyTitle}>No messages yet</Text>
      <Text style={styles.emptySubtitle}>
        Messages sent here will be relayed over the{'\n'}LoRa mesh network — no internet needed.
      </Text>
    </View>
  );

  function formatDateSeparator(timestamp: number): string {
    const d = new Date(timestamp);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // Group messages with date separators
  const renderWithSeparators = () => {
    const items: (Message | { type: 'separator'; label: string; key: string })[] = [];
    let lastDate = '';
    for (const msg of messages) {
      const dateLabel = formatDateSeparator(msg.timestamp);
      if (dateLabel !== lastDate) {
        items.push({ type: 'separator', label: dateLabel, key: `sep-${msg.timestamp}` });
        lastDate = dateLabel;
      }
      items.push(msg);
    }
    return items;
  };

  const flatItems = renderWithSeparators();

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={['#0a0e1a', '#0d1117', '#0a0e1a']} style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>⬡</Text>
            </View>
            <View>
              <Text style={styles.headerTitle}>Mesh Network</Text>
              <Text style={styles.headerSub}>
                {totalMeshPeers > 0
                  ? `${totalMeshPeers} device${totalMeshPeers > 1 ? 's' : ''} in mesh`
                  : isScanning
                    ? 'Scanning...'
                    : 'Offline'}
              </Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.myIdLabel}>You</Text>
            <Text style={styles.myId} numberOfLines={1} ellipsizeMode="tail">
              {myDisplayName || (deviceId ? deviceId.slice(0, 8) + '…' : '—')}
            </Text>
          </View>
        </View>

        {/* Status Banner */}
        <StatusBanner
          isScanning={isScanning}
          connectedCount={totalMeshPeers}
          pendingCount={pendingCount}
        />

        {/* Message list + input — wrapped so the input stays visible above keyboard */}
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}>
          <FlatList
            ref={listRef}
            id="chat-message-list"
            data={flatItems as any}
            keyExtractor={(item: any) => (item.type === 'separator' ? item.key : item.message_id)}
            renderItem={({ item }: any) => {
              if (item.type === 'separator') {
                return (
                  <View style={styles.separatorRow}>
                    <View style={styles.separatorLine} />
                    <Text style={styles.separatorLabel}>{item.label}</Text>
                    <View style={styles.separatorLine} />
                  </View>
                );
              }
              const msg = item as Message;
              const resolvedMsg =
                msg.source_id === deviceId
                  ? msg
                  : { ...msg, source_name: resolveSenderName(msg, nearbyNodes) };
              return (
                // myLocation enables the "X km NE of you" line on incoming
                // SOS cards. Plain chat bubbles ignore the prop entirely.
                <MessageBubble
                  message={resolvedMsg}
                  isOwn={msg.source_id === deviceId}
                  myLocation={myLocation}
                />
              );
            }}
            ListEmptyComponent={renderEmpty}
            contentContainerStyle={[
              styles.listContent,
              messages.length === 0 && styles.listContentEmpty,
            ]}
            showsVerticalScrollIndicator={false}
          />

          {/* Input Bar — onSOS is the new optional hook that activates the
              red 🆘 button. Existing send behaviour is untouched. */}
          <ChatInput onSend={handleSend} onSOS={handleSOS} disabled={!nodeReady} />
        </KeyboardAvoidingView>

        {/* Route toast — shows which channel was used after sending */}
        {routeToast && (
          <Animated.View
            style={[styles.routeToast, { opacity: toastOpacity, borderColor: routeToast.color }]}>
            <Text style={[styles.routeToastText, { color: routeToast.color }]}>
              {routeToast.message}
            </Text>
          </Animated.View>
        )}
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0e1a',
  },
  container: {
    flex: 1,
  },
  // ─── Header ──────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#00c89622',
    borderWidth: 1.5,
    borderColor: '#00c896',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 20,
    color: '#00c896',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f0f2f5',
    fontFamily: 'OpenSans-Bold',
  },
  headerSub: {
    fontSize: 12,
    color: '#60b4ff',
    fontFamily: 'OpenSans-Regular',
    marginTop: 1,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  myIdLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'OpenSans-Regular',
  },
  myId: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'OpenSans-Regular',
    maxWidth: 100,
  },
  // ─── Keyboard-aware wrapper ───────────────────────────────────────────────
  keyboardView: {
    flex: 1,
  },
  // ─── List ─────────────────────────────────────────────────────────────────
  listContent: {
    paddingTop: 8,
    paddingBottom: 12,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // ─── Date Separator ───────────────────────────────────────────────────────
  separatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
    marginHorizontal: 20,
    gap: 10,
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  separatorLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'OpenSans-Semibold',
  },
  // ─── Route Toast ─────────────────────────────────────────────────────────
  routeToast: {
    position: 'absolute',
    bottom: 90,
    alignSelf: 'center',
    backgroundColor: '#0d1117',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  routeToastText: {
    fontSize: 13,
    fontFamily: 'OpenSans-Semibold',
  },
  // ─── Empty State ──────────────────────────────────────────────────────────
  emptyContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f0f2f5',
    fontFamily: 'OpenSans-Bold',
    marginBottom: 10,
  },
  emptySubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    lineHeight: 22,
    fontFamily: 'OpenSans-Regular',
  },
});
