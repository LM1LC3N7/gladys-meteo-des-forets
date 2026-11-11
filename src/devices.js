// -----------------------------------------------------------------------------
// The Gladys devices and their states. Pure.
//
// External ids (forever):
//   dep:<code>               one department (01 ... 95, 2A, 2B)
//   dep:<code>:<feature key> its features
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { LEVEL } from './constants.js';
import { DEPARTMENTS } from './departments.js';
import { FEATURE_NAMES, deviceName } from './i18n.js';

/** Feature keys (forever). */
export const FEATURE = {
  TODAY: 'today',
  TOMORROW: 'tomorrow',
  BULLETIN: 'bulletin',
};

export const ids = {
  department: (gladys, code) => gladys.externalId(`dep:${code}`),
  feature: (deviceId, key) => `${deviceId}:${key}`,
};

/** The department code of one of our devices, or undefined for any other id. */
export function parseExternalId(externalId) {
  const match = /^ext:[^:]+:dep:([0-9AB]{2})$/.exec(String(externalId ?? ''));
  return match && DEPARTMENTS.has(match[1]) ? { code: match[1] } : undefined;
}

const feature = (deviceId, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(deviceId, key),
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** The device of one department. */
export function buildDepartmentDevice(gladys, code, language = 'fr') {
  const id = ids.department(gladys, code);
  const name = (key) => FEATURE_NAMES[key][language] ?? FEATURE_NAMES[key].en;
  const level = { min: LEVEL.min, max: LEVEL.max };
  return {
    name: deviceName(code, language),
    external_id: id,
    features: [
      feature(id, FEATURE.TODAY, name('today'), C.RISK, T.RISK.INTEGER, level),
      feature(id, FEATURE.TOMORROW, name('tomorrow'), C.RISK, T.RISK.INTEGER, level),
      feature(id, FEATURE.BULLETIN, name('bulletin'), C.TEXT, T.TEXT.TEXT, {
        min: 0,
        max: 0,
        keep_history: false,
      }),
    ],
    params: [{ name: 'department', value: code }],
  };
}
