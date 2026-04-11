/**
 * StatusBanner — top-of-chat status bar showing BLE connectivity state.
 * Animates in/out and changes colour based on network status.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';

interface Props {
  isScanning: boolean;
  connectedCount: number;
  pendingCount: number;
}

export default function StatusBanner({ isScanning, connectedCount, pendingCount }: Props) {
  const blink = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isScanning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(blink, { toValue: 0.3, duration: 700, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      blink.stopAnimation();
      blink.setValue(1);
    }
  }, [isScanning]);

  const { label, color, dot } = getBannerState(isScanning, connectedCount, pendingCount);

  return (
    <View style={[styles.banner, { backgroundColor: color + '22', borderBottomColor: color + '44' }]}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: isScanning ? blink : 1 }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
      {pendingCount > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{pendingCount} pending</Text>
        </View>
      )}
    </View>
  );
}

function getBannerState(
  isScanning: boolean,
  connectedCount: number,
  pendingCount: number,
): { label: string; color: string; dot: string } {
  if (connectedCount > 0 && isScanning) {
    return {
      label: `📶 ${connectedCount} device${connectedCount > 1 ? 's' : ''} in mesh — broadcasting`,
      color: '#00c896',
      dot: '●',
    };
  }
  if (connectedCount > 0) {
    return {
      label: `📶 ${connectedCount} device${connectedCount > 1 ? 's' : ''} in mesh`,
      color: '#00c896',
      dot: '●',
    };
  }
  if (isScanning) {
    return { label: '📡 Scanning for mesh peers...', color: '#60b4ff', dot: '◉' };
  }
  if (pendingCount > 0) {
    return { label: '📦 Messages queued — start scan to broadcast', color: '#ff9f0a', dot: '◉' };
  }
  return { label: '🔴 Offline — go to Nodes → Start Scan', color: '#ff453a', dot: '●' };
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 12,
    fontFamily: 'OpenSans-Semibold',
    flex: 1,
  },
  badge: {
    backgroundColor: 'rgba(255,159,10,0.2)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    color: '#ff9f0a',
    fontFamily: 'OpenSans-Semibold',
  },
});
