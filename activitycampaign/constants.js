// ---------------------------------------------------------------------------
// Shared constants for the activity-campaign (launch-day pulse check) feature.
//
// /activitycampaign posts a plain-text (NON-embed) prompt with two buttons and
// keeps it "always in front" via a debounced sticky repost (the bot deletes
// its previous prompt and reposts at the bottom whenever chat pushes it up).
// Members answer once per ISO week and may change that answer within the week.
// ---------------------------------------------------------------------------

// Role allowed to run /activitycampaign (start/stop/status) — the Godfathers.
// The BUTTONS on the prompt itself are usable by everyone; only the command
// is gated.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// customIds.
//   YES / NO           — answer buttons. Static (no per-message payload) so
//                        handlers survive any restart — the weekly record key
//                        is derived from the clicker + current week, never
//                        from in-memory state.
//   START_MODAL_PREFIX — the "type the prompt" modal shown by
//                        /activitycampaign start; the target channel id is
//                        appended: activitycampaign:startmodal:<channelId>.
const IDS = {
  YES: 'activitycampaign:yes',
  NO:  'activitycampaign:no',
  START_MODAL_PREFIX: 'activitycampaign:startmodal', // + ':<channelId>'
};

// Modal text-input customId.
const FIELDS = {
  MESSAGE: 'message',
};

// Discord's message content cap is 2000 chars — bound the modal input to match.
const MESSAGE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Editable copy — Conrad: reword freely, the code never parses these strings.
// PROMPT_TEXT is the sticky message body (plain content, NOT an embed).
// ---------------------------------------------------------------------------
const PROMPT_TEXT =
  "🎉 **Launch day is July 16 — are you joining us?** Tap below. You can change your answer anytime this week.";

const BUTTON_YES_LABEL = "✅ Yes, I'm in";
const BUTTON_NO_LABEL  = "❌ No, I don't think so";

// Ephemeral acks sent to the clicker (the public prompt is never edited).
const ACK_YES = "✅ You're in! You can change your answer this week.";
const ACK_NO  = "👍 Noted — thanks! You can change this week.";
const ACK_DB_DOWN = "⚠️ Couldn't record your answer right now — please try again in a moment.";

// ---------------------------------------------------------------------------
// Sticky repost tuning.
// ---------------------------------------------------------------------------
// Minimum gap between reposts. Chat bursts inside the window collapse into a
// single trailing repost when the window closes.
const REPOST_COOLDOWN_MS = 30_000;

// /activitycampaign status: max display names listed per answer column before
// collapsing into "+N more".
const STATUS_LIST_CAP = 25;

module.exports = {
  GODFATHERS_ROLE_ID,
  IDS,
  FIELDS,
  MESSAGE_MAX_LENGTH,
  PROMPT_TEXT,
  BUTTON_YES_LABEL,
  BUTTON_NO_LABEL,
  ACK_YES,
  ACK_NO,
  ACK_DB_DOWN,
  REPOST_COOLDOWN_MS,
  STATUS_LIST_CAP,
};
