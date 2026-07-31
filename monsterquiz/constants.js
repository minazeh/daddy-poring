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

// Category select-menu customId. Static, same rationale as the Join button —
// the game is keyed by channel, so no per-game encoding is needed. Unique in the
// `monsterquiz:*` namespace; the interactionCreate router already forwards every
// component (button + select) to engine.route(), which dispatches on customId.
const SELECT_CUSTOM_ID = 'monsterquiz:category';

// rodb collection keys → the collection they sample from + the noun shown to
// players. Used ONLY by the jumble category. The engine maps collectionKey to
// db.COLLECTIONS at call time. (Kept as `CATEGORIES` for backward-compat with
// logic.js's pickQuestions, which iterates these keys.)
const CATEGORIES = {
  monster: { collectionKey: 'monsters', noun: 'monster' },
  item: { collectionKey: 'equipment', noun: 'item' },
  card: { collectionKey: 'cards', noun: 'card' },
};

// ---------------------------------------------------------------------------
// Playable-category registry — the four categories the select menu offers.
// Each entry: { key, label, emoji, mode, dataFile?, description }
//   • mode drives the prompt format + answer matcher (see logic.js):
//       'jumble'    → rodb monsters+equipment+cards, scrambled-name unscramble
//       'truefalse' → statement, answer True/False
//       'trivia'    → question, free-text answer matched against answers[]
//   • dataFile is the bundled bank under ./data (loaded by banks.js); jumble has
//     none (it samples rodb live).
// Insertion order = menu order.
// ---------------------------------------------------------------------------
const CATEGORY_REGISTRY = {
  jumble: {
    key: 'jumble',
    label: 'Monsters, Items & Cards',
    emoji: '🧩',
    mode: 'jumble',
    description: 'Unscramble names from the game database',
  },
  hoppy: {
    key: 'hoppy',
    label: 'Hoppy Quiz',
    emoji: '🐰',
    mode: 'truefalse',
    dataFile: 'lucky_rabbit_questions_en_us.json',
    description: 'Answer True or False',
  },
  banquet: {
    key: 'banquet',
    label: 'Guild Banquet',
    emoji: '🎉',
    mode: 'trivia',
    dataFile: 'guild_banquet_questions_en_us.json',
    description: 'Guild trivia — type the answer',
  },
  scholar: {
    key: 'scholar',
    label: 'Scholar Exam (Sage Quiz)',
    emoji: '📚',
    mode: 'trivia',
    dataFile: 'scholar_exam_questions_en_us.json',
    description: 'Sage exam trivia — type the answer',
  },
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
  SELECT_CUSTOM_ID,
  CATEGORIES,
  CATEGORY_REGISTRY,
};
