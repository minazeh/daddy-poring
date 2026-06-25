// ---------------------------------------------------------------------------
// Maintenance script: clear the Quiz Bot leaderboard (wipe all quiz_scores).
//
// USAGE
//   Dry run (count only — no changes):
//     node scripts/clear-quiz-leaderboard.js
//
//   Live wipe:
//     node scripts/clear-quiz-leaderboard.js --yes
//
//   Also clear the leaderboard-message pointer (bot posts a fresh #leaderboard
//   message next time it closes a question):
//     node scripts/clear-quiz-leaderboard.js --yes --reset-message
//
//   On Railway (env injected by the platform — no .env file needed):
//     railway run node scripts/clear-quiz-leaderboard.js --yes
//     railway run node scripts/clear-quiz-leaderboard.js --yes --reset-message
//
// WHAT IT DOES
//   Default:           deleteMany({}) on `discordbot.quiz_scores`
//   --reset-message:   additionally deleteMany({}) on `discordbot.quiz_leaderboard_msg`
//
// WHAT IT DOES NOT DO
//   - Touches nothing in `quiz_active` (open questions are unaffected).
//   - Does NOT edit or delete the live Discord #leaderboard message. The bot
//     will update it to "No scores yet" automatically on the next question
//     close. If --reset-message is passed, the pointer doc is deleted so the
//     bot posts a brand-new message instead of editing the old one.
//
// ENV LOADING
//   Mirrors index.js: `require('dotenv').config()` loads `.env` locally.
//   On Railway the platform injects MONGODB_URI directly into process.env
//   (no .env file present), so dotenv's no-op-if-missing behaviour is safe.
// ---------------------------------------------------------------------------

'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');

const DB_NAME      = 'discordbot';
const C_SCORES     = 'quiz_scores';
const C_LBMSG      = 'quiz_leaderboard_msg';

const CONFIRM_FLAG = '--yes';
const RESET_MSG_FLAG = '--reset-message';

const args = process.argv.slice(2);
const confirmed   = args.includes(CONFIRM_FLAG);
const resetMsg    = args.includes(RESET_MSG_FLAG);

const uri = process.env.MONGODB_URI;

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

if (!uri) {
  console.error('[clear-quiz-leaderboard] ERROR: MONGODB_URI is not set.');
  console.error('  Locally: ensure .env exists with MONGODB_URI=<your Atlas SRV>.');
  console.error('  Railway: ensure MONGODB_URI is set in the service Variables.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    const scoresCol = db.collection(C_SCORES);
    const lbmsgCol  = db.collection(C_LBMSG);

    // Count before touching anything.
    const scoreCount  = await scoresCol.countDocuments({});
    const lbmsgCount  = await lbmsgCol.countDocuments({});

    console.log('');
    console.log('========================================');
    console.log('  Quiz Leaderboard Clear — Summary');
    console.log('========================================');
    console.log(`  Target DB         : ${DB_NAME} (Atlas)`);
    console.log(`  quiz_scores       : ${scoreCount} document(s) will be deleted`);
    if (resetMsg) {
      console.log(`  quiz_leaderboard_msg: ${lbmsgCount} document(s) will be deleted`);
    } else {
      console.log(`  quiz_leaderboard_msg: SKIPPED (pass --reset-message to also clear)`);
    }
    console.log('');

    if (!confirmed) {
      // Dry run — no writes.
      console.log(`  DRY RUN — would delete ${scoreCount} score(s).`);
      if (resetMsg) {
        console.log(`           would delete ${lbmsgCount} leaderboard-message pointer(s).`);
      }
      console.log('');
      console.log('  Re-run with --yes to execute:');
      console.log(`    node scripts/clear-quiz-leaderboard.js --yes${resetMsg ? ' --reset-message' : ''}`);
      console.log('');
      return;
    }

    // Live run.
    console.log(`  MODE: LIVE — deleting now ...`);
    console.log('');

    const scoreResult = await scoresCol.deleteMany({});
    console.log(`  quiz_scores: Cleared ${scoreResult.deletedCount} score(s).`);

    if (resetMsg) {
      const lbResult = await lbmsgCol.deleteMany({});
      console.log(`  quiz_leaderboard_msg: Cleared ${lbResult.deletedCount} pointer(s).`);
      console.log('');
      console.log('  The bot will post a fresh #leaderboard message on the next question close.');
    } else {
      console.log('');
      console.log('  The live #leaderboard message will update to "No scores yet" on the next');
      console.log('  question close. Use /qna to confirm immediately — it reads the same data.');
    }

    console.log('');
    console.log('  Done.');
    console.log('');

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('[clear-quiz-leaderboard] Fatal error:', err?.message || err);
  process.exit(1);
});
