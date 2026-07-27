// ---------------------------------------------------------------------------
// Monster Quiz — anagram game over the RoworldDB snapshot (rodb_* collections).
// Shared constants.
//
// NOTE ON MODULE LOCATION: the original spec named this module `quiz/`, but the
// `quiz/` directory is already the (unrelated) Class Quiz feature — its
// constants.js/handlers.js/db.js/questions.js would collide. To avoid breaking
// that feature, Monster Quiz lives under `monsterquiz/` instead. The internal
// split (constants / logic / engine) is exactly as specced. Flagged for Nanna.
//
// customId namespace: `monsterquiz:*` — unique across the bot (no collision with
// quiz:* / partyfinder:* / gvgrsvp:* / activitycampaign:* / guildapp:* / etc.),
// so the interactionCreate router can claim it safely.
// ---------------------------------------------------------------------------

// Signup window: 60 s. Each round: up to 60 s. Both overridable per-game so the
// simulation can drive rounds in milliseconds instead of real minutes.
const SIGNUP_MS = 60_000;
const ROUND_MS = 60_000;

// `questions` slash option: default 5, clamped to [1, 20].
const DEFAULT_QUESTIONS = 5;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 20;

// End the game early after this many CONSECUTIVE fully-ignored rounds (zero
// messages from joined participants).
const MAX_CONSECUTIVE_IGNORED = 2;

// Fair-jumble name bounds (letters only, spaces allowed between words).
const MIN_NAME_LETTERS = 3;
const MAX_NAME_LETTERS = 18;

// Button customId. Static (one game per channel; the channel is read from the
// interaction), so it's restart-safe and needs no per-game encoding.
const JOIN_CUSTOM_ID = 'monsterquiz:join';

// Category keys → the rodb collection they sample from + the noun shown to
// players. The engine maps these to db.COLLECTIONS at call time.
const CATEGORIES = {
  monster: { collectionKey: 'monsters', noun: 'monster' },
  item: { collectionKey: 'equipment', noun: 'item' },
  card: { collectionKey: 'cards', noun: 'card' },
};

module.exports = {
  SIGNUP_MS,
  ROUND_MS,
  DEFAULT_QUESTIONS,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  MAX_CONSECUTIVE_IGNORED,
  MIN_NAME_LETTERS,
  MAX_NAME_LETTERS,
  JOIN_CUSTOM_ID,
  CATEGORIES,
};
