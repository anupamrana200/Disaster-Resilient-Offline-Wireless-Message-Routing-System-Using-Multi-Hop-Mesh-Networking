/**
 * PhoneMeshAdapter — returns real or mock PhoneMeshService based on environment.
 */

import { IS_EXPO_GO } from './ble-adapter';

let _phoneMeshInstance: any = null;

export function getPhoneMeshService(): any {
  if (_phoneMeshInstance) return _phoneMeshInstance;

  if (IS_EXPO_GO) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _phoneMeshInstance = require('./mock-phone-mesh.service').default.getInstance();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _phoneMeshInstance = require('./phone-mesh.service').default.getInstance();
  }

  return _phoneMeshInstance;
}
