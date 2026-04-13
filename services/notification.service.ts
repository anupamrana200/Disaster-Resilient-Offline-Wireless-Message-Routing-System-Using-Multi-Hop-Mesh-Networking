/**
 * NotificationService — local push notifications for incoming mesh messages.
 *
 * Shows a system notification in the notification panel whenever a message
 * arrives via the BLE mesh. Also triggers a single hardware vibration pulse.
 *
 * Android channel: 'mesh-messages-v2' — HIGH importance, default sound, single
 * vibration (300 ms). Channel ID is versioned so it is recreated fresh on
 * devices that had a previous silent channel registered.
 *
 * On Android 13+ (API 33) the user is asked to grant POST_NOTIFICATIONS.
 */

import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';

const CHANNEL_ID = 'mesh-messages-v2'; // bumped so existing devices recreate it

// Controls how notifications appear when the app is in the FOREGROUND.
// Both alert and sound must be true here, otherwise the notification is silent
// even if the channel is configured for sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Call once on app start (inside _layout.tsx).
 * Creates the Android notification channel and requests runtime permission.
 * Returns true if the app is allowed to post notifications.
 */
export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Mesh Messages',
      description: 'Incoming messages from the DisasterMesh BLE mesh network',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 300],   // single 300 ms pulse
      enableVibrate: true,
      enableLights: true,
      lightColor: '#00c896',
      showBadge: true,
      // sound: undefined means use device default notification sound
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Show an immediate system notification for an incoming mesh message.
 * Also triggers a direct hardware vibration so the user feels one buzz
 * even if they have notification vibration turned off.
 *
 * Safe to call even if permissions were not granted — it will not throw.
 */
export async function showMessageNotification(
  senderName: string,
  messageText: string,
): Promise<void> {
  // Direct hardware vibration — one short pulse, independent of notification
  // settings. This is the most reliable way to ensure the device buzzes once.
  Vibration.vibrate(300);

  try {
    const body =
      messageText.length > 120 ? messageText.slice(0, 117) + '…' : messageText;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: senderName,
        body,
        sound: 'default',           // use device's default notification sound
        data: { type: 'mesh-message' },
        color: '#00c896',
        ...(Platform.OS === 'android' && {
          channelId: CHANNEL_ID,
          vibrate: [0, 300],
          priority: 'high' as const,
        }),
      },
      trigger: null, // fire immediately
    });
  } catch (err) {
    // Notification failure must never crash the messaging flow
    console.warn('[Notify] Failed to show notification:', err);
  }
}
