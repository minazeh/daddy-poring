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

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const rodb = require('../rodb/db');
const logic = require('./logic');
const banks = require('./banks');
const {
  SIGNUP_MS,
  ROUND_MS,
  MAX_CONSECUTIVE_IGNORED,
  JOIN_CUSTOM_ID,
  SELECT_CUSTOM_ID,
  CATEGORIES,
  CATEGORY_REGISTRY,
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

// The category select menu (choosing phase). Options come straight from the
// registry, in insertion order.
function categoryRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_CUSTOM_ID)
    .setPlaceholder('Choose a quiz category…')
    .addOptions(
      Object.values(CATEGORY_REGISTRY).map((c) => ({
        label: c.label,
        value: c.key,
        emoji: c.emoji,
        description: c.description,
      })),
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildChooseContent(game) {
  return [
    '🧩 **Monster Quiz!**',
    `Pick a category below to start a **${game.requested}-round** quiz. Only <@${game.initiatorId}> (who started it) can choose.`,
    '',
    Object.values(CATEGORY_REGISTRY)
      .map((c) => `${c.emoji} **${c.label}** — ${c.description}`)
      .join('\n'),
  ].join('\n');
}

function rosterLine(game) {
  if (game.participants.size === 0) return '_No one yet — be the first!_';
  const names = [...game.participants.keys()].map((id) => `<@${id}>`);
  return `Joined: ${names.join(', ')}`;
}

// Signup blurb varies by the chosen category's mode; roster + Join line shared.
function buildSignupContent(game) {
  const secs = Math.round(game.signupMs / 1000);
  const cat = CATEGORY_REGISTRY[game.category] || {};
  const emoji = cat.emoji || '🧩';
  const label = cat.label || 'Monster Quiz';
  const n = game.requested;
  const plural = n === 1 ? '' : 's';

  let blurb;
  if (game.mode === 'truefalse') {
    blurb = `${n} True-or-False question${plural} — **${label}**.`;
  } else if (game.mode === 'trivia') {
    blurb = `${n} trivia question${plural} — **${label}**. Type your answer in chat.`;
  } else {
    blurb = `Unscramble ${n} jumbled name${plural} from the game database — monsters, equipment, and cards.`;
  }

  return [
    `${emoji} **Monster Quiz — ${label}!**`,
    blurb,
    `Tap **Join** in the next **${secs}s** to play. First to answer correctly each round scores a point.`,
    '',
    rosterLine(game),
  ].join('\n');
}

// The reveal string for a resolved round — jumble/TF use `answer`, trivia uses
// the first (canonical) accepted answer.
function revealAnswer(question) {
  if (question.mode === 'trivia') {
    return Array.isArray(question.answers) ? question.answers[0] : '';
  }
  return question.answer;
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
//   chooseMs   category-select window override (default = signupMs)
//   sampleFn(collectionKey, count) → docs[]   (default rodb.sampleDocs)
//   rng        () → [0,1) (default Math.random)
//   onGameEnd(summary)  end-of-game hook (default no-op — DB-save seam)
//
// New flow: post a CATEGORY SELECT menu (status 'choosing') and record the
// initiator. The question set is NOT built here anymore — it's built once the
// initiator picks a category (routeCategorySelect), because the format depends
// on the choice. Returns the game object (or null if it did not start).
// ---------------------------------------------------------------------------
async function startGame(interaction, opts = {}) {
  const channelId = interaction.channelId;

  // One game per channel (covers choosing / signup / playing alike).
  if (games.has(channelId)) {
    await interaction.reply({ content: 'A quiz is already running here.', allowedMentions: { parse: [] } });
    return null;
  }

  const rng = opts.rng || Math.random;
  const requested = Number(opts.questions);
  const signupMs = opts.signupMs != null ? opts.signupMs : SIGNUP_MS;

  const game = {
    channelId,
    channel: interaction.channel,
    client: interaction.client,
    status: 'choosing',
    initiatorId: interaction.user.id,
    requested,
    // Chosen at select time:
    category: null,
    mode: null,
    questions: null,
    shortfall: false,
    // Question-build inputs, stashed for routeCategorySelect:
    sampleFn: opts.sampleFn
      || ((collectionKey, count) => rodb.sampleDocs(CATEGORIES_COLLECTION(collectionKey), count)),
    participants: new Map(), // userId → { displayName }
    scores: new Map(),       // userId → number
    roundIndex: -1,
    currentRound: null,
    consecutiveIgnored: 0,
    signupMs,
    roundMs: opts.roundMs != null ? opts.roundMs : ROUND_MS,
    chooseMs: opts.chooseMs != null ? opts.chooseMs : signupMs,
    rng,
    onGameEnd: typeof opts.onGameEnd === 'function' ? opts.onGameEnd : () => {},
    chooseTimer: null,
    signupTimer: null,
    signupMessage: null,
  };
  games.set(channelId, game);

  // Post the public category-select message; keep the handle so every later
  // phase edits this ONE message in place.
  try {
    game.signupMessage = await interaction.reply({
      content: buildChooseContent(game),
      components: [categoryRow()],
      allowedMentions: { parse: [] },
      fetchReply: true,
    });
  } catch (err) {
    console.warn('[monsterquiz] Failed to post category message:', err?.message || err);
    games.delete(channelId);
    return null;
  }

  // Guard against an orphaned channel lock: if nobody picks within chooseMs,
  // cancel the game so the channel frees up. (Not in the original single-format
  // flow — added because the choosing phase can otherwise hold the one-per-
  // channel lock forever. Flagged for Nanna.)
  game.chooseTimer = setTimeout(() => { void endChoosing(game); }, game.chooseMs);
  if (typeof game.chooseTimer.unref === 'function') game.chooseTimer.unref();
  return game;
}

// ---------------------------------------------------------------------------
// endChoosing — the category-select window closed with no pick. Cancel the game
// and free the channel. Never throws.
// ---------------------------------------------------------------------------
async function endChoosing(game) {
  if (game.status !== 'choosing') return;
  game.chooseTimer = null;
  try {
    if (game.signupMessage) {
      await game.signupMessage.edit({
        content: 'Monster Quiz — no category chosen — quiz cancelled.',
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  } catch { /* best-effort */ }
  cleanup(game);
}

// ---------------------------------------------------------------------------
// routeCategorySelect — the initiator picked a category from the select menu.
// Ack is deferUpdate() (silent). Only the initiator may pick; anyone else is a
// silent no-op. Builds the chosen format's question set, then transitions the
// SAME message into the signup phase (Join button) and arms the signup timer.
// An empty set fails gracefully (public edit + cleanup). Returns true (owned).
// ---------------------------------------------------------------------------
async function routeCategorySelect(interaction) {
  // Silent ack (never ephemeral / visible).
  try { await interaction.deferUpdate(); } catch { /* window expired — ignore */ }

  const game = games.get(interaction.channelId);
  if (!game || game.status !== 'choosing') return true; // stale menu — no-op.
  if (interaction.user.id !== game.initiatorId) return true; // only the initiator picks.

  const key = interaction.values?.[0];
  const cat = CATEGORY_REGISTRY[key];
  if (!cat) return true; // unknown option — ignore.

  // Claim the choice: stop the choose timer so a late timeout can't cancel us.
  if (game.chooseTimer) { clearTimeout(game.chooseTimer); game.chooseTimer = null; }
  game.category = cat.key;
  game.mode = cat.mode;

  // Build the question set for the chosen format.
  let questions = [];
  try {
    if (cat.mode === 'jumble') {
      questions = await buildQuestionSet(game.requested, game.sampleFn, game.rng);
    } else {
      questions = logic.pickBankQuestions(banks.get(cat.key), cat.mode, game.requested, game.rng);
    }
  } catch (err) {
    console.warn('[monsterquiz] Question build failed:', err?.message || err);
  }

  if (!questions || questions.length === 0) {
    const why = cat.mode === 'jumble'
      ? "Couldn't build a quiz from the game database right now — please try again in a moment."
      : `Couldn't load the ${cat.label} question bank right now — please try again in a moment.`;
    try {
      if (game.signupMessage) {
        await game.signupMessage.edit({ content: why, components: [], allowedMentions: { parse: [] } });
      }
    } catch { /* best-effort */ }
    cleanup(game);
    return true;
  }

  game.questions = questions;
  game.shortfall = questions.length < game.requested;
  game.status = 'signup';

  // Transition the ONE message into the signup phase.
  try {
    if (game.signupMessage) {
      await game.signupMessage.edit({
        content: buildSignupContent(game),
        components: [joinRow(false)],
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    console.warn('[monsterquiz] Failed to post signup message:', err?.message || err);
    cleanup(game);
    return true;
  }

  game.signupTimer = setTimeout(() => { void endSignup(game); }, game.signupMs);
  if (typeof game.signupTimer.unref === 'function') game.signupTimer.unref();
  return true;
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
  // Category select menu (choosing phase). Claimed before the button check.
  if (interaction.isStringSelectMenu?.() && interaction.customId === SELECT_CUSTOM_ID) {
    return routeCategorySelect(interaction);
  }

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
    const noun = game.mode === 'jumble' ? 'fair name' : 'question';
    startLines.push(`_(Only ${game.questions.length} ${noun}${game.questions.length === 1 ? '' : 's'} available right now — running with what we have.)_`);
  }
  if (game.mode === 'truefalse') {
    startLines.push('Answer **True** or **False** in chat. First correct answer wins the round.');
  } else if (game.mode === 'trivia') {
    startLines.push('Type your answer in chat. First correct answer wins the round.');
  } else {
    startLines.push('Type the unscrambled name in chat. First correct answer wins the round.');
  }
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
  const round = {
    index: game.roundIndex,
    question: q,
    resolved: false,
    hadActivity: false,
    timer: null,
  };
  game.currentRound = round;

  const header = `**Round ${game.roundIndex + 1}/${game.questions.length}**`;
  let content;
  if (q.mode === 'truefalse') {
    content = [
      `${header} — True or False?`,
      '```',
      q.question,
      '```',
      'Answer **True** or **False**.',
    ].join('\n');
  } else if (q.mode === 'trivia') {
    content = [
      `${header}`,
      '```',
      q.question,
      '```',
      'Type your answer in chat.',
    ].join('\n');
  } else {
    // jumble: the jumble + length hint describe the JUMBLE SOURCE (for cards
    // that's the base name with the trailing " Card" removed). The reveal still
    // uses the full answer name.
    const noun = CATEGORIES[q.category].noun;
    const jumbleSource = q.jumbleSource || q.answer;
    const jumbled = logic.jumble(jumbleSource, game.rng || Math.random);
    const hint = `${logic.buildHint(q.record, q.category)} · ${logic.lengthHint(jumbleSource)}`;
    content = [
      `${header} — Unscramble this **${noun}**:`,
      '```',
      jumbled,
      '```',
      `**Hint:** ${hint}`,
    ].join('\n');
  }
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
    `✅ <@${userId}> got it — it was **${revealAnswer(round.question)}**! (+1)`,
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

  await safeSend(game, `⏱️ Time's up — it was **${revealAnswer(round.question)}**.`);

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
  if (game.chooseTimer) { clearTimeout(game.chooseTimer); game.chooseTimer = null; }
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
    if (logic.isCorrectForQuestion(message.content, round.question)) {
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
  routeCategorySelect,
  endChoosing,
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
