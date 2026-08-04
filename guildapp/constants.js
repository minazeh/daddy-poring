// ---------------------------------------------------------------------------
// Shared constants for the guild application feature.
// ---------------------------------------------------------------------------

// customId namespace tokens. Kept here so command + handlers agree.
const IDS = {
  START_BUTTON:    'guildapp:start',  // public "Start Application" button
  // The 5-component modal: IGN / Gear Rating / Prev Guild & Contribution / Inviter / Attendance
  MODAL:           'guildapp:modal',
  REVIEW_PREFIX:   'appreview',       // appreview:<action>:<applicantUserId>
};

// Class roles — self-assigned during onboarding. Used to detect applicant class from their roles.
const CLASS_ROLE_BY_ID = {
  '1518174065892790343': 'Assassin',
  '1518174067411259503': 'Hunter',
  '1518174089087422506': 'Knight',
  '1518174089817227415': 'Priest',
  '1518174090538778635': 'Gunslinger',
  '1518235600833220789': 'Blacksmith',
  '1518238680051875920': 'Wizard',
  '1518235678163341422': 'Druid',
};

// Role IDs for application review role management.
const ROLE_IDS = {
  RECRUIT:      '1518236545289551883',
  ACCEPTED:     '1518076953595351191', // "Daddy"   — Main Guild
  MUMMY:        '1518664863621320817', // "Mummy"   — Second Guild
  WAITING_LIST: '1518871692145852496', // Waiting List
};

// Role IDs permitted to Approve/Deny guild applications.
// Only members holding at least one of these roles may act on review buttons.
const REVIEWER_ROLE_IDS = [
  '1518076150692188200',
  '1518076612787048548',
  '1518666539182592080',
];

// Modal component customIds.
//
// Discord caps a modal at 5 top-level components, so the form is exactly 5 and
// there is no room for a 6th. `playstyle` was dropped (Conrad's call, 2026-08-04)
// to make room for the gear-rating and attendance questions. The old
// `prevguild` ("Previous Guild (CBT)") short input was replaced by the
// paragraph-style `prevguildcontrib`, which absorbs it.
const FIELDS = {
  IGN:              'ign',
  GEAR_RATING:      'gearrating',
  PREVIOUS_GUILD:   'prevguildcontrib', // paragraph: previous guild(s) + contribution
  INVITER:          'inviter',
  ATTENDANCE:       'attendance',       // StringSelect (Yes/No) inside a Label
};

// Values carried by the attendance select's two options, plus how each renders
// in the review embed. Reviewers scan this field, so it gets an emoji marker.
const ATTENDANCE_OPTIONS = [
  { label: 'Yes', value: 'yes', display: '✅ Yes' },
  { label: 'No',  value: 'no',  display: '❌ No'  },
];

module.exports = { IDS, FIELDS, ATTENDANCE_OPTIONS, REVIEWER_ROLE_IDS, ROLE_IDS, CLASS_ROLE_BY_ID };
