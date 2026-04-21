/**
 * NodeCard — displays a single discovered BLE mesh node.
 * Shows type icon, name, RSSI signal bar, last-seen time.
 * Connect/Disconnect button only shown for ESP32 nodes (not phone peers).
 * Phone peers communicate via BLE advertising — no GATT connection needed.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MeshNode } from '@/types';

interface Props {
  node: MeshNode;
  onConnect: (nodeId: string) => void;
  onDisconnect: (nodeId: string) => void;
  isConnecting?: boolean;
}

function RssiBar({ rssi }: { rssi: number }) {
  // Map RSSI: -40 (strong) → -100 (weak) to 5 → 1 bars
  const bars = Math.max(1, Math.min(5, Math.round((rssi + 100) / 12)));
  return (
    <View style={styles.rssiContainer}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[
            styles.rssiBar,
            { height: i * 4 + 4 },
            i <= bars ? styles.rssiBarActive : styles.rssiBarInactive,
          ]}
        />
      ))}
    </View>
  );
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function NodeCard({ node, onConnect, onDisconnect, isConnecting }: Props) {
  const isMeshtastic = node.type === 'meshtastic';
  const isPhone = node.type === 'ble-phone';

  const typeLabel = isMeshtastic ? 'LoRa Gateway (Meshtastic)' : '📶 Phone Peer (Mesh)';
  const typeIcon = isMeshtastic ? '📡' : '📱';

  // Phone peers use connectionless advertising — no GATT connection needed
  const showConnectButton = isMeshtastic;

  return (
    <View style={[styles.card, node.is_connected && styles.cardConnected, isPhone && styles.cardPhone, isMeshtastic && styles.cardMeshtastic]}>
      {/* Left: icon + info */}
      <View style={styles.left}>
        <View style={[
          styles.iconBox,
          node.is_connected && styles.iconBoxConnected,
          isPhone && styles.iconBoxPhone,
          isMeshtastic && !node.is_connected && styles.iconBoxMeshtastic,
        ]}>
          <Text style={styles.icon}>{typeIcon}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{node.name}</Text>
          <Text style={[styles.type, isPhone && styles.typePhone, isMeshtastic && styles.typeMeshtastic]}>{typeLabel}</Text>
          <Text style={styles.meta}>
            {node.relay_count > 0 ? `↷ ${node.relay_count} relayed · ` : ''}
            {timeAgo(node.last_seen)}
          </Text>
        </View>
      </View>

      {/* Right: RSSI + connect (ESP32 only) */}
      <View style={styles.right}>
        <RssiBar rssi={node.rssi} />
        <Text style={styles.rssiLabel}>{node.rssi} dBm</Text>
        {showConnectButton ? (
          <TouchableOpacity
            id={`node-${node.node_id}-connect`}
            style={[
              styles.connectButton,
              node.is_connected ? styles.disconnectButton : styles.connectButtonIdle,
            ]}
            onPress={() => node.is_connected ? onDisconnect(node.node_id) : onConnect(node.node_id)}
            disabled={isConnecting}
            activeOpacity={0.8}
          >
            <Text style={styles.connectLabel}>
              {isConnecting ? '...' : node.is_connected ? 'Disconnect' : 'Connect'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.meshBadge}>
            <Text style={styles.meshBadgeText}>Auto-Mesh</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a2133',
    borderRadius: 16,
    padding: 14,
    marginVertical: 5,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  cardConnected: {
    borderColor: '#00c896',
    backgroundColor: '#0d1f18',
    shadowColor: '#00c896',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  cardPhone: {
    borderColor: 'rgba(96,180,255,0.25)',
    backgroundColor: '#131d30',
  },
  cardMeshtastic: {
    borderColor: 'rgba(255,159,10,0.35)',
    backgroundColor: '#1e1a0d',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  iconBox: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#0d1117',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  iconBoxConnected: {
    borderColor: '#00c896',
    backgroundColor: '#00c89615',
  },
  iconBoxPhone: {
    borderColor: 'rgba(96,180,255,0.3)',
    backgroundColor: '#60b4ff15',
  },
  icon: { fontSize: 22 },
  info: { flex: 1 },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f2f5',
    fontFamily: 'OpenSans-Bold',
  },
  type: {
    fontSize: 11,
    color: '#60b4ff',
    fontFamily: 'OpenSans-Semibold',
    marginTop: 2,
  },
  typePhone: {
    color: '#60b4ff',
  },
  typeMeshtastic: {
    color: '#ff9f0a',
  },
  iconBoxMeshtastic: {
    borderColor: 'rgba(255,159,10,0.4)',
    backgroundColor: '#ff9f0a15',
  },
  meta: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'OpenSans-Regular',
    marginTop: 2,
  },
  right: {
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  rssiContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 24,
  },
  rssiBar: {
    width: 5,
    borderRadius: 2,
  },
  rssiBarActive: { backgroundColor: '#00c896' },
  rssiBarInactive: { backgroundColor: 'rgba(255,255,255,0.15)' },
  rssiLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'OpenSans-Regular',
  },
  connectButton: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  connectButtonIdle: {
    backgroundColor: '#00c896',
  },
  disconnectButton: {
    backgroundColor: '#ff453a22',
    borderWidth: 1,
    borderColor: '#ff453a',
  },
  connectLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
    fontFamily: 'OpenSans-Bold',
  },
  meshBadge: {
    backgroundColor: '#60b4ff22',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'rgba(96,180,255,0.3)',
  },
  meshBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#60b4ff',
    fontFamily: 'OpenSans-Bold',
  },
});
