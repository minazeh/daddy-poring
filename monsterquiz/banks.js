// ---------------------------------------------------------------------------
// Monster Quiz — static question-bank loader for the non-jumble categories.
//
// The three quiz banks (Hoppy / Guild Banquet / Scholar Exam) are bundled into
// the repo under ./data as verbatim JSON (see data/README.md for provenance and
// refresh URLs). They are small, static, and roworlddb-sourced — NOT imported
// into Mongo. This module reads them from disk ONCE at module init and caches
// the raw `questions[]` array per category key.
//
// Deliberately NO dependency on rodb/Mongo: these categories must work with the
// game database offline. A missing/corrupt file degrades to an empty bank (the
// engine then fails that category gracefully) — it never throws to the boot path.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { CATEGORY_REGISTRY } = require('./constants');

const DATA_DIR = path.join(__dirname, 'data');

// categoryKey → raw questions[] (as authored in the source JSON).
const banks = new Map();

function loadBankFile(file) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.questions) ? parsed.questions : [];
}

for (const cat of Object.values(CATEGORY_REGISTRY)) {
  if (!cat.dataFile) continue; // jumble has no bundled bank (samples rodb live)
  try {
    const questions = loadBankFile(cat.dataFile);
    banks.set(cat.key, questions);
    console.log(`[monsterquiz/banks] Loaded ${questions.length} questions for "${cat.key}" (${cat.dataFile}).`);
  } catch (err) {
    console.warn(`[monsterquiz/banks] Failed to load ${cat.dataFile} for "${cat.key}":`, err?.message || err);
    banks.set(cat.key, []);
  }
}

// Raw questions[] for a category key, or [] if none/unloaded.
function get(key) {
  return banks.get(key) || [];
}

module.exports = {
  get,
  _banks: banks, // exposed for the simulation
};
