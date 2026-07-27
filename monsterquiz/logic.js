// ---------------------------------------------------------------------------
// Monster Quiz — PURE game logic. No Discord, no I/O, no timers. Everything
// here is deterministic given its inputs (shuffling takes an injectable rng so
// the simulation can make it repeatable). This is the layer the sim asserts on.
// ---------------------------------------------------------------------------

const {
  MIN_NAME_LETTERS,
  MAX_NAME_LETTERS,
  CATEGORIES,
} = require('./constants');

// Word separator used in the jumbled display so the number of words stays clear
// while letters within a word are space-separated for readability.
const WORD_SEP = '  /  ';

// ---------------------------------------------------------------------------
// normalize — lowercase, trim, collapse internal whitespace. Used for both the
// stored answer and each incoming guess so comparison is case/space-insensitive.
// ---------------------------------------------------------------------------
function normalize(str) {
  return String(str == null ? '' : str).toLowerCase().replace(/\s+/g, ' ').trim();
}

// isCorrect — a guess matches the answer under normalization. Used for the
// monster + item categories (strict). Card matching is lenient (see below).
function isCorrect(guess, answer) {
  const g = normalize(guess);
  return g.length > 0 && g === normalize(answer);
}

// Every card name ends in " Card". stripCardSuffix removes a single trailing
// "card"/"cards" word (case-insensitive) — the base name we actually jumble.
//   "Kukre Card" → "Kukre"   "Advanced Poring Card" → "Advanced Poring"
function stripCardSuffix(name) {
  return String(name == null ? '' : name).replace(/\s+cards?$/i, '').trim();
}

// isCorrectCard — LENIENT match for cards: a guess is correct with OR without a
// trailing "card"/"cards" word, so "Kukre", "Kukre Card", "kukre cards" all pass
// for the card "Kukre Card". A bare "card" (empty base) never wins.
function isCorrectCard(guess, answer) {
  const g = normalize(stripCardSuffix(guess));
  const a = normalize(stripCardSuffix(answer));
  return g.length > 0 && g === a;
}

// Route to the right matcher for a question's category.
function isCorrectForCategory(guess, answer, category) {
  return category === 'card' ? isCorrectCard(guess, answer) : isCorrect(guess, answer);
}

// Count answer letters (excluding spaces) and words — for the length hint and
// fairness bounds.
function letterCount(name) {
  return String(name || '').replace(/\s+/g, '').length;
}
function wordCount(name) {
  const t = normalize(name);
  return t ? t.split(' ').length : 0;
}

// Roman-numeral tier words I..XX. A name containing any of these as a STANDALONE
// word (case-insensitive) is a tiered variant ("Coffin III", "Grand Cross V")
// and is dropped from the pool — the numeral is trivial and repeats letters.
const ROMAN_TIER = new Set([
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
]);
function hasRomanTierWord(name) {
  return String(name == null ? '' : name)
    .split(/\s+/)
    .some((tok) => ROMAN_TIER.has(tok.toUpperCase()));
}

// ---------------------------------------------------------------------------
// isFairName — only names that make a fair anagram are eligible:
//   • letters and single spaces only (rejects digits, punctuation, parens,
//     hyphens, apostrophes, leading/trailing/double spaces)
//   • no standalone Roman-numeral tier word (I..XX) — drops tiered variants
//   • total letters within [MIN_NAME_LETTERS, MAX_NAME_LETTERS]
// (For cards, call this on the base name AFTER stripCardSuffix — the pool builder
// does exactly that, so a card whose base is <3 letters is dropped here too.)
// ---------------------------------------------------------------------------
function isFairName(name) {
  if (typeof name !== 'string') return false;
  if (!/^[A-Za-z]+( [A-Za-z]+)*$/.test(name)) return false;
  if (hasRomanTierWord(name)) return false;
  const n = letterCount(name);
  return n >= MIN_NAME_LETTERS && n <= MAX_NAME_LETTERS;
}

// ---------------------------------------------------------------------------
// Fisher–Yates shuffle of an array, using an injectable rng (defaults Math.random).
// Returns a NEW array; does not mutate the input.
// ---------------------------------------------------------------------------
function shuffleArray(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Can a word's letters be rearranged into a DIFFERENT ordering? Only if it has
// at least two distinct letters. (e.g. "AAA" cannot; "ABA" can.)
function canWordDiffer(word) {
  return new Set(word.split('')).size >= 2;
}

// Shuffle one word's letters so the result differs from the original when
// possible. Returns { chars: [...], changed: bool }.
function shuffleWord(word, rng = Math.random) {
  const chars = word.split('');
  if (chars.length < 2 || !canWordDiffer(word)) {
    return { chars, changed: false };
  }
  let out = chars;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = shuffleArray(chars, rng);
    if (candidate.join('') !== chars.join('')) {
      out = candidate;
      break;
    }
  }
  return { chars: out, changed: out.join('') !== chars.join('') };
}

// ---------------------------------------------------------------------------
// jumble — turn an answer name into a display string of shuffled letters:
//   • letters uppercased, space-separated within each word for readability
//   • words separated by WORD_SEP so the number of words stays clear
//   • a REAL shuffle: differs from the original whenever the letters allow it
//     (guards the tiny/all-identical-letter word case where it cannot)
// Returns the display string.
// ---------------------------------------------------------------------------
function jumble(name, rng = Math.random) {
  const words = normalize(name).toUpperCase().split(' ').filter(Boolean);
  if (words.length === 0) return '';

  const original = words.join(' ');
  const build = () => words
    .map((w) => shuffleWord(w, rng).chars.join(' '))
    .join(WORD_SEP);

  // Try a few whole-name attempts so at least one word actually moves (unless
  // the letters make any change impossible — e.g. a single repeated-letter word).
  const canDiffer = words.some((w) => canWordDiffer(w) && w.length >= 2);
  let display = build();
  for (let attempt = 0; canDiffer && attempt < 20; attempt++) {
    // Compare on flattened letters (drop the display spacing) so a shuffle that
    // only reinstated the original ordering is retried.
    const flatWords = display.split(WORD_SEP).map((seg) => seg.replace(/ /g, ''));
    if (flatWords.join(' ') !== original) break;
    display = build();
  }
  return display;
}

// Recover the plain uppercase letters (spaces between words) from a jumble
// display — used by tests to assert the anagram property.
function jumbleLetters(display) {
  return String(display || '')
    .split(WORD_SEP)
    .map((seg) => seg.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean)
    .join(' ');
}

// Multiset-of-letters signature (sorted, uppercase, spaces dropped) — two
// strings are anagrams iff their signatures match.
function letterSignature(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
}

// ---------------------------------------------------------------------------
// buildHint — a one-line clue from the record's OWN fields, per category:
//   monster → "Normal Plant/Water monster, Lv 5"   (type, race/element, level)
//   item    → "Q6 Head equipment"                    (quality, typeName)
//   card    → "Q4 Mouth card"                         (quality, slot)
// Missing fields degrade gracefully (dropped from the clue).
// ---------------------------------------------------------------------------
function buildHint(record, category) {
  const r = record || {};
  if (category === 'monster') {
    const re = [r.race, r.element].filter(Boolean).join('/');
    const head = [r.type, re].filter(Boolean).join(' ');
    const body = `${head ? `${head} ` : ''}monster`.trim();
    return r.level != null ? `${body}, Lv ${r.level}` : body;
  }
  if (category === 'item') {
    const q = r.quality != null ? `Q${r.quality}` : null;
    return [q, r.typeName, 'equipment'].filter(Boolean).join(' ');
  }
  if (category === 'card') {
    const q = r.quality != null ? `Q${r.quality}` : null;
    return [q, r.slot, 'card'].filter(Boolean).join(' ');
  }
  return 'Unscramble the name.';
}

// "6 letters, 1 word" / "10 letters, 3 words"
function lengthHint(name) {
  const l = letterCount(name);
  const w = wordCount(name);
  return `${l} letter${l === 1 ? '' : 's'}, ${w} word${w === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// pickQuestions — from a { monster:[docs], item:[docs], card:[docs] } bundle,
// keep only fair records, dedupe by normalized JUMBLE SOURCE across ALL
// categories (so the same scramble never repeats — e.g. monster "Poring" and
// card "Poring Card" collapse to one), then randomly select up to `n`.
//
// The jumble source is the base name we actually scramble:
//   • cards → the name with its trailing " Card" removed (fairness is checked on
//     this base, so a card whose base is <3 letters is dropped)
//   • monster/item → the name as-is
// `answer` keeps the FULL original name (informative reveal; card matching is
// lenient about the trailing "card" word — see isCorrectCard).
//
// Returns [{ category, record, answer, jumbleSource }]. Fewer than `n` if the
// pool is thin — the caller notes any shortfall in the start message.
// ---------------------------------------------------------------------------
function pickQuestions(docsByCategory, n, rng = Math.random) {
  const want = Math.max(0, Math.floor(Number(n) || 0));
  const seen = new Set();
  const pool = [];
  for (const category of Object.keys(CATEGORIES)) {
    const docs = Array.isArray(docsByCategory?.[category]) ? docsByCategory[category] : [];
    for (const record of docs) {
      const name = record?.name;
      if (typeof name !== 'string') continue;
      const jumbleSource = category === 'card' ? stripCardSuffix(name) : name;
      if (!isFairName(jumbleSource)) continue;
      const key = normalize(jumbleSource);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ category, record, answer: name, jumbleSource });
    }
  }
  return shuffleArray(pool, rng).slice(0, want);
}

module.exports = {
  WORD_SEP,
  normalize,
  isCorrect,
  isCorrectCard,
  isCorrectForCategory,
  stripCardSuffix,
  hasRomanTierWord,
  isFairName,
  letterCount,
  wordCount,
  shuffleArray,
  shuffleWord,
  jumble,
  jumbleLetters,
  letterSignature,
  buildHint,
  lengthHint,
  pickQuestions,
};
