// ---------------------------------------------------------------------------
// Shared constants for the Party Finder feature.
// Ported from the reference bot.py / config.py.
// ---------------------------------------------------------------------------

const { CLASS_ROLE_BY_ID } = require('../guildapp/constants');

// customId namespace tokens. Kept here so command + handlers + router agree.
// Flow chain:
//   partyfinder:start                 (entry-card "Start Party" button)
//   partyfinder:carry                 (entry-card "I Need Carry" button)
//   pf:size                           (ephemeral party-size select)
//   pf:time:<sizeToken>               (ephemeral GMT+7 start-time select; value = epoch secs)
//   pf:details:<sizeToken>:<epoch>    (Party Details modal — sizeToken is a number or 'custom')
//   pf:rolesopen:<size>:<cat>:<epoch> (bridge button: Details reply -> Roles modal)
//   pf:roles:<size>:<cat>:<epoch>     (Roles Needed modal — size + cat + start epoch baked in)
//   pf:join:<category>:<partyId>      (Join as Tank/Heal/DPS)
//   pf:cancel:<partyId>               (leader cancels the party)
//   pf:carrydetails                   (I Need Carry — Details modal)
//   pf:carryrespond:<reqId>           (I'll carry this)
//   pf:carrycancel:<reqId>            (requester cancels the carry)
//
// IMPORTANT — Discord forbids responding to a modal-submit interaction with
// another modal (ModalSubmitInteraction has no showModal). So the Start Party
// flow NEVER chains modal->modal. The size field is folded into the Details
// modal for the Custom case, the start time is picked via the pf:time select
// BEFORE the Details modal (a select can't live inside a modal), and
// Details->Roles is bridged by an ephemeral "Set role counts" button. Every
// showModal in this module is reached only from a Button/Select/Command.
const IDS = {
  ENTRY_START:    'partyfinder:start',
  ENTRY_CARRY:    'partyfinder:carry',
  SIZE_SELECT:    'pf:size',
  TIME_SELECT:    'pf:time',           // pf:time:<sizeToken>  (GMT+7 start-time select)
  DETAILS_PREFIX: 'pf:details',        // pf:details:<sizeToken>:<startEpochSecs>
  ROLES_OPEN_PREFIX: 'pf:rolesopen',   // pf:rolesopen:<size>:<leaderCategory>:<startEpochSecs>
  ROLES_PREFIX:   'pf:roles',          // pf:roles:<size>:<leaderCategory>:<startEpochSecs>
  JOIN_PREFIX:    'pf:join',           // pf:join:<category>:<partyId>
  CANCEL_PREFIX:  'pf:cancel',         // pf:cancel:<partyId>
  CARRY_TIME_SELECT: 'pf:carrytime',   // pf:carrytime  (GMT+7 start-time select for carry)
  CARRY_DETAILS:  'pf:carrydetails',   // pf:carrydetails:<startEpochSecs>
  CARRY_RESPOND_PREFIX: 'pf:carryrespond', // pf:carryrespond:<reqId>
  CARRY_CANCEL_PREFIX:  'pf:carrycancel',  // pf:carrycancel:<reqId>
};

// Modal text-input customIds.
const FIELDS = {
  PARTY_SIZE:   'pf_party_size', // custom-size field, only on the Details(custom) modal
  EVENT_NAME:   'pf_event_name',
  SERVER_TIME:  'pf_server_time', // legacy — both flows now use a GMT+7 time select; kept to avoid churn
  POWER_RATING: 'pf_power_rating',
  TANK_COUNT:   'pf_tank_count',
  HEAL_COUNT:   'pf_heal_count',
  DPS_COUNT:    'pf_dps_count',
};

// ---------------------------------------------------------------------------
// Start-time select config (GMT+7 / UTC+7, 15-minute increments).
// ---------------------------------------------------------------------------
const TIME_ZONE_OFFSET_MINUTES = 7 * 60; // GMT+7
const TIME_ZONE_LABEL = 'GMT+7';
// User-facing zone phrasing — always make clear the times are SERVER time.
const TIME_ZONE_DISPLAY = 'Server time (GMT+7)';
const TIME_SLOT_STEP_MINUTES = 15;       // 15-min increments
const TIME_SLOT_LEAD_MINUTES = 30;       // earliest = now + 30 min, rounded up to next 15-min boundary
const TIME_SLOT_MAX_OPTIONS = 25;        // Discord select-menu option cap

// Channel where party/carry cards are posted (#party-finder).
const PARTY_FINDER_CHANNEL_ID = '1519235164956266606';

// Only holders of this role can click "I'll carry this".
const CARRY_ROLE_ID = '1519235731648811179';

// Recruitment closes this many minutes BEFORE the chosen start time (not a
// fixed window after posting). expiryEpochSecs = startEpochSecs - this*60.
// At expiry both party and carry posts are KEPT and edited to a grey closed
// state (countdown dropped, buttons removed).
const EXPIRY_LEAD_MINUTES_BEFORE_START = 15;

// Gate for the /partyfinder command AND the Start Party / I Need Carry entry
// buttons. ONE array constant so it's a one-line edit.
// Daddy member / Mummy member / Officer Daddy / Officer Mummy.
const PARTYFINDER_ROLE_IDS = [
  '1518076953595351191', // Daddy member
  '1518664863621320817', // Mummy member
  '1518076612787048548', // Officer Daddy
  '1518666580903329822', // Officer Mummy
];

// Preset party-size options shown in the dropdown. "Custom" -> modal.
const PARTY_SIZE_OPTIONS = ['5', '10', 'Custom'];

// Class role ID -> ORDERED list of categories that class may apply for.
// Order is significant: allowed[0] is the class's PRIMARY category, used for the
// Roles-modal prefill and as the first preference when seating the leader.
// This is the authoritative join-eligibility map (multi-role aware). A member
// may join/switch to any category present in the union of their class roles'
// allowed lists; clicking a category outside that union is rejected.
const CLASS_ALLOWED_CATEGORIES = {
  '1518174065892790343': ['DPS'],          // Assassin
  '1518235600833220789': ['DPS'],          // Blacksmith
  '1518235678163341422': ['DPS'],          // Druid  (confirmed DPS)
  '1518174090538778635': ['DPS'],          // Gunslinger
  '1518174067411259503': ['DPS'],          // Hunter
  '1518174089087422506': ['Tank', 'DPS'],  // Knight  (Tank primary, can also DPS)
  '1518174089817227415': ['DPS', 'Heal'],  // Priest  (DPS primary, can also Heal)
  '1518238680051875920': ['DPS'],          // Wizard
};

// Legacy single-category map. NO LONGER gates joins (CLASS_ALLOWED_CATEGORIES
// does). Retained for any incidental lookups; kept = allowed[0] for each class.
const CLASS_CATEGORY_BY_ROLE_ID = {
  '1518174089087422506': 'Tank', // Knight  (primary)
  '1518174089817227415': 'DPS',  // Priest  (primary)
  '1518174065892790343': 'DPS',  // Assassin
  '1518174067411259503': 'DPS',  // Hunter
  '1518174090538778635': 'DPS',  // Gunslinger
  '1518235600833220789': 'DPS',  // Blacksmith
  '1518238680051875920': 'DPS',  // Wizard
  '1518235678163341422': 'DPS',  // Druid
};

// Sanity: every class role in the shared roster must have an allowed-categories
// entry. (Logged once at load if they drift, so a future class-role add is caught.)
for (const roleId of Object.keys(CLASS_ROLE_BY_ID)) {
  if (!(roleId in CLASS_ALLOWED_CATEGORIES)) {
    console.warn(
      `[partyfinder] CLASS_ROLE_BY_ID has ${roleId} (${CLASS_ROLE_BY_ID[roleId]}) ` +
      `with no CLASS_ALLOWED_CATEGORIES entry — joins for that class will be blocked.`,
    );
  }
}

module.exports = {
  IDS,
  FIELDS,
  PARTY_FINDER_CHANNEL_ID,
  CARRY_ROLE_ID,
  EXPIRY_LEAD_MINUTES_BEFORE_START,
  PARTYFINDER_ROLE_IDS,
  PARTY_SIZE_OPTIONS,
  CLASS_ALLOWED_CATEGORIES,
  CLASS_CATEGORY_BY_ROLE_ID,
  CLASS_ROLE_BY_ID,
  TIME_ZONE_OFFSET_MINUTES,
  TIME_ZONE_LABEL,
  TIME_ZONE_DISPLAY,
  TIME_SLOT_STEP_MINUTES,
  TIME_SLOT_LEAD_MINUTES,
  TIME_SLOT_MAX_OPTIONS,
};
