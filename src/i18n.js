// -----------------------------------------------------------------------------
// Runtime texts: feature names, level names, the bulletin text, the
// connection status and the Test button (English and French). Times are
// shown in Paris time, the time of the bulletins. Bounded (LIMITS).
// -----------------------------------------------------------------------------

import { LIMITS, MAX_DEPARTMENTS, TIMEZONE } from './constants.js';
import { DEPARTMENTS } from './departments.js';

export const FEATURE_NAMES = {
  today: { en: 'Fire danger today (1-4)', fr: "Danger feu aujourd'hui (1-4)" },
  tomorrow: { en: 'Fire danger tomorrow (1-4)', fr: 'Danger feu demain (1-4)' },
  bulletin: { en: 'Bulletin', fr: 'Bulletin' },
};

const LEVEL_NAMES = {
  en: ['Low', 'Moderate', 'High', 'Very high'],
  fr: ['Faible', 'Modéré', 'Élevé', 'Très élevé'],
};

/** The name of a level 1-4 ('?' when unknown). */
export function levelName(level, language = 'fr') {
  return (LEVEL_NAMES[language] ?? LEVEL_NAMES.en)[level - 1] ?? '?';
}

const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const formats = new Map();
function format(language, options) {
  const key = `${language}:${JSON.stringify(options)}`;
  if (!formats.has(key)) {
    formats.set(
      key,
      new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-GB', {
        timeZone: TIMEZONE,
        ...options,
      }),
    );
  }
  return formats.get(key);
}
/** `05/10/2026 16:50` (Paris). */
export const when = (ms, language) =>
  format(language, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
/** `05/10/2026` (Paris). */
export const day = (ms, language) =>
  format(language, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
/** `2026-10-06` -> `06/10`. */
const shortDate = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** The name of a department with its code: `Bouches-du-Rhône (13)`. */
export const departmentLabel = (code) => `${DEPARTMENTS.get(code) ?? code} (${code})`;

/** The device name. */
export const deviceName = (code, language) =>
  `${language === 'fr' ? 'Météo des forêts' : 'Forest fire weather'} - ${departmentLabel(code)}`;

/**
 * The text of the bulletin feature (≤ LIMITS.state). `kind`: 'recent' (the
 * department's bulletin is recent), 'missing' (in season, none recent for
 * this department), 'offSeason'.
 */
export function bulletinText({ kind, bulletin, j1Date, j2Date }, language) {
  const fr = language === 'fr';
  let text;
  if (kind === 'recent') {
    text = fr
      ? `Bulletin du ${when(bulletin.at, 'fr')} : ${shortDate(j1Date)} ${levelName(bulletin.j1, 'fr').toLowerCase()}, ${shortDate(j2Date)} ${levelName(bulletin.j2, 'fr').toLowerCase()}`
      : `Bulletin of ${when(bulletin.at, 'en')}: ${shortDate(j1Date)} ${levelName(bulletin.j1, 'en').toLowerCase()}, ${shortDate(j2Date)} ${levelName(bulletin.j2, 'en').toLowerCase()}`;
  } else {
    const last = bulletin
      ? fr
        ? ` Dernier : ${day(bulletin.at, 'fr')}.`
        : ` Last one: ${day(bulletin.at, 'en')}.`
      : '';
    text =
      kind === 'missing'
        ? fr
          ? `Pas de bulletin récent pour ce département.${last}`
          : `No recent bulletin for this department.${last}`
        : fr
          ? `Pas de bulletin (hors saison).${last}`
          : `No bulletin (off season).${last}`;
  }
  return cut(text, LIMITS.state);
}

const both = (en, fr) => ({ en, fr });

/** Join the lines of each language into one bounded status. */
export function joinLines(lines) {
  const join = (lang) =>
    cut(
      lines
        .map((l) => l[lang])
        .filter(Boolean)
        .join(' · '),
      LIMITS.status,
    );
  return { en: join('en'), fr: join('fr') };
}

export const T = {
  notStarted: both('The integration is starting, try again.', "L'intégration démarre, réessayez."),
  waitingConfig: (attempt) =>
    both(
      `Waiting for the configuration from Gladys (attempt ${attempt}).`,
      `En attente de la configuration de Gladys (essai ${attempt}).`,
    ),
  noDepartment: both(
    'No department: type the codes of the departments to follow (13, 2A...) in the configuration.',
    'Aucun département : indiquez les codes des départements à suivre (13, 2A...) dans la configuration.',
  ),
  invalid: (list) =>
    both(
      `Unknown department code(s) ignored: ${list.join(', ')} (mainland France and Corsica only).`,
      `Code(s) de département inconnu(s) ignoré(s) : ${list.join(', ')} (Hexagone et Corse seulement).`,
    ),
  tooMany: both(
    `${MAX_DEPARTMENTS} departments at most: the others are ignored.`,
    `${MAX_DEPARTMENTS} départements au plus : les autres sont ignorés.`,
  ),
  notCreated: (codes) =>
    both(
      `To create in Discovery: ${codes.join(', ')}.`,
      `À créer dans la Découverte : ${codes.join(', ')}.`,
    ),
  orphans: (names) =>
    both(
      `No longer in the configuration, not updated: ${names.join(', ')}.`,
      `Plus dans la configuration, non mis à jour : ${names.join(', ')}.`,
    ),
  bulletin: (at) =>
    both(
      `Latest bulletin: ${when(at, 'en')} (Paris time).`,
      `Dernier bulletin : ${when(at, 'fr')} (heure de Paris).`,
    ),
  offSeason: (at) =>
    at === undefined
      ? both('Off season: no bulletin this year.', 'Hors saison : pas de bulletin cette année.')
      : both(
          `Off season: no bulletin since ${day(at, 'en')}.`,
          `Hors saison : pas de bulletin depuis le ${day(at, 'fr')}.`,
        ),
  noFile: (year) =>
    both(
      `No bulletin yet in ${year} (off season, the file of the year does not exist yet).`,
      `Pas encore de bulletin en ${year} (hors saison, le fichier de l'année n'existe pas encore).`,
    ),
  unreadableLines: (n) =>
    both(
      `${n} unreadable line(s) of the file ignored.`,
      `${n} ligne(s) illisible(s) du fichier ignorée(s).`,
    ),
  next: (at) => both(`Next read: ${when(at, 'en')}.`, `Prochaine lecture : ${when(at, 'fr')}.`),
  failed: (message, at) =>
    both(
      `Météo-France file not read (${message}): next try ${when(at, 'en')}. The values shown are those of the last bulletin read.`,
      `Fichier Météo-France non lu (${message}) : prochain essai ${when(at, 'fr')}. Les valeurs affichées sont celles du dernier bulletin lu.`,
    ),
  paused: (until, status) =>
    both(
      `The server asked to wait (HTTP ${status}): next read ${when(until, 'en')}.`,
      `Le serveur demande d'attendre (HTTP ${status}) : prochaine lecture ${when(until, 'fr')}.`,
    ),
  notRead: both('Not read yet.', 'Pas encore lu.'),
  data: {
    unreadable: both(
      '/data was unreadable at the start: the memory of the bulletins and of the triggers was lost.',
      '/data était illisible au démarrage : la mémoire des bulletins et des déclencheurs est perdue.',
    ),
    unwritable: both('/data cannot be written.', "/data n'est pas inscriptible."),
    frozen: both('/data does not answer in time.', '/data ne répond pas à temps.'),
  },
  caveat: both(
    'Information only, never an alert system: follow the instructions of the prefecture.',
    'Information seulement, jamais un système d’alerte : suivez les consignes de la préfecture.',
  ),
};
