const { Events } = require('discord.js');
const { registerCommands } = require('../lib/registerCommands');
const kudosDb = require('../kudos/db');
const quizDb = require('../quiz/db');
const quiz = require('../quiz/handlers');
const membersync = require('../membersync');
const rosterDb = require('../roster/db');
const officerDb = require('../officerapp/db');

module.exports = {
  name: Events.ClientReady,
  // once: true fires the handler only on the first emit (correct for the ready event).
  once: true,
  async execute(client) {
    console.log(`[ready] Logged in as ${client.user.tag}`);

    // Auto-register slash commands on every startup.
    // A failure here is non-fatal — bot stays online with previously registered commands.
    try {
      await registerCommands(client.commands);
    } catch (err) {
      console.error('[ready] Slash command auto-registration failed (bot still online):', err);
    }

    // Kudos: connect to MongoDB + ensure indexes (idempotent). If MONGODB_URI is
    // missing or Atlas is unreachable, the bot keeps running — kudos surfaces show
    // a "not configured" message instead. initSchema() handles its own errors and
    // returns true only on a successful connect; it never throws to the boot path.
    try {
      const ok = await kudosDb.initSchema();
      if (ok) {
        console.log('[ready] Kudos store ready (MongoDB).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Kudos disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Kudos disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Kudos init failed (kudos degraded, bot still online):', err?.message || err);
    }

    // Class Quiz: connect to MongoDB (same Atlas cluster as Kudos) + ensure
    // indexes, then recover any persisted open questions and start the per-channel
    // loops. Like kudos, this degrades gracefully — no MONGODB_URI or Atlas
    // unreachable means the quiz is disabled and the bot still boots fully.
    // initSchema()/startQuiz() handle their own errors; nothing throws to boot.
    try {
      const ok = await quizDb.initSchema();
      if (ok) {
        console.log('[ready] Quiz store ready (MongoDB) — starting loops.');
        // Fire-and-forget: per-channel loops run forever; don't block ready.
        quiz.startQuiz(client).catch(err =>
          console.warn('[ready] Quiz startQuiz failed (quiz degraded, bot still online):', err?.message || err));
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Quiz disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Quiz disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Quiz init failed (quiz degraded, bot still online):', err?.message || err);
    }

    // Member Sync: connect to MongoDB + ensure indexes, run an initial sync,
    // then start the hourly timer. initAndStart() handles its own errors and
    // never throws to the boot path — no MONGODB_URI or Atlas unreachable
    // leaves the bot fully operational (other features unaffected).
    try {
      await membersync.initAndStart(client);
    } catch (err) {
      console.warn('[ready] Member sync init failed (member sync degraded, bot still online):', err?.message || err);
    }

    // Guild Roster: connect (read-only) to MongoDB for /guildroster image
    // rendering. Same Atlas cluster; own client. Degrades gracefully — no
    // MONGODB_URI or Atlas unreachable leaves /guildroster showing a "not
    // available" message and the bot fully online. initSchema() never throws.
    try {
      const ok = await rosterDb.initSchema();
      if (ok) {
        console.log('[ready] Guild roster store ready (MongoDB, read-only).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Guild roster disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Guild roster disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Guild roster init failed (roster degraded, bot still online):', err?.message || err);
    }

    // Job Ads: connect to MongoDB for /jobad applicant-list persistence. Same
    // Atlas cluster; own client. Degrades gracefully — no MONGODB_URI or Atlas
    // unreachable means the job-ad flow still posts + processes applications
    // (customId-based) and just skips the persistent applicant-list update.
    // initSchema() never throws to the boot path.
    try {
      const ok = await officerDb.initSchema();
      if (ok) {
        console.log('[ready] Job-ad store ready (MongoDB).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Job-ad persistence disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Job-ad persistence disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Job-ad init failed (persistence degraded, bot still online):', err?.message || err);
    }
  },
};
