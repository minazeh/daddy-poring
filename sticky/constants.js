// ---------------------------------------------------------------------------
// Shared constants for the general-purpose sticky message feature.
//
// Spec: docs/STICKY_MESSAGE_SPEC.md
//
// /stickymessage set|edit|remove|list — an officer types content into a modal
// and the bot keeps that message at the BOTTOM of the channel, reposting it
// whenever conversation pushes it up (the same trick ticket/sticky.js and
// activitycampaign/sticky.js use — Discord cannot pin to the bottom).
// ---------------------------------------------------------------------------

const { GODFATHERS_ROLE_ID, TICKET_OFFICER_ROLE_IDS } = require('../ticket/constants');

// ---------------------------------------------------------------------------
// customId namespace.
//
// RESTART SAFETY: the only interaction this feature owns is the modal, and its
// customId CARRIES THE TARGET CHANNEL ID. A modal opened before a redeploy and
// submitted after it still lands in the right channel with no in-memory state —
// same property as ticket:accept:<ticketId>.
//
// `sticky:` is claimed by sticky/handlers.js route() and by nothing else in the
// bot (proven in scripts/sim-sticky-message.js, both directions).
// ---------------------------------------------------------------------------
const IDS = {
  // sticky:modal:<mode>:<channelId>  — mode is 'set' or 'edit'.
  //
  // Both modes write the IDENTICAL document; the mode rides along purely so the
  // ephemeral confirmation can say "replaced" for a `set` over an existing
  // sticky and "updated" for an `edit`. Deriving that from the stored document
  // instead would be wrong — an `edit` also finds a previous message id.
  //
  // Longest possible id: 'sticky:modal:edit:' (18) + a 19-digit snowflake = 37,
  // well inside Discord's 100-char customId cap.
  MODAL: 'sticky:modal',
};

// Modal modes, encoded into the customId above.
const MODES = {
  SET:  'set',
  EDIT: 'edit',
};

// Modal component customIds.
const FIELDS = {
  CONTENT: 'content',
  TITLE:   'title',
  COLOR:   'color',
};

// ---------------------------------------------------------------------------
// The gate — Godfathers + the ticket officer list, i.e. the SAME combined gate
// the carry Mark-Paid / Release / Cancel buttons use (carry/constants.js:82
// aliases TICKET_OFFICER_ROLE_IDS for exactly this reason). Re-exported from
// ticket/constants.js rather than re-listed, so an officer added there is an
// officer here too and the two lists cannot drift.
//
// GODFATHERS_ROLE_ID is already the first entry of TICKET_OFFICER_ROLE_IDS, but
// it is included explicitly so this stays correct if that list is ever edited.
// ---------------------------------------------------------------------------
const STICKY_ROLE_IDS = [...new Set([GODFATHERS_ROLE_ID, ...TICKET_OFFICER_ROLE_IDS])];

// ---------------------------------------------------------------------------
// THE LENGTH TRAP (spec §4.1). Three different caps, and they do not agree:
//
//   MODAL_CONTENT_MAX   4000   what a modal Paragraph input will accept
//   PLAIN_CONTENT_MAX   2000   what a plain message will accept
//   EMBED_DESC_MAX      4096   what an embed description will accept
//
// So content of 2,001-4,000 chars CANNOT be posted as plain text. It is
// promoted to a TITLELESS EMBED instead — never refused, never truncated.
// ---------------------------------------------------------------------------
const MODAL_CONTENT_MAX = 4000;
const PLAIN_CONTENT_MAX = 2000;
const EMBED_DESC_MAX    = 4096;   // documented for the reader; 4000 < 4096 so
                                  // the promotion above can never overflow it.

// Discord's embed title cap. Also the modal input cap for the title field.
const TITLE_MAX = 256;

// Modal input cap for the colour field. '#RRGGBB' is 7; the extra room lets a
// typo through to the parser (which falls back) instead of the input silently
// refusing keystrokes.
const COLOR_MAX = 20;

// House blurple — the colour /help, /guildexpedition and /memberclasses already
// use (reactionrole/constants.js:36 calls it that by name). Used when a title
// is given with no colour, and for the titleless over-length promotion.
const DEFAULT_COLOR = 0x5865F2;

// ---------------------------------------------------------------------------
// Sticky repost debounce, per channel.
//
// 10s is the middle of the two existing engines and deliberately so: ticket
// uses 5s for a quiet private channel, the activity campaign uses 30s. A
// general-purpose sticky can land in a busy channel, so 5s would be wasteful,
// and 30s leaves the sticky buried too long to be doing its job.
// ---------------------------------------------------------------------------
const REPOST_COOLDOWN_MS = 10_000;

// Discord API error code for a channel that no longer exists. The ONLY error
// that retires a watch — everything else (missing permissions, rate limits) is
// transient and must retry on the next message rather than drop the record.
const ERR_UNKNOWN_CHANNEL = 10003;

// /stickymessage list: how much of each sticky's content to preview inline.
// This truncates the LISTING ONLY — the posted sticky is never truncated.
const LIST_PREVIEW_CHARS = 120;
// And the hard cap on the listing reply itself (Discord message limit).
const LIST_CONTENT_MAX = 1900;

// ---------------------------------------------------------------------------
// Copy. Everything officer-facing lives here so wording is a one-file edit.
// ---------------------------------------------------------------------------

const COPY = {
  NO_PERMISSION:
    "Sorry — `/stickymessage` is for Godfathers and officers only.",

  DB_DOWN:
    '⚠️ Sticky messages are unavailable right now (database not reachable). ' +
    'Existing stickies stay where they are but stop following the conversation until it is back.',

  NOT_TEXT_CHANNEL:
    '⚠️ Sticky messages only work in normal text channels — not threads, forums, ' +
    'voice text or DMs.',

  CANNOT_POST: (channel) =>
    `⚠️ I can't post in ${channel} — I need **View Channel** and **Send Messages** there.`,

  MODAL_TITLE_SET:  'Set sticky message',
  MODAL_TITLE_EDIT: 'Edit sticky message',

  LABEL_CONTENT: 'Message content',
  LABEL_TITLE:   'Title (optional — leave blank for plain text)',
  LABEL_COLOR:   'Colour (optional hex, e.g. #5865F2)',

  PLACEHOLDER_CONTENT: 'What should stay pinned to the bottom of this channel?',
  PLACEHOLDER_TITLE:   'Fill this in to post as an embed',
  PLACEHOLDER_COLOR:   '#5865F2',

  NOTHING_HERE:
    'ℹ️ There is no sticky message in this channel. Use `/stickymessage set` to add one.',

  REMOVED: (channel) =>
    `🗑️ Sticky message removed from ${channel}. I've stopped watching that channel.`,

  LIST_EMPTY:
    'ℹ️ No sticky messages are active anywhere in this server.',

  // ---------------------------------------------------------------------------
  // Sticky-on-sticky refusal (spec §5). Two engines in one channel each race to
  // be the newest message and ping-pong forever. This is a DELIBERATE
  // LIMITATION, and the copy says so rather than pretending it's a bug.
  // ---------------------------------------------------------------------------
  CONFLICT: (channel, ownerLabel) =>
    `⚠️ I can't put a sticky message in ${channel} — **${ownerLabel}** already keeps its own ` +
    'message pinned to the bottom of that channel.\n\n' +
    'Two sticky messages in one channel would fight each other forever, each reposting to get ' +
    'back to the bottom. That would spam the channel and burn through rate limits, so this is ' +
    'refused on purpose. Pick another channel.',

  // Confirmation fragments, assembled by the handler.
  CONFIRM_CREATED: (channel) => `📌 Sticky message set in ${channel}.`,
  CONFIRM_REPLACED: (channel) =>
    `📌 Sticky message **replaced** in ${channel} — the previous one has been removed.`,
  CONFIRM_UPDATED: (channel) => `📌 Sticky message updated in ${channel}.`,

  NOTE_PLAIN:
    '• Posted as **plain text** (no title given), so your markdown renders as you typed it.',
  NOTE_EMBED:
    '• Posted as an **embed**, because you gave it a title.',
  NOTE_PROMOTED: (len) =>
    `• You typed **${len.toLocaleString('en-US')} characters** and a plain Discord message ` +
    'caps at **2,000** — so this was posted as a **titleless embed** instead. ' +
    '**Nothing was cut**: every character you typed is in the message.',
  NOTE_BAD_COLOR: (raw) =>
    `• \`${raw}\` isn't a hex colour I could read, so I used the default blurple instead.`,
  NOTE_COLOR_IGNORED:
    '• The colour was ignored — colours only apply to embeds, and this one has no title.',
  NOTE_NO_PING:
    '• Mentions in a sticky are shown but never ping. A sticky reposts every time the channel ' +
    'is used, so a live `@everyone` in it would ping the server over and over.',
  NOTE_FOLLOWS:
    '• It will follow the conversation, reposting at the bottom (at most once every 10 seconds).',
};

module.exports = {
  IDS,
  MODES,
  FIELDS,
  STICKY_ROLE_IDS,
  MODAL_CONTENT_MAX,
  PLAIN_CONTENT_MAX,
  EMBED_DESC_MAX,
  TITLE_MAX,
  COLOR_MAX,
  DEFAULT_COLOR,
  REPOST_COOLDOWN_MS,
  ERR_UNKNOWN_CHANNEL,
  LIST_PREVIEW_CHARS,
  LIST_CONTENT_MAX,
  COPY,
};
