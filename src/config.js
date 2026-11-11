// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// Nothing in it is secret. Pure.
// -----------------------------------------------------------------------------

import { LANGUAGES, MAX_DEPARTMENTS } from './constants.js';
import { normalizeDepartment } from './departments.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  departments: '',
  language: 'fr',
};

/** Raw text of the departments field read at most (a pasted novel is cut). */
const MAX_RAW = 400;

/**
 * `{ departments: ['13', '2A'], invalid: ['971'], tooMany: false, language }`:
 * the codes in the order typed, without duplicates, MAX_DEPARTMENTS at most;
 * the invalid entries (cut, never more than 5 kept) for the status.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const language = String(source.language ?? DEFAULTS.language).toLowerCase();
  const rawList = Array.isArray(source.departments)
    ? source.departments.slice(0, 50).map(String).join(',')
    : source.departments;
  const text = typeof rawList === 'string' ? rawList.slice(0, MAX_RAW) : '';
  const departments = [];
  const invalid = [];
  let tooMany = false;
  for (const entry of text.split(/[\s,;]+/)) {
    if (entry === '') continue;
    const code = normalizeDepartment(entry);
    if (!code) {
      // Only printable ASCII is shown back, cut: never a control byte in the status.
      if (invalid.length < 5) invalid.push(entry.replace(/[^\x21-\x7e]/g, '?').slice(0, 8));
      continue;
    }
    if (departments.includes(code)) continue;
    if (departments.length >= MAX_DEPARTMENTS) {
      tooMany = true;
      continue;
    }
    departments.push(code);
  }
  return {
    departments,
    invalid,
    tooMany,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
