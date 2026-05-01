/**
 * ChatInput — sticky bottom input bar for composing messages.
 * Features smooth keyboard-aware animation and a glowing send button.
 */

import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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
          <TouchableOpacity
            id="chat-sos-button"
            style={[styles.sosButton, sosBusy && styles.sosButtonBusy]}
            onPress={handleSOS}
            disabled={sosBusy || disabled}
            activeOpacity={0.8}
            accessibilityLabel="Send SOS with current location">
            {sosBusy ? (
              // Spinner — surfaces the GPS-fix delay so the user knows we are working
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sosIcon}>🆘</Text>
            )}
          </TouchableOpacity>
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
            <Text style={styles.sendIcon}>▲</Text>
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
    backgroundColor: '#2a3345',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonActive: {
    backgroundColor: '#00c896',
    shadowColor: '#00c896',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  // ─── SOS button ───────────────────────────────────────────────────────────
  // Distinct red colour to signal danger and avoid accidental taps. Same 48x48
  // size as the send button for layout symmetry.
  sosButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#ff453a', // System destructive red
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ff6961',
    shadowColor: '#ff453a',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  // Faded look while a GPS fix is in flight — communicates "we're working on it"
  sosButtonBusy: {
    opacity: 0.6,
  },
  sosIcon: {
    fontSize: 22,
  },
  sendIcon: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
});
