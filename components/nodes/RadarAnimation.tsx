/**
 * RadarAnimation — animated radar sweep shown during BLE scanning.
 * Uses react-native-reanimated for a smooth 60fps rotation + pulse effect.
 */

import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  withSequence,
} from 'react-native-reanimated';

interface Props {
  size?: number;
  isActive: boolean;
}

export default function RadarAnimation({ size = 180, isActive }: Props) {
  const rotation = useSharedValue(0);
  const scale = useSharedValue(1);
  const ring1Opacity = useSharedValue(0);
  const ring2Opacity = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      // Radar sweep rotation
      rotation.value = withRepeat(
        withTiming(360, { duration: 2500, easing: Easing.linear }),
        -1,
        false,
      );
      // Pulse rings
      ring1Opacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 1200 }),
          withTiming(0, { duration: 1200 }),
        ),
        -1,
        false,
      );
      ring2Opacity.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 600 }),
          withTiming(0.4, { duration: 1200 }),
          withTiming(0, { duration: 1200 }),
        ),
        -1,
        false,
      );
      scale.value = withRepeat(
        withSequence(
          withTiming(1.04, { duration: 1200 }),
          withTiming(1, { duration: 1200 }),
        ),
        -1,
        true,
      );
    } else {
      rotation.value = 0;
      scale.value = 1;
      ring1Opacity.value = 0;
      ring2Opacity.value = 0;
    }
  }, [isActive]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: isActive ? 1 : 0.3,
  }));

  const ring1Style = useAnimatedStyle(() => ({ opacity: ring1Opacity.value }));
  const ring2Style = useAnimatedStyle(() => ({ opacity: ring2Opacity.value }));

  const r = size / 2;

  return (
    <Animated.View style={[{ width: size, height: size }, outerStyle]}>
      {/* Background circles */}
      {[0.25, 0.5, 0.75, 1].map((fraction, i) => (
        <View
          key={i}
          style={[
            styles.circle,
            {
              width: size * fraction,
              height: size * fraction,
              borderRadius: (size * fraction) / 2,
              top: r - (size * fraction) / 2,
              left: r - (size * fraction) / 2,
              borderColor: `rgba(0,200,150,${0.08 + i * 0.04})`,
            },
          ]}
        />
      ))}

      {/* Pulse rings */}
      <Animated.View
        style={[
          styles.circle,
          { width: size, height: size, borderRadius: r, top: 0, left: 0, borderColor: '#00c896' },
          ring1Style,
        ]}
      />
      <Animated.View
        style={[
          styles.circle,
          { width: size * 0.75, height: size * 0.75, borderRadius: size * 0.375, top: r * 0.25, left: r * 0.25, borderColor: '#60b4ff' },
          ring2Style,
        ]}
      />

      {/* Radar sweep wedge */}
      <Animated.View
        style={[
          styles.sweep,
          { width: size, height: size, borderRadius: r },
          sweepStyle,
        ]}
      >
        <View
          style={[
            styles.sweepLine,
            { width: r, height: 2, top: r - 1, left: r, backgroundColor: '#00c896' },
          ]}
        />
      </Animated.View>

      {/* Center dot */}
      <View style={[styles.centerDot, { top: r - 5, left: r - 5 }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  circle: {
    position: 'absolute',
    borderWidth: 1,
  },
  sweep: {
    position: 'absolute',
    overflow: 'hidden',
  },
  sweepLine: {
    position: 'absolute',
  },
  centerDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#00c896',
    shadowColor: '#00c896',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },
});
