// ---------------------------------------------------------------------------
// Shared constants for the guild application feature.
// ---------------------------------------------------------------------------

// customId namespace tokens. Kept here so command + handlers agree.
const IDS = {
  START_BUTTON:    'guildapp:start',  // public "Start Application" button
  MODAL:           'guildapp:modal',  // the 4-input modal (IGN/Playstyle/PrevGuild/Inviter)
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
];

// Modal text-input customIds.
const FIELDS = {
  IGN:           'ign',
  PLAYSTYLE:     'playstyle',
  PREVIOUS_GUILD:'prevguild',
  INVITER:       'inviter',
};

module.exports = { IDS, FIELDS, REVIEWER_ROLE_IDS, ROLE_IDS, CLASS_ROLE_BY_ID };
