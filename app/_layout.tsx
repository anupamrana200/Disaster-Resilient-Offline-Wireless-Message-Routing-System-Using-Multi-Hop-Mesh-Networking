import 'react-native-get-random-values'; // uuid polyfill — must be first import
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { loadImages, loadFonts } from '@/theme';
import Provider from '@/providers';
import { setupNotifications } from '@/services/notification.service';

// Keep splash visible until assets are ready
SplashScreen.preventAutoHideAsync();

function Router() {
  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadImages(), loadFonts()]);
      } catch (e) {
        // Fonts/images failed to load — continue anyway
        console.warn('[Layout] Asset preload failed:', e);
      } finally {
        // Always request notification permission — must run even if assets fail.
        // On Android 13+ this shows the system POST_NOTIFICATIONS dialog.
        try {
          await setupNotifications();
        } catch (e) {
          console.warn('[Layout] setupNotifications failed:', e);
        }
        SplashScreen.hideAsync();
      }
    })();
  }, []);

  return (
    <>
      <Slot />
      <StatusBar style="light" />
    </>
  );
}

export default function RootLayout() {
  return (
    <Provider>
      <Router />
    </Provider>
  );
}
