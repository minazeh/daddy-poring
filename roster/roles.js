// ---------------------------------------------------------------------------
// Shared class → role logic (web-app parity). Single source of truth for the
// default class→role map so /guildroster (render.js) and /profile agree.
//
//   Knight/Paladin = tank, Priest = healer, everything else / null = dps.
//   Prefer settings.classRoles when the global settings doc exists; otherwise
//   fall back to DEFAULT_CLASS_ROLES.
// ---------------------------------------------------------------------------

const DEFAULT_CLASS_ROLES = {
  Knight: 'tank',
  Paladin: 'tank',
  Priest: 'healer',
  Assassin: 'dps',
  Hunter: 'dps',
  Gunslinger: 'dps',
  Blacksmith: 'dps',
  Wizard: 'dps',
  Druid: 'dps',
  Monk: 'dps',
};

// Display labels + emoji for each role.
const ROLE_LABEL = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };
const ROLE_EMOJI = { tank: '🛡️', healer: '⚕️', dps: '⚔️' };

// Resolve a className to a role string, preferring a provided classRoles map
// (from settings) over the default.
function classToRole(className, classRoles) {
  if (!className) return 'dps';
  const map = classRoles || DEFAULT_CLASS_ROLES;
  // A class the settings doc predates (e.g. Paladin/Monk on a settings doc last
  // saved when there were only 8 classes) falls back to the DEFAULT map rather
  // than a blanket 'dps' — otherwise a new Tank class silently renders as DPS
  // until Settings is re-saved in the web app. No-op for classes the doc has.
  return map[className] || DEFAULT_CLASS_ROLES[className] || 'dps';
}

module.exports = {
  DEFAULT_CLASS_ROLES,
  ROLE_LABEL,
  ROLE_EMOJI,
  classToRole,
};
