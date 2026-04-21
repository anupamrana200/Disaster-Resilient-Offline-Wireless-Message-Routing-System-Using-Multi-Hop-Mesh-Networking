/**
 * Nodes Screen — BLE discovery and node management.
 *
 * Features:
 *   - Animated radar during scan
 *   - Live list of nearby BLE nodes
 *   - Connect/disconnect per node
 *   - Stats: connected count, total discovered, messages relayed
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useMesh } from '@/hooks/useMesh';
import NodeCard from '@/components/nodes/NodeCard';
import RadarAnimation from '@/components/nodes/RadarAnimation';
import { MeshNode } from '@/types';

export default function NodesScreen() {
  const {
    nearbyNodes,
    connectedNodeIds,
    isScanning,
    startDiscovery,
    stopDiscovery,
    connectToNode,
    disconnectFromNode,
  } = useMesh();

  const [connectingId, setConnectingId] = useState<string | null>(null);

  const handleConnect = useCallback(async (nodeId: string) => {
    setConnectingId(nodeId);
    await connectToNode(nodeId);
    setConnectingId(null);
  }, [connectToNode]);

  const handleDisconnect = useCallback(async (nodeId: string) => {
    await disconnectFromNode(nodeId);
  }, [disconnectFromNode]);

  const toggleScan = () => {
    if (isScanning) stopDiscovery();
    else startDiscovery();
  };

  const phonePeers = nearbyNodes.filter(n => n.type === 'ble-phone').length;
  const espNodes = nearbyNodes.filter(n => n.type === 'meshtastic').length;
  const totalRelayed = nearbyNodes.reduce((sum, n) => sum + n.relay_count, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={['#0a0e1a', '#0d1117']} style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Mesh Nodes</Text>
          <Text style={styles.subtitle}>DisasterMesh devices in your network</Text>
        </View>

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <StatBox label="📱 Phones" value={phonePeers} color="#60b4ff" />
          <StatBox label="📡 Meshtastic" value={espNodes} color="#ff9f0a" />
          <StatBox label="↷ Relayed" value={totalRelayed} color="#00c896" />
        </View>

        {/* Radar */}
        <View style={styles.radarContainer}>
          <RadarAnimation size={200} isActive={isScanning} />
          <TouchableOpacity
            id="nodes-scan-button"
            style={[styles.scanButton, isScanning && styles.scanButtonActive]}
            onPress={toggleScan}
            activeOpacity={0.85}
          >
            <Text style={styles.scanButtonText}>
              {isScanning ? '⏹ Stop Scan' : '📡 Start Scan'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Node List */}
        <View style={styles.listHeader}>
          <Text style={styles.listTitle}>
            {nearbyNodes.length === 0
              ? 'No nodes discovered'
              : `${nearbyNodes.length} node${nearbyNodes.length > 1 ? 's' : ''} found`}
          </Text>
        </View>

        <FlatList
          id="nodes-list"
          data={[...nearbyNodes].sort((a, b) => b.rssi - a.rssi)} // Sort by signal strength
          keyExtractor={(item: MeshNode) => item.node_id}
          renderItem={({ item }) => (
            <NodeCard
              node={item}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              isConnecting={connectingId === item.node_id}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                {isScanning
                  ? 'Searching for nearby nodes...'
                  : 'Tap "Start Scan" to discover nodes'}
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={isScanning}
              onRefresh={startDiscovery}
              tintColor="#00c896"
              colors={['#00c896']}
            />
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.statBox, { borderColor: color + '33' }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0e1a' },
  container: { flex: 1 },

  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#f0f2f5',
    fontFamily: 'OpenSans-Bold',
  },
  subtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    fontFamily: 'OpenSans-Regular',
    marginTop: 2,
  },

  statsRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 12,
    gap: 8,
  },
  statBox: {
    flex: 1,
    backgroundColor: '#1a2133',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
    fontFamily: 'OpenSans-Bold',
  },
  statLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    fontFamily: 'OpenSans-Semibold',
    marginTop: 2,
  },

  radarContainer: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 16,
  },
  scanButton: {
    backgroundColor: '#1a2133',
    borderRadius: 24,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,200,150,0.3)',
  },
  scanButtonActive: {
    backgroundColor: '#ff453a22',
    borderColor: '#ff453a',
  },
  scanButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    fontFamily: 'OpenSans-Bold',
  },

  listHeader: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  listTitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: 'OpenSans-Semibold',
  },

  listContent: { paddingBottom: 24 },

  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: 'OpenSans-Regular',
    textAlign: 'center',
  },
});
