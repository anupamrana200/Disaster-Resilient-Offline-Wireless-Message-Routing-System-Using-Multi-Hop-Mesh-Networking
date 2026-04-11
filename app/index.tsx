import { Redirect } from 'expo-router';

export default function Index() {
  // Direct entry into the Chat tab (bypasses old boilerplate home)
  return <Redirect href="/(main)/(tabs)/chat" />;
}
