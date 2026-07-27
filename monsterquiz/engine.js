// ---------------------------------------------------------------------------
// Monster Quiz — engine: game state machine + Discord I/O + timers.
//
// One active game per channel (Map keyed by channelId, in-memory). A bot restart
// drops all games (acceptable — no DB, no resume). Pure logic lives in
// ./logic.js; this module owns the Discord posting, the signup/round timers, and
// the per-channel state transitions.
//
// Flow: /monsterquiz → signup (60 s, Join button) → rounds (one per question,
// up to 60 s each) → final tally. See PROJECT SPEC / FEATURE-LOG for the exact
// timeout / ignored-round / race-guard rules implemented below.
//
// NO ephemeral replies anywhere: every slash reply is public; the Join button
// acks with deferUpdate() (a silent acknowledgement that posts no message).
//
// Timings are injectable per-game (startGame opts) so the simulation can drive
// rounds in milliseconds. NO database writes — endGame calls an onGameEnd hook
// that currently no-ops, leaving a clean seam for a future quiz/db.js save.
// ---------------------------------------------------------------------------

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const rodb = require('../rodb/db');
const logic = require('./logic');
const {
  SIGNUP_MS,
  ROUND_MS,
  MAX_CONSECUTIVE_IGNORED,
  JOIN_CUSTOM_ID,
  CATEGORIES,
} = require('./constants');

// channelId → game state. The single source of truth for "is a quiz running".
const games = new Map();

// ---------------------------------------------------------------------------
// Message payloads
// ---------------------------------------------------------------------------

function joinRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(JOIN_CUSTOM_ID)
      .setLabel(disabled ? 'Join (closed)' : 'Join')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function rosterLine(game) {
  if (game.participants.size === 0) return '_No one yet — be the first!_';
  const names = [...game.participants.keys()].map((id) => `<@${id}>`);
  return `Joined: ${names.join(', ')}`;
}

function buildSignupContent(game) {
  const secs = Math.round(game.signupMs / 1000);
  return [
    '🧩 **Monster Quiz!**',
    `Unscramble ${game.requested} jumbled name${game.requested === 1 ? '' : 's'} from the game database — monsters, equipment, and cards.`,
    `Tap **Join** in the next **${secs}s** to play. First to type the correct name each round scores a point.`,
    '',
    rosterLine(game),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Question sourcing — oversample each category, then logic.pickQuestions filters
// for fair names, dedupes, and selects up to `n`. sampleFn is injectable.
// ---------------------------------------------------------------------------
async function buildQuestionSet(n, sampleFn, rng) {
  const over = Math.max(n * 5, 25);
  const keys = Object.keys(CATEGORIES); // monster, item, card
  const results = await Promise.all(
    keys.map((k) => sampleFn(CATEGORIES[k].collectionKey, over).catch(() => [])),
  );
  const docsByCategory = {};
  keys.forEach((k, i) => { docsByCategory[k] = results[i] || []; });
  return logic.pickQuestions(docsByCategory, n, rng);
}

// ---------------------------------------------------------------------------
// startGame — entry from commands/monsterquiz.js. `interaction` is the chat
// command interaction (already validated as a chat input command). Options:
//   questions  clamped question count (the command clamps; we trust it)
//   signupMs, roundMs   timing overrides (default constants)
//   sampleFn(collectionKey, count) → docs[]   (default rodb.sampleDocs)
//   rng        () → [0,1) (default Math.random)
//   onGameEnd(summary)  end-of-game hook (default no-op — DB-save seam)
// Returns the game object (or null if it did not start).
// ---------------------------------------------------------------------------
async function startGame(interaction, opts = {}) {
  const channelId = interaction.channelId;

  // One game per channel.
  if (games.has(channelId)) {
    await interaction.reply({ content: 'A quiz is already running here.', allowedMentions: { parse: [] } });
    return null;
  }

  const sampleFn = opts.sampleFn
    || ((collectionKey, count) => rodb.sampleDocs(CATEGORIES_COLLECTION(collectionKey), count));
  const rng = opts.rng || Math.random;
  const requested = Number(opts.questions);

  // Build the question set up front so we can fail fast and note any shortfall.
  let questions = [];
  try {
    questions = await buildQuestionSet(requested, sampleFn, rng);
  } catch (err) {
    console.warn('[monsterquiz] Question build failed:', err?.message || err);
  }
  if (questions.length === 0) {
    await interaction.reply({
      content: "Couldn't build a quiz from the game database right now — please try again in a moment.",
      allowedMentions: { parse: [] },
    });
    return null;
  }

  const game = {
    channelId,
    channel: interaction.channel,
    client: interaction.client,
    status: 'signup',
    requested,
    questions,
    shortfall: questions.length < requested,
    participants: new Map(), // userId → { displayName }
    scores: new Map(),       // userId → number
    roundIndex: -1,
    currentRound: null,
    consecutiveIgnored: 0,
    signupMs: opts.signupMs != null ? opts.signupMs : SIGNUP_MS,
    roundMs: opts.roundMs != null ? opts.roundMs : ROUND_MS,
    rng,
    onGameEnd: typeof opts.onGameEnd === 'function' ? opts.onGameEnd : () => {},
    signupTimer: null,
    signupMessage: null,
  };
  games.set(channelId, game);

  // Post the public signup message (with the Join button) and keep a handle so
  // we can edit the roster in place.
  try {
    game.signupMessage = await interaction.reply({
      content: buildSignupContent(game),
      components: [joinRow(false)],
      allowedMentions: { parse: [] },
      fetchReply: true,
    });
  } catch (err) {
    console.warn('[monsterquiz] Failed to post signup message:', err?.message || err);
    games.delete(channelId);
    return null;
  }

  game.signupTimer = setTimeout(() => { void endSignup(game); }, game.signupMs);
  if (typeof game.signupTimer.unref === 'function') game.signupTimer.unref();
  return game;
}

// Resolve a category collectionKey to the actual rodb collection name.
function CATEGORIES_COLLECTION(collectionKey) {
  return rodb.COLLECTIONS[collectionKey];
}

// ---------------------------------------------------------------------------
// Join button — routed from events/interactionCreate.js. Returns true iff this
// module owned the interaction (repo router convention). Ack is deferUpdate()
// (silent — posts no message). Re-taps and taps after signup no-op silently.
// ---------------------------------------------------------------------------
async function route(interaction) {
  if (!interaction.isButton?.()) return false;
  if (interaction.customId !== JOIN_CUSTOM_ID) return false;

  // Silent ack first (never an ephemeral / visible reply).
  try { await interaction.deferUpdate(); } catch { /* window expired — ignore */ }

  const game = games.get(interaction.channelId);
  if (!game || game.status !== 'signup') return true; // stale button — no-op.

  const userId = interaction.user.id;
  if (game.participants.has(userId)) return true; // already joined — no-op.

  const displayName =
    interaction.member?.displayName ??
    interaction.user.globalName ??
    interaction.user.username;
  game.participants.set(userId, { displayName });

  // Edit the ONE signup message so the roster grows in place. parse:[] so the
  // edit never re-pings the listed players.
  try {
    if (game.signupMessage) {
      await game.signupMessage.edit({
        content: buildSignupContent(game),
        components: [joinRow(false)],
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    console.warn('[monsterquiz] Roster edit failed:', err?.message || err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// endSignup — signup window closed. Disable the Join button; cancel on zero
// joins, else start the rounds. Never throws.
// ---------------------------------------------------------------------------
async function endSignup(game) {
  if (game.status !== 'signup') return;
  game.signupTimer = null;

  // Disable the button so late taps can't fire.
  try {
    if (game.signupMessage) {
      await game.signupMessage.edit({
        content: buildSignupContent(game),
        components: [joinRow(true)],
        allowedMentions: { parse: [] },
      });
    }
  } catch { /* best-effort */ }

  if (game.participants.size === 0) {
    try {
      if (game.signupMessage) {
        await game.signupMessage.edit({
          content: 'Monster Quiz — No one joined — quiz cancelled.',
          components: [],
          allowedMentions: { parse: [] },
        });
      }
    } catch { /* best-effort */ }
    cleanup(game);
    return;
  }

  // ≥1 player → start (solo allowed). Init scores at 0 for everyone.
  game.status = 'playing';
  for (const userId of game.participants.keys()) game.scores.set(userId, 0);

  const startLines = [
    `🎮 **Monster Quiz starting!** ${game.participants.size} player${game.participants.size === 1 ? '' : 's'} · ${game.questions.length} round${game.questions.length === 1 ? '' : 's'}.`,
  ];
  if (game.shortfall) {
    startLines.push(`_(Only ${game.questions.length} fair name${game.questions.length === 1 ? '' : 's'} available right now — running with what we have.)_`);
  }
  startLines.push('Type the unscrambled name in chat. First correct answer wins the round.');
  await safeSend(game, startLines.join('\n'));

  game.roundIndex = -1;
  await advance(game);
}

// ---------------------------------------------------------------------------
// startRound — post round N and arm its timeout. Each round has a `resolved`
// flag (the race guard) so a message landing as the timer fires (or vice versa)
// resolves the round exactly once.
// ---------------------------------------------------------------------------
async function startRound(game) {
  const q = game.questions[game.roundIndex];
  const noun = CATEGORIES[q.category].noun;
  const round = {
    index: game.roundIndex,
    question: q,
    resolved: false,
    hadActivity: false,
    timer: null,
  };
  game.currentRound = round;

  // Jumble + length hint describe the JUMBLE SOURCE (for cards that's the base
  // name with the trailing " Card" removed). The reveal still uses the full
  // answer name.
  const jumbleSource = q.jumbleSource || q.answer;
  const jumbled = logic.jumble(jumbleSource, game.rng || Math.random);
  const hint = `${logic.buildHint(q.record, q.category)} · ${logic.lengthHint(jumbleSource)}`;
  const content = [
    `**Round ${game.roundIndex + 1}/${game.questions.length}** — Unscramble this **${noun}**:`,
    '```',
    jumbled,
    '```',
    `**Hint:** ${hint}`,
  ].join('\n');
  await safeSend(game, content);

  round.timer = setTimeout(() => { void settleTimeout(game, round); }, game.roundMs);
  if (typeof round.timer.unref === 'function') round.timer.unref();
}

// ---------------------------------------------------------------------------
// settleCorrect — a participant guessed right. Race-guarded. Awards +1, reveals,
// resets the ignored streak, advances.
// ---------------------------------------------------------------------------
async function settleCorrect(game, round, userId) {
  if (round.resolved) return;
  round.resolved = true;
  if (round.timer) { clearTimeout(round.timer); round.timer = null; }

  game.scores.set(userId, (game.scores.get(userId) || 0) + 1);
  game.consecutiveIgnored = 0;

  await safeSend(
    game,
    `✅ <@${userId}> got it — it was **${round.question.answer}**! (+1)`,
    { users: [userId] },
  );
  await advance(game);
}

// ---------------------------------------------------------------------------
// settleTimeout — 60 s elapsed with no correct answer. Race-guarded. Reveals the
// answer; a round with ZERO participant activity increments the ignored streak
// (any activity — even all-wrong guesses — resets it). Two consecutive ignored
// rounds end the game early.
// ---------------------------------------------------------------------------
async function settleTimeout(game, round) {
  if (round.resolved) return;
  round.resolved = true;
  round.timer = null;

  await safeSend(game, `⏱️ Time's up — it was **${round.question.answer}**.`);

  if (round.hadActivity) {
    game.consecutiveIgnored = 0;
  } else {
    game.consecutiveIgnored += 1;
  }

  if (game.consecutiveIgnored >= MAX_CONSECUTIVE_IGNORED) {
    await safeSend(game, "No one's answering — ending the quiz.");
    await endGame(game);
    return;
  }
  await advance(game);
}

// ---------------------------------------------------------------------------
// advance — move to the next round, or end after the last one.
// ---------------------------------------------------------------------------
async function advance(game) {
  if (game.status !== 'playing') return;
  game.roundIndex += 1;
  if (game.roundIndex >= game.questions.length) {
    await endGame(game);
    return;
  }
  await startRound(game);
}

// ---------------------------------------------------------------------------
// endGame — final tally (everyone who joined, sorted desc), then clear state and
// fire the no-op onGameEnd hook (future quiz/db.js save seam).
// ---------------------------------------------------------------------------
async function endGame(game) {
  if (game.status === 'ended') return;
  game.status = 'ended';
  if (game.currentRound?.timer) { clearTimeout(game.currentRound.timer); game.currentRound.timer = null; }

  const rows = [...game.participants.entries()].map(([userId, p]) => ({
    userId,
    displayName: p.displayName,
    score: game.scores.get(userId) || 0,
  }));
  rows.sort((a, b) => (b.score - a.score) || a.displayName.localeCompare(b.displayName));

  const tally = rows.map((r) => `<@${r.userId}> ${r.score}`).join(' · ');
  await safeSend(game, `🏁 Final scores: ${tally || '(no players)'}`);

  // DB-save seam — currently a no-op. A future quiz/db.js persist drops in here.
  try {
    game.onGameEnd({
      channelId: game.channelId,
      rounds: game.questions.length,
      scores: rows,
    });
  } catch (err) {
    console.warn('[monsterquiz] onGameEnd hook failed:', err?.message || err);
  }

  cleanup(game);
}

// Remove the game from the channel map and clear any live timers.
function cleanup(game) {
  if (game.signupTimer) { clearTimeout(game.signupTimer); game.signupTimer = null; }
  if (game.currentRound?.timer) { clearTimeout(game.currentRound.timer); game.currentRound.timer = null; }
  if (games.get(game.channelId) === game) games.delete(game.channelId);
}

// ---------------------------------------------------------------------------
// onMessage — additive hook from events/messageCreate.js. Fire-and-forget; must
// NEVER throw into or block the kudos flow. Only messages from joined
// participants during an active round count. Correct → win the round; wrong →
// stay silent (but the round is marked as having had activity).
// ---------------------------------------------------------------------------
function onMessage(message) {
  try {
    if (message?.author?.bot) return;
    const game = games.get(message?.channelId);
    if (!game || game.status !== 'playing') return;
    const round = game.currentRound;
    if (!round || round.resolved) return;

    const userId = message.author?.id;
    if (!userId || !game.participants.has(userId)) return; // non-participant → ignored entirely.

    // A real participant spoke this round → it's no longer "ignored".
    round.hadActivity = true;

    if (typeof message.content !== 'string') return;
    if (logic.isCorrectForCategory(message.content, round.question.answer, round.question.category)) {
      void settleCorrect(game, round, userId);
    }
    // Wrong → do nothing (stay silent).
  } catch (err) {
    console.warn('[monsterquiz] onMessage failed (kudos unaffected):', err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// safeSend — post to the game's channel; never throws. allowedMentions defaults
// to parse:[] (no pings) unless a users list is supplied (single-winner ping).
// ---------------------------------------------------------------------------
async function safeSend(game, content, mentions = { parse: [] }) {
  try {
    return await game.channel.send({ content, allowedMentions: mentions });
  } catch (err) {
    console.warn('[monsterquiz] send failed:', err?.message || err);
    return null;
  }
}

// Test/inspection helpers.
function _hasGame(channelId) { return games.has(channelId); }
function _getGame(channelId) { return games.get(channelId); }
function _reset() {
  for (const game of games.values()) cleanup(game);
  games.clear();
}

module.exports = {
  startGame,
  route,
  onMessage,
  // internals exported for the simulation / future tests
  buildQuestionSet,
  endSignup,
  startRound,
  settleCorrect,
  settleTimeout,
  advance,
  endGame,
  _games: games,
  _hasGame,
  _getGame,
  _reset,
};
