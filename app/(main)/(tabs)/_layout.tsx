/**
 * Tab Navigation Layout — DisasterMesh
 * Three tabs: Chat | Nodes | Settings
 */

import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function TabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>
      {icon}
    </Text>
  );
}

export default function TabLayout() {
  // bottom inset is 0 on gesture-nav phones (the system handles the gap)
  // and equals the nav-bar height on 3-button-nav phones so the tab bar
  // sits above the system navigation bar instead of behind it.
  const { bottom } = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0d1117',
          borderTopColor: 'rgba(255,255,255,0.07)',
          borderTopWidth: 1,
          height: 60 + bottom,
          paddingBottom: 8 + bottom,
          paddingTop: 4,
        },
        tabBarInactiveTintColor: 'rgba(255,255,255,0.35)',
        tabBarActiveTintColor: '#00c896',
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      {/* Hide legacy index route */}
      <Tabs.Screen name="index" options={{ href: null }} />

      {/* Chat */}
      <Tabs.Screen
        name="chat/index"
        options={{
          title: 'Chat',
          tabBarIcon: ({ focused }) => <TabIcon icon="💬" focused={focused} />,
        }}
      />

      {/* Node Discovery */}
      <Tabs.Screen
        name="nodes/index"
        options={{
          title: 'Nodes',
          tabBarIcon: ({ focused }) => <TabIcon icon="📡" focused={focused} />,
        }}
      />

      {/* Settings */}
      <Tabs.Screen
        name="settings/index"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon icon="⚙️" focused={focused} />,
        }}
      />

      {/* Hide old home/profile tabs */}
      <Tabs.Screen name="home" options={{ href: null }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  );
}
