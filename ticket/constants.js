// ---------------------------------------------------------------------------
// Shared constants for the guild support ticket feature.
//
// Spec: docs/TICKET_SYSTEM_SPEC.md
// ---------------------------------------------------------------------------

// customId namespace. Kept here so the command, handlers and sticky agree.
//
// RESTART SAFETY: OPEN_BUTTON is a STATIC id — a panel posted months ago keeps
// working after any redeploy because nothing about it is held in memory. Every
// other id carries the ticket id, so a restarted process rebuilds full context
// from the click alone (see ACCEPT/DECLINE/RESOLVE below).
const IDS = {
  OPEN_BUTTON: 'ticket:open',        // public "Open Ticket" button on the panel
  MODAL:       'ticket:modal',       // the 2-field Subject/Message modal
  ACCEPT:      'ticket:accept',      // ticket:accept:<ticketId>
  DECLINE:     'ticket:decline',     // ticket:decline:<ticketId>
  DECLINE_MODAL: 'ticket:declinemodal', // ticket:declinemodal:<ticketId>
  RESOLVE:     'ticket:resolve',     // ticket:resolve:<ticketId>
};

// Modal component customIds.
const FIELDS = {
  SUBJECT:        'subject',
  MESSAGE:        'message',
  DECLINE_REASON: 'declinereason',
};

// Role permitted to run /guildsupport (post the panel) — the Godfathers.
// Same id used by /activitycampaign and /gvgschedule.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// Roles that may Accept a ticket AND mark it Resolved, and that are granted
// view access to every ticket channel. Conrad's list, 2026-08-15 — all seven
// hold BOTH powers, so this is one array rather than two.
//
// Identified against the codebase where possible:
//   1518076150692188200  Godfathers      (activitycampaign/constants.js:13)
//   1518076612787048548  Officer Daddy   (officerapp/constants.js:46)
//   1518666580903329822  Officer Mummy   (officerapp/constants.js:47)
//   1518666539182592080  guild-app reviewer (guildapp/constants.js:40)
// The remaining three appear NOWHERE else in the repo and could not be
// name-checked. A wrong id here fails SILENTLY — that role simply never sees
// ticket channels and nothing errors. Worth a glance before going live.
const TICKET_OFFICER_ROLE_IDS = [
  '1518076150692188200',
  '1518861067835412502',
  '1518076612787048548',
  '1518666539182592080',
  '1518666580903329822',
  '1518517404886372483',
  '1537890748945661972',
];

// Channels. Env-overridable so a test server can be pointed elsewhere without
// a code change; the literals are the live guild's ids (Conrad, 2026-08-15).
const CHANNELS = {
  // Ticket embeds (with Accept/Decline) land here for officers to action.
  OPEN_TICKETS: process.env.TICKET_OPEN_CHANNEL_ID || '1537891584593371218',
  // Transcripts are posted here when a ticket is resolved.
  TRANSCRIPTS:  process.env.TICKET_TRANSCRIPT_CHANNEL_ID || '1537891493598208000',
  // Parent category for the per-ticket private text channels.
  CATEGORY:     process.env.TICKET_CATEGORY_ID || '1537895407009665164',
};

// Discord's hard cap on children of a single category. This is the constraint
// that makes the resolve->delete lifecycle load-bearing rather than tidiness:
// at 50 live channels Accept starts failing and no new ticket can be opened.
// Checked BEFORE creating so the officer gets a real message instead of an
// opaque API error.
const CATEGORY_CHILD_LIMIT = 50;

// Embed field values cap at 1024 chars. A long-standing member's full role
// list WILL exceed this; over-length means Discord rejects the whole message
// and the ticket silently never appears. Truncation is not optional.
const EMBED_FIELD_LIMIT = 1024;

// Modal input caps.
const SUBJECT_MAX = 100;
const MESSAGE_MAX = 1000;
const DECLINE_REASON_MAX = 500;

// Grace period between a ticket being resolved (channel locked + renamed) and
// the channel being deleted. Gives officers a window to grab anything they
// missed; the transcript is already safe in CHANNELS.TRANSCRIPTS by then.
const DELETE_GRACE_MS = 24 * 60 * 60 * 1000;   // 24 hours

// How often the sweeper looks for locked channels past their grace period.
// Restart-safe: the sweep reads Mongo, so a bot that was down simply catches
// up on its next tick rather than losing the deletion.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;      // 30 minutes

// Sticky repost debounce — a chat burst inside this window collapses into one
// trailing repost. Matches the activity-campaign engine's behaviour.
const REPOST_COOLDOWN_MS = 5000;

// Colours.
const COLORS = {
  PANEL:    0x2b2d31,   // matches the guild-application panel
  OPEN:     0xf1c40f,
  ACCEPTED: 0x2ecc71,
  RESOLVED: 0x3498db,
  DECLINED: 0xe74c3c,
};

// ---------------------------------------------------------------------------
// Copy. Everything member-facing lives here so wording is a one-file edit.
// ---------------------------------------------------------------------------

const PANEL_TITLE = 'Guild Support';

const PANEL_DESCRIPTION =
  'Need help with something? Click **Open Ticket** below and tell us what\'s going on.\n\n' +
  'You\'ll be asked for:\n\n' +
  '**Subject** — a short summary of what this is about\n' +
  '**Message** — the details: what happened, when, and what you need\n\n' +
  'Once an officer picks it up, a **private channel** is created that only you and the ' +
  'officers can see. Everything stays between you and the officer team.\n\n' +
  'You can have one open ticket at a time. Please be patient — someone will get to you.';

const PANEL_BUTTON_LABEL = 'Open Ticket';

// The sticky that sits at the bottom of every open ticket channel.
const STICKY_TEXT =
  '📌 **This ticket is open.**\n' +
  'An officer will work through it with you here. When everything has been sorted, ' +
  'an officer clicks **Mark as Resolved** below — the conversation is saved to the ' +
  'transcript archive and this channel is closed.';

const STICKY_BUTTON_LABEL = 'Mark as Resolved';

// DMs — best-effort, never block the flow.
const DM = {
  accepted: (channel) =>
    `✅ Your support ticket has been picked up by an officer. A private channel has been ` +
    `opened for it: ${channel}\n\nHead over there and we'll take it from the top.`,
  resolved: () =>
    `✅ Your support ticket has been marked resolved — thanks for your patience! ` +
    `If it comes up again, just open a new ticket.`,
  declined: (reason) =>
    `Your support ticket was closed without a channel being opened.\n\n` +
    (reason ? `**Reason:** ${reason}\n\n` : '') +
    `If you think that was a mistake, or something has changed, you're welcome to open a new one.`,
};

module.exports = {
  IDS,
  FIELDS,
  GODFATHERS_ROLE_ID,
  TICKET_OFFICER_ROLE_IDS,
  CHANNELS,
  CATEGORY_CHILD_LIMIT,
  EMBED_FIELD_LIMIT,
  SUBJECT_MAX,
  MESSAGE_MAX,
  DECLINE_REASON_MAX,
  DELETE_GRACE_MS,
  SWEEP_INTERVAL_MS,
  REPOST_COOLDOWN_MS,
  COLORS,
  PANEL_TITLE,
  PANEL_DESCRIPTION,
  PANEL_BUTTON_LABEL,
  STICKY_TEXT,
  STICKY_BUTTON_LABEL,
  DM,
};
