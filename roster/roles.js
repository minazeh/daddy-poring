// ---------------------------------------------------------------------------
// Shared class → role logic (web-app parity). Single source of truth for the
// default class→role map so /guildroster (render.js) and /profile agree.
//
//   Knight = tank, Priest = healer, everything else / null = dps.
//   Prefer settings.classRoles when the global settings doc exists; otherwise
//   fall back to DEFAULT_CLASS_ROLES.
// ---------------------------------------------------------------------------

const DEFAULT_CLASS_ROLES = {
  Knight: 'tank',
  Priest: 'healer',
  Assassin: 'dps',
  Hunter: 'dps',
  Gunslinger: 'dps',
  Blacksmith: 'dps',
  Wizard: 'dps',
  Druid: 'dps',
};

// Display labels + emoji for each role.
const ROLE_LABEL = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };
const ROLE_EMOJI = { tank: '🛡️', healer: '⚕️', dps: '⚔️' };

// Resolve a className to a role string, preferring a provided classRoles map
// (from settings) over the default.
function classToRole(className, classRoles) {
  if (!className) return 'dps';
  const map = classRoles || DEFAULT_CLASS_ROLES;
  return map[className] || 'dps';
}

module.exports = {
  DEFAULT_CLASS_ROLES,
  ROLE_LABEL,
  ROLE_EMOJI,
  classToRole,
};
