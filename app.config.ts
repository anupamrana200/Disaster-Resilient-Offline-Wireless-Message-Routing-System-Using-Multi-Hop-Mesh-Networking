import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const expoProjectId = process.env.EXPO_PROJECT_ID ?? '18adc0d0-eb1d-11e9-8009-d524ed5cc4a7';
  const expoConfig: ExpoConfig = {
    ...config,
    slug: process.env.EXPO_SLUG ?? 'disaster-mesh',
    name: process.env.EXPO_NAME ?? 'DisasterMesh',
    ios: {
      ...config.ios,
      bundleIdentifier:
        process.env.EXPO_IOS_BUNDLE_IDENTIFIER ?? 'com.disastermesh.app',
    },
    android: {
      ...config.android,
      package: process.env.EXPO_ANDROID_PACKAGE ?? 'com.disastermesh.app',
      permissions: [
        'android.permission.BLUETOOTH',
        'android.permission.BLUETOOTH_ADMIN',
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.BLUETOOTH_ADVERTISE',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.RECEIVE_BOOT_COMPLETED',
      ],
    },
    web: {
      ...config.web,
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/logo-sm.png',
    },
    updates: {
      enabled: false,
      url: `https://u.expo.dev/${expoProjectId}`,
    },
    extra: {
      ...config.extra,
      eas: { projectId: expoProjectId },
      env: process.env.ENV ?? 'development',
      apiUrl: process.env.API_URL ?? 'https://example.com',
      // add more env variables here...
    },
    plugins: [
      'expo-router',
      [
        'expo-notifications',
        {
          color: '#00c896',
          defaultChannel: 'mesh-messages',
        },
      ],
      'expo-asset',
      [
        'react-native-ble-plx',
        {
          isBackgroundEnabled: true,
          modes: ['peripheral', 'central'],
          bluetoothAlwaysPermission:
            'Allow DisasterMesh to use Bluetooth for mesh networking',
        },
      ],
      [
        'expo-splash-screen',
        {
          backgroundColor: '#ffffff',
          dark: {
            backgroundColor: '#101212',
          },
          image: './assets/images/logo-lg.png',
          imageWidth: 200,
          resizeMode: 'contain',
        },
      ],
      [
        'expo-font',
        {
          fonts: [
            './assets/fonts/OpenSans-Bold.ttf',
            './assets/fonts/OpenSans-BoldItalic.ttf',
            './assets/fonts/OpenSans-Italic.ttf',
            './assets/fonts/OpenSans-Regular.ttf',
            './assets/fonts/OpenSans-Semibold.ttf',
            './assets/fonts/OpenSans-SemiboldItalic.ttf',
          ],
        },
      ],
    ],
  };
  // console.log('[##] expo config', expoConfig);
  return expoConfig;
};
