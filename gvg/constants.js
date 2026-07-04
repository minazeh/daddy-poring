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
