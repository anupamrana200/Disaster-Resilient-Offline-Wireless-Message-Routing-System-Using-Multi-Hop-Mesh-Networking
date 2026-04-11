/**
 * postinstall.js — patches react-native-ble-advertiser for modern Android.
 *
 * Fixes:
 *   1. compileSdkVersion 28 → 34
 *   2. Adds namespace to build.gradle
 *   3. Removes package attribute from AndroidManifest.xml (conflicts with namespace)
 *   4. Adds BLUETOOTH_ADVERTISE permission
 *
 * Runs automatically after `npm install`.
 */

const fs = require('fs');
const path = require('path');

const bleAdvDir = path.join(__dirname, '..', 'node_modules', 'react-native-ble-advertiser', 'android');
const gradlePath = path.join(bleAdvDir, 'build.gradle');
const manifestPath = path.join(bleAdvDir, 'src', 'main', 'AndroidManifest.xml');

// ── Patch build.gradle ──────────────────────────────────────────────────────

if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, 'utf8');

  gradle = gradle.replace(/compileSdkVersion\s+\d+/, 'compileSdkVersion 34');
  gradle = gradle.replace(/buildToolsVersion\s+"[^"]+"/, 'buildToolsVersion "34.0.0"');
  gradle = gradle.replace(/targetSdkVersion\s+\d+/, 'targetSdkVersion 34');

  if (!gradle.includes('namespace')) {
    gradle = gradle.replace(
      /android\s*\{/,
      'android {\n    namespace "com.vitorpamplona.bleavertiser"',
    );
  }

  fs.writeFileSync(gradlePath, gradle, 'utf8');
  console.log('[postinstall] ✅ Patched react-native-ble-advertiser build.gradle');
} else {
  console.log('[postinstall] react-native-ble-advertiser not found, skipping');
  process.exit(0);
}

// ── Patch AndroidManifest.xml ───────────────────────────────────────────────

if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');

  // Remove package="..." attribute (namespace is in build.gradle now)
  manifest = manifest.replace(/\s+package="[^"]+"/, '');

  // Add BLUETOOTH_ADVERTISE if missing
  if (!manifest.includes('BLUETOOTH_ADVERTISE')) {
    manifest = manifest.replace(
      '</manifest>',
      '          <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />\n</manifest>',
    );
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[postinstall] ✅ Patched react-native-ble-advertiser AndroidManifest.xml');
}
