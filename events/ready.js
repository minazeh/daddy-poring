const { Events } = require('discord.js');
const { registerCommands } = require('../lib/registerCommands');
const kudosDb = require('../kudos/db');
const quizDb = require('../quiz/db');
const quiz = require('../quiz/handlers');
const membersync = require('../membersync');
const rosterDb = require('../roster/db');
const officerDb = require('../officerapp/db');
const rodbDb = require('../rodb/db');
const activityDb = require('../activitycampaign/db');
const activitySticky = require('../activitycampaign/sticky');
const gvgDb = require('../gvg/db');
const gvgScheduler = require('../gvg/scheduler');
const gvgCapture = require('../gvg/capture');
const reactionRoleDb = require('../reactionrole/db');

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

    // Game Database (RoworldDB snapshot): connect (read-only) to MongoDB for
    // the /monster /item /card /map lookups. Same Atlas cluster; own client.
    // Degrades gracefully — no MONGODB_URI, Atlas unreachable, or import not
    // yet run leaves those commands replying "not available" and the bot
    // fully online. initSchema() never throws. Data is loaded one-time by
    // scripts/import-roworlddb.js (never by the bot — bot path never writes).
    try {
      const ok = await rodbDb.initSchema();
      if (ok) {
        console.log('[ready] Game database ready (MongoDB, read-only).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Game database disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Game database disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Game database init failed (rodb degraded, bot still online):', err?.message || err);
    }

    // Activity Campaign: connect to MongoDB for the /activitycampaign launch
    // pulse-check (sticky Yes/No prompt + weekly answers). Same Atlas cluster;
    // own client. After a successful connect, resume() checks whether a
    // campaign was active before the restart and immediately reposts the
    // sticky prompt so it's visible again. Degrades gracefully — no
    // MONGODB_URI or Atlas unreachable means /activitycampaign replies
    // "unavailable", button clicks get an ephemeral retry message, and the
    // sticky repost is skipped. initSchema()/resume() never throw to boot.
    try {
      const ok = await activityDb.initSchema();
      if (ok) {
        console.log('[ready] Activity-campaign store ready (MongoDB).');
        await activitySticky.resume(client);
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Activity campaign disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Activity campaign disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Activity-campaign init failed (campaign degraded, bot still online):', err?.message || err);
    }

    // GvG Attendance: connect to MongoDB for /gvgschedule + /gvgvc + the
    // attendance window capture. Same Atlas cluster; own client. After a
    // successful connect: (1) resume() reloads any capture window that was
    // in progress before the restart — re-snapshots the VCs, re-arms the end
    // timer for the remaining time (or finalizes at once if the window ended
    // while the bot was down); (2) armAll() arms one weekly timer per
    // schedule, with the capture module as the fire handler. Degrades
    // gracefully — no MONGODB_URI or Atlas unreachable means the commands
    // reply "unavailable", no timers are armed, and voiceStateUpdate no-ops.
    // initSchema()/resume()/armAll() never throw to the boot path.
    try {
      const ok = await gvgDb.initSchema();
      if (ok) {
        console.log('[ready] GvG attendance store ready (MongoDB).');
        await gvgCapture.resume(client);
        await gvgScheduler.armAll(client, gvgCapture.startCapture);
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] GvG attendance disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] GvG attendance disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] GvG attendance init failed (GvG degraded, bot still online):', err?.message || err);
    }

    // Reaction Roles: connect to MongoDB for the /guildexpedition sign-up
    // embed (reaction ✅ ↔ Guild Expedition role). Same Atlas cluster; own
    // client. No resume step needed — the messageReactionAdd/Remove handlers
    // look every reaction up in reactionrole_messages directly (zero
    // in-memory state), so already-posted embeds work as soon as the store
    // is ready. Degrades gracefully — no MONGODB_URI or Atlas unreachable
    // means /guildexpedition replies "unavailable" and reactions on old
    // embeds are inert until the DB is back. initSchema() never throws.
    try {
      const ok = await reactionRoleDb.initSchema();
      if (ok) {
        console.log('[ready] Reaction-role store ready (MongoDB).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Reaction roles disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Reaction roles disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Reaction-role init failed (reaction roles degraded, bot still online):', err?.message || err);
    }
  },
};
