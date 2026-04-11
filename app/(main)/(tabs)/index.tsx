import { Redirect } from 'expo-router';

// (tabs)/index is hidden in _layout, this redirect is a safety net
export default function TabsIndex() {
  return <Redirect href="/(main)/(tabs)/chat" />;
}
