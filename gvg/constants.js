// ---------------------------------------------------------------------------
// Shared constants for the GvG attendance checker.
//
// /gvgschedule registers weekly-recurring GvG times (day + HH:MM in GMT+7);
// /gvgvc registers the voice channels to monitor. When a schedule fires, the
// bot watches the selected VCs for the schedule's duration (snapshot at start
// + everyone who joins during the window) and posts an attendance log to the
// log channel, cross-checked against the guild roster for wrong-VC flags.
// ---------------------------------------------------------------------------

// Role allowed to run /gvgschedule and /gvgvc — the Godfathers. Same role that
// gates /activitycampaign.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// Text channel that receives the attendance log at the end of every window.
const LOG_CHANNEL_ID = '1522579149758136403';

// -------------------------------------------------------------------------
// Guild Event Reminder (Phase 1) — a silent, self-bumping reminder sticky
// that appears 2 h before each scheduled event in REMINDER_CHANNEL_ID
// (Channel A) with Let's-go / Can't-make-it buttons, and is taken down at
// event start. User-facing copy always says "Guild Event", never "GvG".
// See docs/GUILD_EVENT_REMINDER_SPEC.md.
// -------------------------------------------------------------------------

// Channel A — the reminder sticky + RSVP buttons live here.
const REMINDER_CHANNEL_ID = '1518082956466585731';

// Channel B — the live tally (Phase 2). Declared now so the take-down /
// delete-mid-window "annotate tally" hooks have the id available; Phase 1
// never posts here.
const TALLY_CHANNEL_ID = '1528279089629106196';

// Lead time: the reminder sticky goes up this long before event start.
const REMINDER_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours

// Debounce gap between sticky reposts (mirrors the activity-campaign sticky).
const REMINDER_REPOST_COOLDOWN_MS = 30_000;

// Phase 2 — batched RSVP sync + live-tally refresh cadence. A single
// module-level setInterval flushes every DIRTY occurrence (in-memory RSVPs →
// gvg_attendance_intent) and refreshes its Channel-B tally on this beat. A
// burst of 400 taps inside one interval collapses into ONE bulkWrite. .unref()d
// so it never keeps the process alive.
const REMINDER_SYNC_INTERVAL_MS = 10_000; // 10 s

// RSVP button customId namespace. Full id: `gvgrsvp:<yes|no>:<occurrenceKey>`
// where occurrenceKey = `<scheduleId(24)>:<YYYYMMDD>` → total ~45 chars, well
// under Discord's 100-char customId cap.
const RSVP_ID_PREFIX = 'gvgrsvp';

// RSVP button copy (user-facing — reword freely, code never parses these).
const RSVP_YES_LABEL = "⚔️ Let's go!";
const RSVP_NO_LABEL = "😔 Can't make it";

// Ephemeral acks sent to the presser (the public sticky is never edited).
const RSVP_ACK_YES = "You're in! ⚔️";
const RSVP_ACK_NO = "Marked as can't-make-it — change it anytime.";
const RSVP_ACK_ERR = "⚠️ Couldn't register that right now — please try again in a moment.";

// -------------------------------------------------------------------------
// GvG timezone. Schedule times are entered and displayed in this offset.
// Edit this one line (and the label) to change the GvG timezone.
// -------------------------------------------------------------------------
const GVG_TZ_OFFSET_HOURS = 7;   // GMT+7
const GVG_TZ_LABEL = 'GMT+7';    // shown on lists + the attendance log header

// Default capture window when /gvgschedule add omits `duration`.
const DEFAULT_DURATION_MIN = 60;

// Bounds for the `duration` option (minutes).
const MIN_DURATION_MIN = 5;
const MAX_DURATION_MIN = 720; // 12 h — hard sanity cap

// Days of the week, in the order shown to Conrad. DAY_INDEX maps a day name to
// JS Date's getUTCDay() convention (0 = Sunday … 6 = Saturday) for the
// next-occurrence math in gvg/scheduler.js.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_INDEX = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// Guild targets. Schedules may target daddy, mummy, or both; monitored VCs are
// tagged daddy or mummy. Matches roster/db.js semantics: Daddy ⇔ members with
// isMain === true, Mummy ⇔ isSub === true.
const GUILDS = { DADDY: 'daddy', MUMMY: 'mummy', BOTH: 'both' };
const GUILD_LABELS = { daddy: 'Daddy', mummy: 'Mummy', both: 'Both guilds' };

// Strict 24 h HH:MM (00:00–23:59).
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// -------------------------------------------------------------------------
// Attendance-log pagination limits (Discord hard limits — the log builder
// paginates ALL names across multiple embeds + follow-up messages so every
// attendee is visible inline, even for 300+ member guilds; the full list is
// ALSO attached as gvg-attendance.txt on the first message as the complete
// backup record).
//   MAX_FIELD_VALUE_CHARS   — Discord embed field value cap.
//   MAX_NAME_LINE_CHARS     — per-name line cap (a display name plus flag).
//   MAX_FIELDS_PER_EMBED    — Discord cap of 25 fields/embed.
//   MAX_EMBED_TOTAL_CHARS   — Discord cap of 6000 chars/embed (title +
//                             description + all field names + values).
//   MAX_EMBEDS_PER_MESSAGE  — Discord cap of 10 embeds/message; overflow goes
//                             into follow-up messages.
//   MAX_CONTENT_CHARS       — Discord message content cap (we keep it empty).
// -------------------------------------------------------------------------
const MAX_FIELD_VALUE_CHARS = 1024;
const MAX_NAME_LINE_CHARS = 256;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBED_TOTAL_CHARS = 6000;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_CONTENT_CHARS = 2000;
// Safety margin below the hard 6000/embed cap so field-boundary rounding can
// never tip an embed over the limit.
const EMBED_CHAR_SAFETY = 5600;

module.exports = {
  GODFATHERS_ROLE_ID,
  LOG_CHANNEL_ID,
  REMINDER_CHANNEL_ID,
  TALLY_CHANNEL_ID,
  REMINDER_LEAD_MS,
  REMINDER_REPOST_COOLDOWN_MS,
  REMINDER_SYNC_INTERVAL_MS,
  RSVP_ID_PREFIX,
  RSVP_YES_LABEL,
  RSVP_NO_LABEL,
  RSVP_ACK_YES,
  RSVP_ACK_NO,
  RSVP_ACK_ERR,
  GVG_TZ_OFFSET_HOURS,
  GVG_TZ_LABEL,
  DEFAULT_DURATION_MIN,
  MIN_DURATION_MIN,
  MAX_DURATION_MIN,
  DAYS,
  DAY_INDEX,
  GUILDS,
  GUILD_LABELS,
  TIME_RE,
  MAX_FIELD_VALUE_CHARS,
  MAX_NAME_LINE_CHARS,
  MAX_FIELDS_PER_EMBED,
  MAX_EMBED_TOTAL_CHARS,
  MAX_EMBEDS_PER_MESSAGE,
  MAX_CONTENT_CHARS,
  EMBED_CHAR_SAFETY,
};
