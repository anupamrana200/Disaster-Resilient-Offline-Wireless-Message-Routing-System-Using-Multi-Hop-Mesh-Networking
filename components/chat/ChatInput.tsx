/**
 * ChatInput — sticky bottom input bar for composing messages.
 * Features smooth keyboard-aware animation and a glowing send button.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';

interface Props {
  onSend: (text: string) => Promise<void>;
  /**
   * Optional SOS dispatcher. When provided, an additional red 🆘 button is
   * rendered to the LEFT of the input field. Tapping (or long-pressing) it
   * triggers the parent's SOS handler. Backwards-compatible — callers that
   * do not pass this prop see the original chat-only UI.
   */
  onSOS?: () => Promise<void> | void;
  disabled?: boolean;
}

export default function ChatInput({ onSend, onSOS, disabled = false }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Independent loading state for SOS so the chat send button stays responsive
  // while a slow GPS fix is in progress.
  const [sosBusy, setSosBusy] = useState(false);

  // Pulsing glow animation for the SOS button border
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 900, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  const sosBorderColor = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['#ff453a', '#ff9f9f'],
  });
  const sosShadowRadius = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [6, 16],
  });

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
    } finally {
      setSending(false);
    }
  };

  /**
   * Fire the SOS handler with a busy-state guard so rapid double-taps don't
   * dispatch two SOS messages back-to-back. The guard is released regardless
   * of success/failure so a retry after a denied permission still works.
   */
  const handleSOS = async () => {
    if (!onSOS || sosBusy || disabled) return;
    setSosBusy(true);
    try {
      await onSOS();
    } finally {
      setSosBusy(false);
    }
  };

  const canSend = text.trim().length > 0 && !sending && !disabled;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}>
      <View style={styles.container}>
        {/* SOS button — rendered ONLY when an onSOS handler is supplied so
            screens that don't want this affordance keep their original layout.
            Sits to the left of the input so it doesn't displace the send btn. */}
        {onSOS && (
          <Animated.View
            style={[
              styles.sosButton,
              sosBusy && styles.sosButtonBusy,
              { borderColor: sosBorderColor, shadowRadius: sosShadowRadius },
            ]}>
            <TouchableOpacity
              id="chat-sos-button"
              style={styles.sosInner}
              onPress={handleSOS}
              disabled={sosBusy || disabled}
              activeOpacity={0.75}
              accessibilityLabel="Send SOS with current location">
              {sosBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.sosLabel}>SOS</Text>
              )}
            </TouchableOpacity>
          </Animated.View>
        )}
        <View style={styles.inputWrapper}>
          <TextInput
            id="chat-message-input"
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type a message..."
            placeholderTextColor="rgba(255,255,255,0.35)"
            multiline
            maxLength={400}
            returnKeyType="default"
            selectionColor="#00c896"
          />
        </View>
        <TouchableOpacity
          id="chat-send-button"
          style={[styles.sendButton, canSend && styles.sendButtonActive]}
          onPress={handleSend}
          disabled={!canSend}
          activeOpacity={0.8}>
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <View style={styles.sendIconWrapper}>
              <View style={[styles.sendArrowStem, canSend && styles.sendArrowStemActive]} />
              <View style={[styles.sendArrowHead, canSend && styles.sendArrowHeadActive]} />
            </View>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: Platform.OS === 'ios' ? 28 : 10,
    backgroundColor: '#0d1117',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.07)',
    gap: 10,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: '#1e2535',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 48,
    maxHeight: 120,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,200,150,0.2)',
  },
  input: {
    color: '#f0f2f5',
    fontSize: 15,
    fontFamily: 'OpenSans-Regular',
    lineHeight: 21,
    padding: 0,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1a2133',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  sendButtonActive: {
    backgroundColor: '#00c896',
    borderColor: '#00c896',
    shadowColor: '#00c896',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 10,
    elevation: 8,
  },
  sendIconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
  },
  sendArrowStem: {
    width: 2,
    height: 9,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
    marginBottom: 1,
  },
  sendArrowStemActive: {
    backgroundColor: '#fff',
  },
  sendArrowHead: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'rgba(255,255,255,0.3)',
    position: 'absolute',
    top: 0,
  },
  sendArrowHeadActive: {
    borderBottomColor: '#fff',
  },
  // ─── SOS button ───────────────────────────────────────────────────────────
  // Circle with deep red fill, pulsing border glow, and bold white SOS text.
  // Deliberately larger than the send button (52px) to signal importance.
  sosButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#c0392b',
    borderWidth: 2.5,
    shadowColor: '#ff453a',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    elevation: 10,
    overflow: 'hidden',
  },
  sosInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosLabel: {
    fontSize: 14,
    fontWeight: '900',
    color: '#ffffff',
    fontFamily: 'OpenSans-Bold',
    letterSpacing: 1.5,
  },
  sosButtonBusy: {
    opacity: 0.55,
  },
});
