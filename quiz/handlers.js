// ---------------------------------------------------------------------------
// Class Quiz Bot — handlers: embeds, answer-button routing, per-channel loop,
// reveal, leaderboard updater, and the recover-on-boot entrypoint.
//
// Ported from inbox/discord-bot/function-2/bot.py. Key differences from source:
//   * MongoDB (quiz/db.js) instead of SQLite.
//   * Channels matched by hard-coded ID (constants), not by name.
//   * RECOVER-ON-BOOT (Conrad's decision, NOT the source's "soft reset"): on
//     startup we re-scan persisted open questions and resume each — reveal now
//     if its 1-hour window elapsed, else reschedule the reveal for the remaining
//     time — reconstructing the reveal purely from persisted state, then resume
//     normal looping. So a restart never loses an open question.
//   * ACTIVE HOURS (11:00 AM–3:00 AM GMT+7, midnight-crossing — TEMP TESTING; revert END to 19 before go-live):
//     the loop only STARTS a new question when the clock is inside the active window.
//     A question that has already been posted runs its full 1-hour window even if
//     the reveal crosses the window boundary.  Outside hours the loop sleeps to
//     the next 11:00 GMT+7.  isActiveHour() handles both midnight-crossing and
//     same-day (END>START) windows.
//     Recover-on-boot is NOT gated — persisted open questions are always
//     revealed first; the start-gate applies only to posting the NEXT question.
//
// Graceful degradation: every public path checks db.isReady(); if the store is
// down, answer buttons reply "not configured" and startQuiz() no-ops. Loop
// errors are caught so one bad cycle can't kill the loop or the bot.
// ---------------------------------------------------------------------------

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const db = require('./db');
const { getRandomQuestion } = require('./questions');
const {
  QUESTION_WINDOW_MS,
  QUIZ_CHANNELS,
  LEADERBOARD_CHANNEL_ID,
  IDS,
  LETTERS,
  GMT7_OFFSET_MIN,
  QUIZ_ACTIVE_START_HOUR,
  QUIZ_ACTIVE_END_HOUR,
} = require('./constants');

// ---------------------------------------------------------------------------
// Embeds + components
// ---------------------------------------------------------------------------

// Live question embed (open state). correctUsers is the running "got it right"
// list shown publicly. Mirrors build_question_embed.
// NOTE: The A/B/C/D option-choice fields are intentionally omitted — the answer
// buttons already show "A. <option>" labels, so the fields were redundant.
function buildQuestionEmbed(questionText, options, correctUsers = []) {
  const embed = new EmbedBuilder()
    .setTitle('📝 Quiz Time!')
    .setDescription(questionText)
    .setColor(0xF1C40F); // gold

  const namesList = correctUsers.length
    ? correctUsers.map(n => `• ${n}`).join('\n')
    : '_no one yet — be the first!_';
  embed.addFields({ name: '✅ Correct so far', value: namesList, inline: false });

  embed.setFooter({ text: 'You have 1 hour to answer. Pick wisely!' });
  return embed;
}

// Final reveal embed (closed state). Reconstructable purely from persisted state.
// Unused after delete-on-close (revealQuestion now deletes the message instead of
// editing it to this embed). Kept on disk per §1.1 — do not delete.
function buildRevealEmbed(questionText, options, correctLetter, correctUsers = []) {
  const embed = new EmbedBuilder()
    .setTitle("⏰ Time's up!")
    .setDescription(questionText)
    .setColor(0x2ECC71); // green

  embed.addFields({
    name: '✅ Correct Answer',
    value: `${correctLetter}. ${options[correctLetter]}`,
    inline: false,
  });

  const namesList = correctUsers.length
    ? correctUsers.map(n => `• ${n}`).join('\n')
    : '_no one got this one right_';
  embed.addFields({ name: '🏅 Got it right', value: namesList, inline: false });

  return embed;
}

// 4 answer buttons (A-D). customId quiz:answer:<LETTER>. Label truncated to 80
// chars (Discord button-label cap; source truncates too).
function buildAnswerComponents(options) {
  const row = new ActionRowBuilder();
  for (const letter of LETTERS) {
    const label = `${letter}. ${options[letter]}`.slice(0, 80);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.ANSWER_PREFIX}:${letter}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return [row];
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function buildLeaderboardEmbed(rows) {
  const embed = new EmbedBuilder()
    .setTitle('🏆 Quiz Leaderboard')
    .setColor(0xF1C40F)
    .setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No scores yet — answer some questions!');
    return embed;
  }

  const lines = rows.map((row, i) =>
    `**${i + 1}. ${row.username}** — ${row.points || 0} pts (${row.correctCount || 0}✅ / ${row.wrongCount || 0}❌)`,
  );
  embed.setDescription(lines.join('\n'));
  return embed;
}

// Update (or create) the single live leaderboard message, keyed by guildId.
// Mirrors update_leaderboard: fetch stored id -> edit; on NotFound -> send +
// persist. Targets the LEADERBOARD_CHANNEL_ID channel.
async function updateLeaderboard(client, guild) {
  if (!db.isReady() || !guild) return;
  try {
    const lbChannel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
    if (!lbChannel || !lbChannel.isTextBased()) return;

    const rows = await db.getLeaderboard(15);
    const embed = buildLeaderboardEmbed(rows);

    const record = await db.getLeaderboardMessage(guild.id);
    if (record && record.messageId) {
      const existing = await lbChannel.messages.fetch(record.messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
      // fall through: stored message gone -> repost below
    }

    const sent = await lbChannel.send({ embeds: [embed] });
    await db.setLeaderboardMessage(guild.id, lbChannel.id, sent.id);
  } catch (err) {
    console.warn('[quiz] updateLeaderboard failed:', err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Close a question — DELETE the posted question message (Conrad's decision:
// keep the channel clean; no public reveal embed), clear the active record,
// then refresh the leaderboard.
//
// Deleting the bot's OWN message requires no extra permission — "Manage
// Messages" is only needed to delete OTHER users' messages.
//
// NotFound / already-gone is handled gracefully (try/catch); clearActiveQuestion
// and updateLeaderboard still run regardless.
//
// buildRevealEmbed is kept on disk (unused after this change) per §1.1.
// ---------------------------------------------------------------------------
async function revealQuestion(client, channel, activeDoc) {
  const { messageId } = activeDoc;
  try {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.delete();
    }
  } catch (err) {
    // NotFound or already deleted — proceed with cleanup regardless.
    console.warn('[quiz] question message delete failed (already gone?):', err?.message || err);
  }

  await db.clearActiveQuestion(channel.id).catch(() => {});
  await updateLeaderboard(client, channel.guild);
}

// ---------------------------------------------------------------------------
// Core loop: one independent loop per class channel.
//
// Optional `resume` (a persisted quiz_active doc) is handled FIRST:
//   * window elapsed  -> reveal immediately
//   * time remaining  -> wait the remaining delta, then reveal
// then we enter the normal forever post -> wait 30m -> reveal cycle.
// ---------------------------------------------------------------------------
async function channelQuizLoop(client, channel, channelKey, resume = null) {
  // Handle a recovered open question before normal looping.
  if (resume) {
    try {
      const postedAtMs = resume.postedAt instanceof Date
        ? resume.postedAt.getTime()
        : new Date(resume.postedAt).getTime();
      const elapsed = Date.now() - postedAtMs;
      const remaining = QUESTION_WINDOW_MS - elapsed;

      if (remaining > 0) {
        console.log(`[quiz] Resuming #${channelKey}: ${Math.round(remaining / 1000)}s left on the open question.`);
        await sleep(remaining);
      } else {
        console.log(`[quiz] Resuming #${channelKey}: open question already elapsed — revealing now.`);
      }
      await revealQuestion(client, channel, resume);
    } catch (err) {
      console.warn(`[quiz] resume handling failed for #${channelKey}:`, err?.message || err);
      // Best-effort cleanup so the loop can proceed cleanly.
      await db.clearActiveQuestion(channel.id).catch(() => {});
    }
  }

  // Normal forever loop.
  // Active-hours gate: checked at the TOP of every iteration (after the previous
  // question's reveal), so an in-flight 1-hour wait is never interrupted.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Sleep until 11:00 GMT+7 if we're outside the active window.
      await waitForActiveHours(channelKey);

      const q = getRandomQuestion(channelKey);
      if (!q) {
        console.warn(`[quiz] No questions for '${channelKey}', stopping loop.`);
        return;
      }
      const { options, correctAnswer } = q;

      const embed = buildQuestionEmbed(q.question, options);
      const components = buildAnswerComponents(options);
      const message = await channel.send({ embeds: [embed], components });

      await db.setActiveQuestion(
        channel.id,
        channelKey,
        message.id,
        q.question,
        options,
        correctAnswer,
        new Date(),
      );

      await sleep(QUESTION_WINDOW_MS);

      // Reveal from the freshly-stored active doc (carries the live correctUsers).
      const activeDoc = await db.getActiveQuestion(channel.id);
      if (activeDoc) {
        await revealQuestion(client, channel, activeDoc);
      }
      // Immediately loops to the next question.
    } catch (err) {
      console.warn(`[quiz] loop cycle error in #${channelKey} (continuing):`, err?.message || err);
      // Avoid a tight crash-loop on a persistent error.
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// Active-hours helpers (GMT+7, shift-then-UTC technique).
//
// All callers pass a nowMs epoch (milliseconds) so the functions are pure and
// trivially testable — no hidden Date.now() calls inside.
// ---------------------------------------------------------------------------

/**
 * Return a Date whose UTC fields (getUTCHours, getUTCMinutes, …) reflect
 * the wall-clock time in GMT+7 for the given UTC epoch.
 */
function toGmt7Date(nowMs) {
  return new Date(nowMs + GMT7_OFFSET_MIN * 60 * 1000);
}

/**
 * Return true if nowMs falls inside the active window GMT+7.
 *
 * Supports midnight-crossing windows. When QUIZ_ACTIVE_END_HOUR <= QUIZ_ACTIVE_START_HOUR
 * the window wraps across midnight:
 *   active when h >= START  OR  h < END   (e.g. START=11, END=3 → active 11–23 and 0,1,2)
 *
 * When END > START (same-day window, e.g. production END=19):
 *   active when h >= START  AND  h < END  (e.g. active 11–18)
 *
 * Both directions are handled by a single conditional so callers need no changes.
 */
function isActiveHour(nowMs) {
  const g = toGmt7Date(nowMs);
  const h = g.getUTCHours();
  if (QUIZ_ACTIVE_END_HOUR <= QUIZ_ACTIVE_START_HOUR) {
    // Midnight-crossing window: active in [START, 24) ∪ [0, END)
    return h >= QUIZ_ACTIVE_START_HOUR || h < QUIZ_ACTIVE_END_HOUR;
  }
  // Same-day window (normal case, e.g. production END=19)
  return h >= QUIZ_ACTIVE_START_HOUR && h < QUIZ_ACTIVE_END_HOUR;
}

/**
 * Compute the UTC epoch (ms) of the next 11:00:00 GMT+7 strictly after nowMs.
 *
 * Strategy:
 *   1. Build the GMT+7 wall-clock for today's 11:00 as a UTC epoch.
 *   2. If that instant is still in the future (nowMs < it), return it.
 *   3. Otherwise return tomorrow's 11:00.
 *
 * The shift-then-UTC technique:
 *   GMT+7 wall-clock Y-M-D 11:00 → UTC epoch = Date.UTC(Y,M,D,11,0,0) − offset_ms.
 */
function nextActiveStartMs(nowMs) {
  const offsetMs = GMT7_OFFSET_MIN * 60 * 1000;

  // Current GMT+7 wall-clock fields.
  const g = toGmt7Date(nowMs);
  const y = g.getUTCFullYear();
  const mo = g.getUTCMonth();  // 0-based
  const d  = g.getUTCDate();

  // UTC epoch of today's 11:00 GMT+7.
  const todayStart11Ms = Date.UTC(y, mo, d, QUIZ_ACTIVE_START_HOUR, 0, 0) - offsetMs;

  if (nowMs < todayStart11Ms) {
    return todayStart11Ms;
  }
  // Tomorrow's 11:00 GMT+7 — increment the GMT+7 calendar day.
  const tomorrowStart11Ms = Date.UTC(y, mo, d + 1, QUIZ_ACTIVE_START_HOUR, 0, 0) - offsetMs;
  return tomorrowStart11Ms;
}

/**
 * If the clock is outside the active window, sleep until the next 11:00 GMT+7.
 * Returns immediately (0 ms sleep) when already inside the window.
 *
 * Called at the TOP of each loop iteration — NEVER during the 60-min wait, so
 * an in-flight question always completes its full window before this gate fires.
 */
async function waitForActiveHours(channelKey) {
  const nowMs = Date.now();
  if (isActiveHour(nowMs)) return;  // already in window — post immediately

  const nextMs = nextActiveStartMs(nowMs);
  const delayMs = Math.max(0, nextMs - nowMs);
  const g = toGmt7Date(nextMs);
  console.log(
    `[quiz] #${channelKey}: outside active hours — sleeping ${Math.round(delayMs / 60000)} min ` +
    `until ${g.getUTCHours().toString().padStart(2, '0')}:00 GMT+7.`,
  );
  await sleep(delayMs);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Answer-button routing. Mirrors AnswerButton.callback.
// Returns true if this interaction belonged to the quiz feature.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (!interaction.isButton()) return false;
  const id = interaction.customId;
  if (!id.startsWith(`${IDS.ANSWER_PREFIX}:`)) return false;

  // From here the quiz owns the interaction (return true on every path).
  if (!db.isReady()) {
    await interaction.reply({ content: 'The quiz isn’t available right now.', ephemeral: true });
    return true;
  }

  const letter = id.split(':')[2];
  const channelId = interaction.channelId;

  const activeDoc = await db.getActiveQuestion(channelId);
  if (!activeDoc) {
    await interaction.reply({ content: 'This question has already closed.', ephemeral: true });
    return true;
  }

  if (await db.hasAnswered(channelId, interaction.user.id)) {
    await interaction.reply({ content: "You've already answered this question.", ephemeral: true });
    return true;
  }

  // Record the answer (one per user per question) and update the score.
  await db.recordAnswer(channelId, interaction.user.id);
  const isCorrect = letter === activeDoc.correctAnswer;
  await db.addPoint(interaction.user.id, interaction.member?.displayName ?? interaction.user.username, isCorrect);

  const options = activeDoc.options;

  if (isCorrect) {
    await interaction.reply({ content: '✅ Correct!', ephemeral: true });
    await db.recordCorrectAnswer(channelId, interaction.member?.displayName ?? interaction.user.username);

    // Edit the public message to add this person to the live "correct so far" list.
    try {
      const correctUsers = await db.getCorrectUsers(channelId);
      const embed = buildQuestionEmbed(activeDoc.question, options, correctUsers);
      if (interaction.message) {
        await interaction.message.edit({ embeds: [embed] });
      }
    } catch (err) {
      console.warn('[quiz] live correct-list edit failed:', err?.message || err);
    }
  } else {
    const correctLetter = activeDoc.correctAnswer;
    // PRIVATE only — no public change for wrong answers (privacy).
    await interaction.reply({
      content: `❌ Wrong! The correct answer is **${correctLetter}. ${options[correctLetter]}**`,
      ephemeral: true,
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Boot entrypoint. Called from events/ready.js AFTER db.initSchema() succeeds.
// For each of the 3 quiz channels: read any persisted open question, then start
// the per-channel loop (passing the open question to resume, if present).
// ---------------------------------------------------------------------------
async function startQuiz(client) {
  if (!db.isReady()) {
    console.warn('[quiz] startQuiz skipped — store not ready.');
    return;
  }

  // Map persisted open questions by channelId for quick lookup.
  let openByChannel = {};
  try {
    const open = await db.getAllActiveQuestions();
    for (const doc of open) openByChannel[doc.channelId] = doc;
  } catch (err) {
    console.warn('[quiz] could not read persisted open questions (starting fresh):', err?.message || err);
    openByChannel = {};
  }

  for (const [channelKey, channelId] of Object.entries(QUIZ_CHANNELS)) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.warn(`[quiz] Could not fetch channel for '${channelKey}' (${channelId}) — skipping:`, err?.message || err);
      continue;
    }
    if (!channel || !channel.isTextBased()) {
      console.warn(`[quiz] Channel for '${channelKey}' (${channelId}) is not text-based — skipping.`);
      continue;
    }

    const resume = openByChannel[channelId] || null;
    // Fire-and-forget: each channel loops independently, forever.
    channelQuizLoop(client, channel, channelKey, resume).catch(err => {
      console.error(`[quiz] loop for #${channelKey} terminated unexpectedly:`, err?.message || err);
    });
    console.log(`[quiz] Started loop for #${channelKey} (${channelId})${resume ? ' (resuming open question)' : ''}.`);
  }
}

module.exports = {
  route,
  startQuiz,
  // exported for tests / reuse
  buildQuestionEmbed,
  buildRevealEmbed,
  buildAnswerComponents,
  buildLeaderboardEmbed,
  channelQuizLoop,
  revealQuestion,
  updateLeaderboard,
  // active-hours helpers (exported for auditing)
  isActiveHour,
  nextActiveStartMs,
  toGmt7Date,
};
