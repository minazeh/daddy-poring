// ---------------------------------------------------------------------------
// Shared constants for the guild application feature.
// ---------------------------------------------------------------------------

// customId namespace tokens. Kept here so command + handlers agree.
const IDS = {
  START_BUTTON:   'guildapp:start',   // public "Start Application" button
  MODAL:          'guildapp:modal',   // the 4-input modal (IGN/Playstyle/PrevGuild/Inviter)
  APPROVE_PREFIX: 'appapprove',       // appapprove:<applicantUserId>
  DENY_PREFIX:    'appdeny',          // appdeny:<applicantUserId>
};

// Role IDs for approval role management. Recruit is removed; ACCEPTED (Daddy) is added.
const ROLE_IDS = {
  RECRUIT:  '1518236545289551883',
  ACCEPTED: '1518076953595351191', // "Daddy"
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

module.exports = { IDS, FIELDS, REVIEWER_ROLE_IDS, ROLE_IDS };
