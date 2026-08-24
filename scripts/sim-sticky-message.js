// ---------------------------------------------------------------------------
// Sim / verification for /stickymessage.
//
// Runs the REAL sticky/db.js, sticky/engine.js, sticky/handlers.js,
// sticky/resume.js and commands/stickymessage.js against a fake in-memory Mongo
// (injected through db._setCollectionsForTests, the same hook partyfinder/db.js
// and activitycampaign/db.js expose), a fake Discord client, and a VIRTUAL
// CLOCK. No Atlas, no network, no token, nothing real is posted.
//
// It exists to PROVE what spec §9 says this feature must get right, rather than
// assert it in a comment:
//
//   A. THE HOT PATH IS ONE Map.has() (spec §2). Instrumented, counted — not
//      eyeballed. A hook on messageCreate runs for EVERY message in the server.
//   B. DEBOUNCE (spec §6). Fires after the window, never before; a burst
//      collapses to one repost; state is PER-CHANNEL, so a flooded channel
//      cannot delay a quiet one.
//   C. SKIP WHEN ALREADY NEWEST, and NO SELF-TRIGGER LOOP — proven through the
//      REAL events/messageCreate.js, not just the module.
//   D. THE LENGTH TRAP (spec §4.1). 2,001-4,000 chars with no title becomes a
//      TITLELESS EMBED, and every single character survives. Checked at the
//      boundary and end to end through the modal submit.
//   E. INVALID HEX FALLS BACK rather than erroring.
//   F. STICKY-ON-STICKY (spec §5) — refused in a ticket channel and in the
//      campaign channel, naming the owner, through the real command.
//   G. RESTART (spec §7). The Map is wiped and rebuilt from Mongo, re-attaching
//      by persisted messageId — and NOTHING is reposted on boot.
//   H. ROUTER ISOLATION, both directions, as the carry build did.
//   I. REGISTRATION goes up by EXACTLY ONE, every other command intact.
//
// Plus the failure postures: DB down, channel deleted, sticky deleted by hand,
// and a send that fails for any other reason.
//
// Run: node scripts/sim-sticky-message.js
// ---------------------------------------------------------------------------

const path = require('node:path');

// Loaded before anything sets MONGODB_URI so no module-level MongoClient is
// ever constructed.
delete process.env.MONGODB_URI;

const { ChannelType, EmbedBuilder } = require('discord.js');

const db = require('../sticky/db');
const engine = require('../sticky/engine');
const handlers = require('../sticky/handlers');
const { resume } = require('../sticky/resume');
const stickyCommand = require('../commands/stickymessage');
const {
  IDS,
  MODES,
  STICKY_ROLE_IDS,
  DEFAULT_COLOR,
  PLAIN_CONTENT_MAX,
  MODAL_CONTENT_MAX,
  REPOST_COOLDOWN_MS,
  ERR_UNKNOWN_CHANNEL,
} = require('../sticky/constants');

const ticketSticky = require('../ticket/sticky');
const ticketDb = require('../ticket/db');
const campaignDb = require('../activitycampaign/db');
const { REMINDER_CHANNEL_ID } = require('../gvg/constants');
const { GODFATHERS_ROLE_ID } = require('../ticket/constants');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (cond) console.log(`  ok  - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures++; }
}
function section(title) { console.log(`\n[${title}]`); }

// ---------------------------------------------------------------------------
// Virtual clock.
//
// The debounce is 10 SECONDS. A sim that actually waited would take minutes and
// would prove timing by sleeping, which is not proof. Date.now and setTimeout
// are replaced with a clock the sim drives by hand, so "fired at 9,999 ms: no;
// at 10,000 ms: yes" is an exact statement rather than a race.
//
// setImmediate is deliberately NOT replaced — the fake Mongo's await boundary
// and the flush helper both ride on it, so async work still settles normally
// while virtual time stands still.
// ---------------------------------------------------------------------------
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

let vnow = 1_700_000_000_000;
let timerSeq = 0;
let timers = [];

function installClock() {
  Date.now = () => vnow;
  global.setTimeout = (fn, ms = 0) => {
    const t = { _id: ++timerSeq, at: vnow + ms, fn, unref() { return this; } };
    timers.push(t);
    return t;
  };
  global.clearTimeout = (t) => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };
}
function restoreClock() {
  Date.now = realNow;
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

// Let every pending promise / fake-Mongo await settle without moving the clock.
async function flush(turns = 40) {
  for (let i = 0; i < turns; i++) await new Promise(res => setImmediate(res));
}

// Move virtual time forward, firing every timer that comes due, in order.
async function advance(ms) {
  const target = vnow + ms;
  for (;;) {
    const due = timers
      .filter(t => t.at <= target)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    vnow = due.at;
    try { due.fn(); } catch (err) { console.error('  timer threw:', err); failures++; }
    await flush();
  }
  vnow = target;
  await flush();
}

function pendingTimerCount() { return timers.length; }

// ---------------------------------------------------------------------------
// Fake Mongo — just enough of the query/update language for the real
// sticky/db.js to run unchanged, including $set / $setOnInsert / upsert, which
// is what makes "one document per channel" true rather than merely intended.
//
// Reads return CLONES, exactly like the driver, so a test that inspects a
// document cannot accidentally be inspecting the engine's own object.
// ---------------------------------------------------------------------------
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const tick = () => new Promise(res => setImmediate(res));

function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v]) => {
    const actual = doc[k];
    if (v instanceof Date && actual instanceof Date) return v.getTime() === actual.getTime();
    return actual === v;
  });
}

function makeCollection(name) {
  const docs = new Map();
  let deletes = 0;
  let upserts = 0;

  return {
    _name: name,
    _docs: docs,
    get _deletes() { return deletes; },
    get _upserts() { return upserts; },

    async createIndex() { return name; },

    async findOne(query) {
      await tick();
      for (const doc of docs.values()) if (matches(doc, query)) return clone(doc);
      return null;
    },

    find(query) {
      let sortSpec = null;
      const self = {
        sort(spec) { sortSpec = spec; return self; },
        async toArray() {
          await tick();
          let out = [...docs.values()].filter(d => matches(d, query));
          if (sortSpec) {
            const [key, dir] = Object.entries(sortSpec)[0];
            out = out.sort((a, b) => {
              const av = a[key] instanceof Date ? a[key].getTime() : a[key];
              const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
              return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
            });
          }
          return out.map(clone);
        },
      };
      return self;
    },

    async updateOne(filter, update, opts = {}) {
      await tick();
      for (const doc of docs.values()) {
        if (!matches(doc, filter)) continue;
        if (update.$set) Object.assign(doc, update.$set);
        // $setOnInsert is a NO-OP on an existing document. That is the property
        // that keeps createdAt stable across a `set` that replaces a sticky.
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (opts.upsert) {
        upserts++;
        const doc = { ...filter, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
        docs.set(doc._id, doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },

    async deleteOne(query) {
      await tick();
      for (const doc of docs.values()) {
        if (matches(doc, query)) { docs.delete(doc._id); deletes++; return { deletedCount: 1 }; }
      }
      return { deletedCount: 0 };
    },
  };
}

let stickyCol;
function resetStore() {
  stickyCol = makeCollection('sticky_messages');
  db._setCollectionsForTests(stickyCol);
  engine._resetForTests();
  timers = [];
}

// ---------------------------------------------------------------------------
// Fake Discord.
//
// `lastMessageId` behaves the way Discord's does, which is the whole basis of
// the skip-when-newest guard: it advances on every send, and DELETING a message
// does NOT roll it back. That is why a sticky deleted by hand is reposted on the
// next human message and not before.
// ---------------------------------------------------------------------------
function makeClient() {
  const channels = new Map();
  const client = {
    _nextId: 5000,
    user: { id: 'BOT', bot: true },
    channels: {
      async fetch(id) {
        const ch = channels.get(id);
        if (!ch) {
          const err = new Error('Unknown Channel');
          err.code = ERR_UNKNOWN_CHANNEL;
          throw err;
        }
        return ch;
      },
    },
    _channels: channels,
  };

  client.addChannel = (id, { type = ChannelType.GuildText, textBased = true } = {}) => {
    const ch = {
      id,
      client,
      type,
      guildId: 'G1',
      lastMessageId: null,
      sent: [],          // every payload the bot posted here
      deletedIds: [],    // every message id the bot deleted here
      live: new Set(),
      failNextSend: null,
      isTextBased: () => textBased,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      async send(payload) {
        if (ch.failNextSend) {
          const err = ch.failNextSend;
          ch.failNextSend = null;
          throw err;
        }
        const mid = String(++client._nextId);
        const msg = { id: mid, channelId: id, payload };
        ch.sent.push(msg);
        ch.live.add(mid);
        ch.lastMessageId = mid;
        return msg;
      },
      messages: {
        async delete(mid) {
          if (!ch.live.has(mid)) throw new Error('Unknown Message');
          ch.live.delete(mid);
          ch.deletedIds.push(mid);
          // lastMessageId is deliberately NOT rolled back — Discord doesn't.
        },
      },
    };
    channels.set(id, ch);
    return ch;
  };

  client.removeChannel = (id) => channels.delete(id);
  return client;
}

// A human message landing in a channel: it becomes the newest message.
function humanMessage(channel, { bot = false, content = 'hello', authorId = 'human1' } = {}) {
  const mid = String(++channel.client._nextId);
  channel.lastMessageId = mid;
  return {
    id: mid,
    channelId: channel.id,
    channel,
    content,
    guild: { id: 'G1' },
    client: channel.client,
    author: { id: authorId, bot, tag: `${authorId}#0001` },
    mentions: { users: new Map() },
  };
}

// The bot's own sticky, fed back in as if the gateway delivered it.
function botMessage(channel) {
  return {
    id: channel.lastMessageId,
    channelId: channel.id,
    channel,
    content: 'sticky',
    guild: { id: 'G1' },
    client: channel.client,
    author: { id: 'BOT', bot: true, tag: 'bot#0000' },
    mentions: { users: new Map() },
  };
}

// ---------------------------------------------------------------------------
// Fake interactions
// ---------------------------------------------------------------------------
function member(roleIds = [GODFATHERS_ROLE_ID], displayName = 'Officer Ren') {
  return { roles: { cache: { has: (id) => roleIds.includes(id) } }, displayName };
}

function modalSubmit(client, { mode = MODES.SET, channelId, content, title = '', color = '', roles = [GODFATHERS_ROLE_ID], userId = 'off1' } = {}) {
  const shown = [];
  return {
    customId: `${IDS.MODAL}:${mode}:${channelId}`,
    shown,
    client,
    guildId: 'G1',
    user: { id: userId, username: 'officer' },
    member: member(roles),
    fields: {
      getTextInputValue(key) {
        if (key === 'content') return content;
        if (key === 'title') return title;
        if (key === 'color') return color;
        return '';
      },
    },
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    defers: [],
    async deferReply(opts) { this.defers.push(opts); },
    async reply(p) { shown.push(typeof p === 'string' ? { content: p } : p); },
    async editReply(p) { shown.push(typeof p === 'string' ? { content: p } : p); },
    get last() { return shown.length ? shown[shown.length - 1] : null; },
  };
}

function slash(client, channel, sub, { roles = [GODFATHERS_ROLE_ID] } = {}) {
  const replies = [];
  const modals = [];
  return {
    replies,
    modals,
    client,
    channel,
    guildId: 'G1',
    guild: { id: 'G1', members: { me: { id: 'BOT' } } },
    user: { id: 'off1', username: 'officer' },
    member: member(roles),
    options: { getSubcommand: () => sub },
    defers: [],
    async reply(p) { replies.push(typeof p === 'string' ? { content: p } : p); },
    async deferReply(opts) { this.defers.push(opts); },
    async editReply(p) { replies.push(typeof p === 'string' ? { content: p } : p); },
    async showModal(m) { modals.push(m); },
    get lastReply() { return replies.length ? replies[replies.length - 1].content : ''; },
  };
}

// Drive a full `set` (or `edit`) the way an officer would: run the command,
// take the modal it showed, and submit it through the REAL router.
async function runSet(client, channel, { sub = 'set', content, title = '', color = '', roles = [GODFATHERS_ROLE_ID] } = {}) {
  const cmd = slash(client, channel, sub, { roles });
  await stickyCommand.execute(cmd);
  if (!cmd.modals.length) return { cmd, submitted: null, claimed: null };

  const modal = cmd.modals[0].toJSON();
  const sub2 = modalSubmit(client, {
    mode: modal.custom_id.split(':')[2],
    channelId: channel.id,
    content, title, color, roles,
  });
  const claimed = await handlers.route(sub2);
  await flush();
  return { cmd, submitted: sub2, claimed, modal };
}

// ---------------------------------------------------------------------------
async function main() {
  installClock();

  // =========================================================================
  section('A. the hot path — events/messageCreate runs this for EVERY message');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const chA = client.addChannel('C_A');
    client.addChannel('C_NOISE');

    // Instrument the engine's own watch Map. `watched.has(...)` is a property
    // lookup at call time, so overriding it here is genuinely counting the real
    // calls the real code makes — not a re-implementation.
    const map = engine._watched;
    const realHas = Map.prototype.has.bind(map);
    const realGet = Map.prototype.get.bind(map);
    let hasCalls = 0; let getCalls = 0;
    map.has = (k) => { hasCalls++; return realHas(k); };
    map.get = (k) => { getCalls++; return realGet(k); };

    // No stickies at all: the `watched.size === 0` short-circuit must fire
    // BEFORE the Map lookup, so the cost is literally zero.
    for (let i = 0; i < 1000; i++) engine.onMessage(humanMessage(client._channels.get('C_NOISE')));
    assert(hasCalls === 0, 'with no stickies anywhere, 1,000 messages cost ZERO Map lookups (size check short-circuits)');

    // One sticky somewhere in the server; 1,000 messages in other channels.
    await runSet(client, chA, { content: 'Read the rules.' });
    hasCalls = 0; getCalls = 0;
    for (let i = 0; i < 1000; i++) engine.onMessage(humanMessage(client._channels.get('C_NOISE')));
    assert(hasCalls === 1000, `1,000 messages outside a sticky channel cost EXACTLY 1,000 Map.has() calls (got ${hasCalls})`);
    assert(getCalls === 0, 'and ZERO Map.get() calls — the miss never reaches the entry');
    assert(pendingTimerCount() === 0, 'and scheduled no timers');

    map.has = realHas; map.get = realGet;
  }

  // =========================================================================
  section('B. debounce — fires AFTER the window, never before (spec §6)');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_B');

    await runSet(client, ch, { content: 'Sticky B' });
    assert(ch.sent.length === 1, 'set posts the sticky immediately');
    const firstId = ch.sent[0].id;

    // A message arrives right after the install, i.e. inside the window.
    engine.onMessage(humanMessage(ch));
    await flush();
    assert(ch.sent.length === 1, 'a message inside the cooldown does NOT repost immediately');
    assert(pendingTimerCount() === 1, 'it queues exactly one trailing repost');

    await advance(REPOST_COOLDOWN_MS - 1);
    assert(ch.sent.length === 1, `still not reposted at ${REPOST_COOLDOWN_MS - 1}ms — the debounce is not "about" 10s`);

    await advance(1);
    assert(ch.sent.length === 2, `reposted exactly at ${REPOST_COOLDOWN_MS}ms`);
    assert(ch.deletedIds.includes(firstId), 'and the previous sticky was deleted (post-first, then delete)');
    assert(ch.lastMessageId === ch.sent[1].id, 'the sticky is the newest message again');

    // A burst must collapse into ONE repost, not fifty.
    const before = ch.sent.length;
    for (let i = 0; i < 50; i++) {
      engine.onMessage(humanMessage(ch));
      await advance(100);           // 50 messages across 5 seconds
    }
    assert(ch.sent.length === before, '50 messages inside one window produce NO repost yet…');
    await advance(REPOST_COOLDOWN_MS);
    assert(ch.sent.length === before + 1, '…and then exactly ONE repost — a burst collapses, it does not queue 50');
  }

  // =========================================================================
  section('C. per-channel state — a flooded channel cannot stall a quiet one');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const busy = client.addChannel('C_BUSY');
    const quiet = client.addChannel('C_QUIET');

    await runSet(client, busy, { content: 'busy sticky' });
    await advance(5000);
    await runSet(client, quiet, { content: 'quiet sticky' });
    // Deliberately staggered installs, so the two debounce windows close at
    // DIFFERENT times. Shared state would collapse them onto one schedule.

    const busyBase = busy.sent.length;
    const quietBase = quiet.sent.length;

    // Flood the busy channel continuously; the quiet channel gets ONE message.
    engine.onMessage(humanMessage(quiet));          // t = 5,000 -> due at 15,000
    for (let i = 0; i < 40; i++) {
      engine.onMessage(humanMessage(busy));         // busy installed at t=0
      await advance(100);
    }
    // t = 9,000. Busy's window (from its install at 0) closes at 10,000.
    assert(busy.sent.length === busyBase, 'busy channel: nothing reposted yet at t=9,000');
    assert(quiet.sent.length === quietBase, 'quiet channel: nothing reposted yet at t=9,000');
    assert(pendingTimerCount() === 2, 'two independent timers are pending — one per channel');

    await advance(1000);   // t = 10,000
    assert(busy.sent.length === busyBase + 1, 'busy channel reposts on ITS window (t=10,000)');
    assert(quiet.sent.length === quietBase, 'quiet channel has NOT reposted yet — its window is its own');

    // Keep flooding the busy channel while the quiet one waits its turn.
    for (let i = 0; i < 40; i++) {
      engine.onMessage(humanMessage(busy));
      await advance(100);
    }
    // t = 14,000
    assert(quiet.sent.length === quietBase, 'quiet channel still waiting at t=14,000, undisturbed by 80 messages next door');
    await advance(1000);   // t = 15,000
    assert(quiet.sent.length === quietBase + 1, 'quiet channel reposts exactly on its own 10s window (t=15,000) — NOT starved');

    const bEntry = engine._watched.get('C_BUSY');
    const qEntry = engine._watched.get('C_QUIET');
    assert(bEntry !== qEntry && bEntry.lastRepostAt !== qEntry.lastRepostAt,
      'the two channels hold separate debounce state (different lastRepostAt)');
  }

  // =========================================================================
  section('D. skip when already newest');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_D');
    await runSet(client, ch, { content: 'newest' });

    const before = ch.sent.length;
    const entry = engine._watched.get('C_D');
    assert(ch.lastMessageId === entry.stickyMessageId, 'right after posting, the sticky IS the newest message');

    // Push past the cooldown so the debounce would fire IMMEDIATELY, then ask
    // for a repost. The only thing that can stop it is the newest-check.
    await advance(REPOST_COOLDOWN_MS + 1);
    engine.scheduleRepost(ch);
    await flush();
    assert(ch.sent.length === before, 'no repost when the sticky is already newest, even with the cooldown fully elapsed');

    await engine.repost(ch);
    await flush();
    assert(ch.sent.length === before, 'and repost() called directly is a no-op in the same state');

    // Now let a human speak: it is no longer newest, so it must repost.
    engine.onMessage(humanMessage(ch));
    await advance(REPOST_COOLDOWN_MS);
    assert(ch.sent.length === before + 1, 'one human message later, it reposts');
  }

  // =========================================================================
  section('E. no self-trigger loop — through the REAL events/messageCreate.js');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_E');
    await runSet(client, ch, { content: 'no loop' });

    // 1. The module guard.
    const before = ch.sent.length;
    engine.onMessage(botMessage(ch));
    await advance(REPOST_COOLDOWN_MS * 3);
    assert(ch.sent.length === before, 'engine.onMessage IGNORES a bot-authored message');
    assert(pendingTimerCount() === 0, 'and schedules nothing at all');

    // 2. The wiring. This is the real event handler the gateway calls.
    const messageCreate = require('../events/messageCreate');
    await messageCreate.execute(botMessage(ch));
    await advance(REPOST_COOLDOWN_MS * 3);
    assert(ch.sent.length === before, "events/messageCreate.js's own bot guard stops it before any hook runs");

    // 3. The wiring works for a HUMAN — otherwise 2 proves nothing.
    await messageCreate.execute(humanMessage(ch, { content: 'a real person talking' }));
    await advance(REPOST_COOLDOWN_MS);
    assert(ch.sent.length === before + 1, 'the same real handler DOES repost for a human message — the hook is genuinely wired in');

    // 4. The belt-and-braces case: even if a bot message somehow reached
    //    scheduleRepost, the sticky is the newest message, so nothing happens.
    const after = ch.sent.length;
    await advance(REPOST_COOLDOWN_MS + 1);
    engine.scheduleRepost(ch);
    await flush();
    assert(ch.sent.length === after, 'and the newest-check is a second, independent stop on the loop');

    // 5. Sustained: 200 alternating bot messages must never compound.
    for (let i = 0; i < 200; i++) {
      engine.onMessage(botMessage(ch));
      await advance(50);
    }
    assert(ch.sent.length === after, '200 bot messages over 10 seconds produce ZERO reposts');
  }

  // =========================================================================
  section('F. THE LENGTH TRAP (spec §4.1) — nothing is ever truncated');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();

    // --- the boundary, exactly -------------------------------------------
    const at2000 = 'x'.repeat(PLAIN_CONTENT_MAX);
    const at2001 = 'x'.repeat(PLAIN_CONTENT_MAX + 1);
    assert(engine.formatFor({ content: at2000, title: null }).mode === 'plain',
      `exactly ${PLAIN_CONTENT_MAX} chars with no title stays PLAIN TEXT`);
    const f2001 = engine.formatFor({ content: at2001, title: null });
    assert(f2001.mode === 'embed' && f2001.promoted === true,
      `${PLAIN_CONTENT_MAX + 1} chars with no title is PROMOTED to a titleless embed`);
    assert(engine.formatFor({ content: 'short', title: 'A title' }).mode === 'embed',
      'any content WITH a title is an embed');
    assert(engine.formatFor({ content: 'short', title: '   ' }).mode === 'plain',
      'a whitespace-only title is not a title');

    // --- end to end through the real modal submit -------------------------
    const ch = client.addChannel('C_LONG');
    // Deliberately unique characters, so a truncation anywhere is detectable
    // by comparison rather than by length alone.
    const long = Array.from({ length: 3500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    assert(long.length === 3500, 'test fixture is 3,500 chars — unpostable as plain text, legal in an embed');

    const { submitted } = await runSet(client, ch, { content: long });
    const posted = ch.sent[ch.sent.length - 1].payload;

    assert(!posted.content, 'the over-length sticky was NOT posted as plain content');
    assert(Array.isArray(posted.embeds) && posted.embeds.length === 1, 'it was posted as an embed');
    const data = posted.embeds[0] instanceof EmbedBuilder ? posted.embeds[0].data : posted.embeds[0];
    assert(data.title === undefined, 'and the embed is TITLELESS — no title was invented');
    assert(data.description.length === 3500, `the embed description is the full 3,500 chars (got ${data.description.length})`);
    assert(data.description === long, 'and is CHARACTER-FOR-CHARACTER what the officer typed — nothing truncated');
    assert(data.color === DEFAULT_COLOR, 'a titleless promotion uses the house blurple');

    const stored = stickyCol._docs.get('C_LONG');
    assert(stored.content === long, 'the STORED document is also the full untruncated text');
    assert(stored.title === null, 'stored with no title');

    const confirm = submitted.last.content;
    assert(/2,000/.test(confirm), 'the confirmation explains the 2,000-character limit');
    assert(/3,500 characters/.test(confirm), 'and states how long their message actually was');
    assert(/Nothing was cut/i.test(confirm), 'and says explicitly that nothing was cut');

    // --- the maximum the modal can even produce ---------------------------
    const ch2 = client.addChannel('C_MAX');
    const max = 'y'.repeat(MODAL_CONTENT_MAX);
    await runSet(client, ch2, { content: max });
    const maxData = ch2.sent[0].payload.embeds[0].data;
    assert(maxData.description.length === MODAL_CONTENT_MAX,
      `the absolute worst case — ${MODAL_CONTENT_MAX} chars, the modal's own cap — survives intact`);
    assert(maxData.description === max, 'and is byte-identical');

    // --- plain stays plain -------------------------------------------------
    const ch3 = client.addChannel('C_PLAIN');
    const md = '**Bold**, `code`, and a [link](https://example.com)';
    const r3 = await runSet(client, ch3, { content: md });
    assert(ch3.sent[0].payload.content === md, 'short, titleless content is posted as plain text, markdown untouched');
    assert(!ch3.sent[0].payload.embeds, 'with no embed at all');
    assert(/plain text/.test(r3.submitted.last.content), 'and the confirmation says so');

    // --- titled becomes an embed ------------------------------------------
    const ch4 = client.addChannel('C_TITLED');
    const r4 = await runSet(client, ch4, { content: 'Body text', title: 'Channel Rules', color: '#FF00AA' });
    const d4 = ch4.sent[0].payload.embeds[0].data;
    assert(d4.title === 'Channel Rules', 'a title makes it an embed with that title');
    assert(d4.description === 'Body text', 'body goes in the description');
    assert(d4.color === 0xFF00AA, 'and the supplied colour is used');
    assert(/embed/.test(r4.submitted.last.content), 'the confirmation says it was posted as an embed');
  }

  // =========================================================================
  section('G. colour parsing — invalid hex falls back, never errors');
  // =========================================================================
  {
    assert(engine.parseColorInput('#5865F2').color === 0x5865F2, '#RRGGBB parses');
    assert(engine.parseColorInput('5865f2').color === 0x5865F2, 'bare RRGGBB parses, case-insensitively');
    assert(engine.parseColorInput('0x5865F2').color === 0x5865F2, '0xRRGGBB parses');
    assert(engine.parseColorInput('#58f').color === 0x5588FF, 'the 3-digit shorthand expands (#58f -> 5588FF)');
    assert(engine.parseColorInput('  #5865F2  ').color === 0x5865F2, 'surrounding whitespace is tolerated');

    for (const bad of ['nope', '#12345', 'rgb(1,2,3)', '#GGGGGG', '#0x123', '12345678', '#']) {
      const r = engine.parseColorInput(bad);
      assert(r.invalid === true && r.color === null && r.supplied === true,
        `"${bad}" is flagged invalid and yields no colour — it does not throw`);
    }
    const blank = engine.parseColorInput('');
    assert(blank.invalid === false && blank.supplied === false, 'a blank colour field is not an error');

    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_BADHEX');
    const r = await runSet(client, ch, { content: 'Body', title: 'Titled', color: 'chartreuse' });
    const d = ch.sent[0].payload.embeds[0].data;
    assert(d.color === DEFAULT_COLOR, 'end to end: an unreadable colour falls back to the default blurple');
    assert(d.title === 'Titled' && d.description === 'Body', 'and the sticky is posted normally otherwise');
    assert(/chartreuse/.test(r.submitted.last.content), "the confirmation quotes what they typed…");
    assert(/default blurple/i.test(r.submitted.last.content), '…and says the default was used instead');

    // A colour with no title: per spec §4 the colour is ignored (no embed to
    // put it on). The officer is TOLD rather than left guessing.
    const ch2 = client.addChannel('C_COLORNOTITLE');
    const r2 = await runSet(client, ch2, { content: 'Just text', color: '#FF0000' });
    assert(ch2.sent[0].payload.content === 'Just text', 'colour without a title still posts as plain text');
    assert(/colour was ignored/i.test(r2.submitted.last.content), 'and the confirmation says the colour was ignored');
  }

  // =========================================================================
  section('H. sticky-on-sticky — refused, and it names the owner (spec §5)');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();

    // --- a free channel is free ------------------------------------------
    client.addChannel('C_FREE');
    assert(await handlers.conflictOwnerFor('C_FREE') === null, 'an ordinary channel reports no conflict');

    // --- 1. an open ticket channel, via ticket/sticky.js's watch set -------
    const tick1 = client.addChannel('C_TICKET');
    ticketSticky._watched.set('C_TICKET', { ticketId: 'ticket:0001', stickyMessageId: null, lastRepostAt: 0, reposting: false, timer: null });
    assert(await handlers.conflictOwnerFor('C_TICKET') === 'a Guild Support ticket',
      "an open ticket channel is detected from ticket/sticky.js's watch Map");

    const cmd = slash(client, tick1, 'set');
    await stickyCommand.execute(cmd);
    assert(cmd.modals.length === 0, 'and /stickymessage set REFUSES — no modal is even shown');
    assert(/Guild Support ticket/.test(cmd.lastReply), 'the refusal NAMES the feature that owns the channel');
    assert(/fight each other/.test(cmd.lastReply), 'and explains why (they would fight each other forever)');
    assert(/on purpose/.test(cmd.lastReply), 'and frames it as deliberate, not a bug');
    assert(stickyCol._docs.size === 0, 'nothing was written to the store');
    ticketSticky._watched.delete('C_TICKET');
    assert(await handlers.conflictOwnerFor('C_TICKET') === null, 'once the ticket is resolved, the channel frees up');

    // --- 2. the same ticket, via the tickets COLLECTION -------------------
    // The watch Map is empty (as it would be after a failed resume); the store
    // is the second, independent signal.
    const origIsReady = ticketDb.isReady;
    const origGetByChannel = ticketDb.getTicketByChannel;
    ticketDb.isReady = () => true;
    ticketDb.getTicketByChannel = async (id) => (id === 'C_TICKET' ? { _id: 'ticket:0001', status: 'accepted' } : null);
    assert(await handlers.conflictOwnerFor('C_TICKET') === 'a Guild Support ticket',
      'with an EMPTY watch Map, the tickets collection still catches it (status accepted)');
    ticketDb.getTicketByChannel = async () => ({ _id: 'ticket:0001', status: 'resolved' });
    assert(await handlers.conflictOwnerFor('C_TICKET') === null,
      'a RESOLVED ticket does not block the channel — only a live one does');
    ticketDb.isReady = origIsReady;
    ticketDb.getTicketByChannel = origGetByChannel;

    // --- 3. the activity-campaign channel ---------------------------------
    const camp = client.addChannel('C_CAMPAIGN');
    const origCampReady = campaignDb.isReady;
    const origCampCfg = campaignDb.getConfig;
    campaignDb.isReady = () => true;
    campaignDb.getConfig = async () => ({ active: true, channelId: 'C_CAMPAIGN' });
    assert(await handlers.conflictOwnerFor('C_CAMPAIGN') === 'the Activity Campaign',
      'the active activity-campaign channel is detected from its config document');

    const cmd2 = slash(client, camp, 'set');
    await stickyCommand.execute(cmd2);
    assert(cmd2.modals.length === 0, '/stickymessage set REFUSES there too');
    assert(/Activity Campaign/.test(cmd2.lastReply), 'naming the Activity Campaign as the owner');

    campaignDb.getConfig = async () => ({ active: false, channelId: 'C_CAMPAIGN' });
    assert(await handlers.conflictOwnerFor('C_CAMPAIGN') === null,
      'a STOPPED campaign releases the channel');
    campaignDb.isReady = origCampReady;
    campaignDb.getConfig = origCampCfg;

    // --- 4. the GvG event-reminder channel (NOT in the spec — see report) --
    assert(await handlers.conflictOwnerFor(REMINDER_CHANNEL_ID) === 'the Guild Event reminder',
      'the GvG event-reminder channel is refused too — a THIRD sticky engine the spec did not list');

    // --- 5. the refusal survives a race: modal opened, ticket created,
    //        modal submitted. Re-checked on submit, not only on open.
    const late = client.addChannel('C_LATE');
    const openCmd = slash(client, late, 'set');
    await stickyCommand.execute(openCmd);
    assert(openCmd.modals.length === 1, 'the modal opens while the channel is still free');
    ticketSticky._watched.set('C_LATE', { ticketId: 'ticket:0002' });
    const submitted = modalSubmit(client, { channelId: 'C_LATE', content: 'too late' });
    await handlers.route(submitted);
    await flush();
    assert(/Guild Support ticket/.test(submitted.last.content),
      'a channel that BECAME a ticket channel while the modal was open is caught on submit');
    assert(late.sent.length === 0, 'and nothing was posted into it');
    assert(!stickyCol._docs.has('C_LATE'), 'and nothing was stored');
    ticketSticky._watched.delete('C_LATE');
  }

  // =========================================================================
  section('I. set / edit / remove / list');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_CRUD');

    // --- set --------------------------------------------------------------
    const r1 = await runSet(client, ch, { content: 'First version' });
    assert(stickyCol._docs.size === 1, 'set writes exactly one document');
    assert(stickyCol._docs.get('C_CRUD')._id === 'C_CRUD', 'keyed by the CHANNEL ID — one sticky per channel, enforced by the key');
    assert(/Sticky message set/.test(r1.submitted.last.content), 'the confirmation says it was set');
    const firstMsgId = ch.sent[0].id;
    assert(stickyCol._docs.get('C_CRUD').messageId === firstMsgId, 'the live message id is persisted');
    assert(stickyCol._docs.get('C_CRUD').setByName === 'Officer Ren', 'and who set it');
    const createdAt = stickyCol._docs.get('C_CRUD').createdAt;

    // --- set again REPLACES ------------------------------------------------
    const r2 = await runSet(client, ch, { content: 'Second version' });
    assert(stickyCol._docs.size === 1, 'a second set REPLACES rather than adding — still one document');
    assert(stickyCol._docs.get('C_CRUD').content === 'Second version', 'with the new content');
    assert(/replaced/i.test(r2.submitted.last.content), 'and the confirmation says REPLACED (spec §3)');
    assert(ch.deletedIds.includes(firstMsgId), 'the previous sticky message was taken down');
    assert(stickyCol._docs.get('C_CRUD').createdAt.getTime() === createdAt.getTime(),
      'createdAt survives the replace ($setOnInsert is a no-op on an existing doc)');

    // --- edit prefills ------------------------------------------------------
    const editCmd = slash(client, ch, 'edit');
    await stickyCommand.execute(editCmd);
    assert(editCmd.modals.length === 1, 'edit opens a modal');
    const json = editCmd.modals[0].toJSON();
    const values = json.components.map(row => row.components[0].value);
    assert(values[0] === 'Second version', 'PRE-FILLED with the current content (spec §3)');
    assert(json.custom_id === `${IDS.MODAL}:${MODES.EDIT}:C_CRUD`, 'and carries the edit mode + channel id in the customId');

    const editSub = modalSubmit(client, { mode: MODES.EDIT, channelId: 'C_CRUD', content: 'Third version', title: 'Now titled', color: '#00FF00' });
    await handlers.route(editSub);
    await flush();
    assert(/updated/i.test(editSub.last.content), 'an edit says UPDATED, not replaced');
    assert(stickyCol._docs.get('C_CRUD').content === 'Third version', 'the document is updated');
    const lastPayload = ch.sent[ch.sent.length - 1].payload;
    assert(lastPayload.embeds?.[0]?.data?.title === 'Now titled', 'adding a title on edit switches it to an embed');
    assert(lastPayload.embeds[0].data.color === 0x00FF00, 'with the new colour');

    // Edit re-prefills the colour in the SAME hex format it accepts.
    const editCmd2 = slash(client, ch, 'edit');
    await stickyCommand.execute(editCmd2);
    const vals2 = editCmd2.modals[0].toJSON().components.map(r => r.components[0].value);
    assert(vals2[1] === 'Now titled', 'the title is prefilled on the next edit');
    assert(vals2[2] === '#00FF00', 'and the colour is prefilled as readable hex');
    assert(engine.parseColorInput(vals2[2]).color === 0x00FF00, 'which round-trips through the parser unchanged');

    // --- edit with nothing there -------------------------------------------
    const empty = client.addChannel('C_EMPTY');
    const editNone = slash(client, empty, 'edit');
    await stickyCommand.execute(editNone);
    assert(editNone.modals.length === 0, 'edit in a channel with no sticky shows no modal');
    assert(/no sticky message/i.test(editNone.lastReply), 'and says so');

    // --- list ---------------------------------------------------------------
    const ch2 = client.addChannel('C_CRUD2');
    await runSet(client, ch2, { content: 'A'.repeat(400) });
    const listCmd = slash(client, ch, 'list');
    await stickyCommand.execute(listCmd);
    const listText = listCmd.lastReply;
    assert(/Active sticky messages — 2/.test(listText), 'list counts every sticky in the server');
    assert(listText.includes('<#C_CRUD>') && listText.includes('<#C_CRUD2>'), 'and names both channels');
    assert(/Officer Ren/.test(listText), 'and who set them (spec §3)');
    assert(listText.length <= 2000, `the listing stays under Discord's 2,000-char cap (${listText.length})`);
    assert(!listText.includes('A'.repeat(200)), 'a long sticky is PREVIEWED, not dumped in full');
    assert(stickyCol._docs.get('C_CRUD2').content.length === 400, 'and the stored content is still full length — only the LISTING is shortened');

    // --- remove -------------------------------------------------------------
    const liveId = stickyCol._docs.get('C_CRUD').messageId;
    const rmCmd = slash(client, ch, 'remove');
    await stickyCommand.execute(rmCmd);
    assert(ch.deletedIds.includes(liveId), 'remove deletes the live sticky message');
    assert(!stickyCol._docs.has('C_CRUD'), 'and the record');
    assert(!engine._watched.has('C_CRUD'), 'and stops watching the channel');
    assert(/removed/i.test(rmCmd.lastReply), 'and confirms');

    // Messages in a removed channel do nothing at all.
    const sentBefore = ch.sent.length;
    engine.onMessage(humanMessage(ch));
    await advance(REPOST_COOLDOWN_MS * 2);
    assert(ch.sent.length === sentBefore, 'after remove, messages in that channel trigger nothing');

    const rmAgain = slash(client, ch, 'remove');
    await stickyCommand.execute(rmAgain);
    assert(/no sticky message/i.test(rmAgain.lastReply), 'removing twice is a friendly no-op, not an error');
  }

  // =========================================================================
  section('J. the gate — Godfathers + officers only');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_GATE');

    const denied = slash(client, ch, 'set', { roles: ['9999999999'] });
    await stickyCommand.execute(denied);
    assert(denied.modals.length === 0, 'a non-officer gets no modal');
    assert(/Godfathers and officers/.test(denied.lastReply), 'and is told why');

    for (const subName of ['edit', 'remove', 'list']) {
      const d = slash(client, ch, subName, { roles: [] });
      await stickyCommand.execute(d);
      assert(/Godfathers and officers/.test(d.lastReply), `/stickymessage ${subName} is gated too`);
    }

    // Every role on the combined list works.
    for (const roleId of STICKY_ROLE_IDS) {
      const ok = slash(client, ch, 'set', { roles: [roleId] });
      await stickyCommand.execute(ok);
      assert(ok.modals.length === 1, `role ${roleId} passes the gate`);
    }
    assert(STICKY_ROLE_IDS.includes(GODFATHERS_ROLE_ID), 'and Godfathers are on it');

    // The modal submit re-checks — a role can be lost while a modal is open.
    const sneaky = modalSubmit(client, { channelId: 'C_GATE', content: 'nope', roles: ['9999999999'] });
    const claimed = await handlers.route(sneaky);
    await flush();
    assert(claimed === true, 'the router still CLAIMS the interaction (it is a sticky: id)…');
    assert(/Godfathers and officers/.test(sneaky.last.content), '…but the submit is refused — the gate is re-checked, not trusted');
    assert(ch.sent.length === 0, 'and nothing was posted');
  }

  // =========================================================================
  section('K. restart — the Map is a cache, Mongo is the truth (spec §7)');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const c1 = client.addChannel('C_R1');
    const c2 = client.addChannel('C_R2');

    await runSet(client, c1, { content: 'Plain one' });
    await runSet(client, c2, { content: 'Titled two', title: 'Two', color: '#123456' });

    const id1 = stickyCol._docs.get('C_R1').messageId;
    const id2 = stickyCol._docs.get('C_R2').messageId;
    const sent1 = c1.sent.length;
    const sent2 = c2.sent.length;

    // --- the process dies -------------------------------------------------
    engine._resetForTests();
    timers = [];
    assert(engine.watchedCount() === 0, 'process death empties the watch Map…');
    engine.onMessage(humanMessage(c1));
    await advance(REPOST_COOLDOWN_MS * 2);
    assert(c1.sent.length === sent1, '…and with an empty Map, messages do nothing (the sticky is dead until resume)');

    // --- boot -------------------------------------------------------------
    const restored = await resume(client);
    assert(restored === 2, 'resume rebuilds the watch Map from the collection (2 channels)');
    assert(engine.watchedCount() === 2, 'both channels are watched again');

    const e1 = engine._watched.get('C_R1');
    const e2 = engine._watched.get('C_R2');
    assert(e1.stickyMessageId === id1, 're-attached to C_R1 by its PERSISTED messageId');
    assert(e2.stickyMessageId === id2, 're-attached to C_R2 by its PERSISTED messageId');
    assert(e1.content === 'Plain one', 'content came back');
    assert(e2.title === 'Two' && e2.color === 0x123456, 'title and colour came back');
    assert(c1.sent.length === sent1 && c2.sent.length === sent2,
      'and resume posted NOTHING — it re-attaches, it does not republish every sticky on every deploy');

    // --- and it works again ------------------------------------------------
    engine.onMessage(humanMessage(c1));
    await advance(REPOST_COOLDOWN_MS);
    assert(c1.sent.length === sent1 + 1, 'the very next human message reposts (lastRepostAt starts at 0 — no debounce penalty for the restart)');
    assert(c1.deletedIds.includes(id1), 'and it deleted the pre-restart sticky by its persisted id — proof the re-attach was to the right message');
    assert(stickyCol._docs.get('C_R1').messageId === c1.sent[sent1].id, 'the new message id is persisted');

    // --- a channel deleted while the bot was down --------------------------
    const gone = client.addChannel('C_GONE');
    await runSet(client, gone, { content: 'doomed' });
    assert(stickyCol._docs.has('C_GONE'), 'a third sticky exists');
    engine._resetForTests();
    client.removeChannel('C_GONE');           // deleted during downtime
    const restored2 = await resume(client);
    assert(restored2 === 2, 'resume restores only the channels that still exist');
    assert(!stickyCol._docs.has('C_GONE'), 'and CLEANS UP the record for the deleted channel rather than retrying forever (spec §6)');
    assert(!engine._watched.has('C_GONE'), 'and does not watch it');
  }

  // =========================================================================
  section('L. failure postures');
  // =========================================================================
  {
    // --- database unreachable ---------------------------------------------
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_DBDOWN');
    await runSet(client, ch, { content: 'sticky' });
    const before = ch.sent.length;

    db._setCollectionsForTests(null);          // Atlas goes away
    assert(db.isReady() === false, 'the store reports itself unavailable');
    engine.onMessage(humanMessage(ch));
    await advance(REPOST_COOLDOWN_MS * 2);
    assert(ch.sent.length === before, 'onMessage SKIPS reposting entirely while the DB is down (spec §6) — no crash, no spam');

    const cmd = slash(client, ch, 'set');
    await stickyCommand.execute(cmd);
    assert(cmd.modals.length === 0 && /unavailable/i.test(cmd.lastReply), 'and the command says "unavailable" instead of erroring');

    db._setCollectionsForTests(stickyCol);     // Atlas comes back
    engine.onMessage(humanMessage(ch));
    await advance(REPOST_COOLDOWN_MS);
    assert(ch.sent.length === before + 1, 'when the DB comes back, stickies start following again on their own');

    // --- the channel was deleted under us ----------------------------------
    resetStore();
    const client2 = makeClient();
    const doomed = client2.addChannel('C_DELETED');
    await runSet(client2, doomed, { content: 'about to vanish' });
    assert(stickyCol._docs.has('C_DELETED'), 'record exists');

    const unknown = new Error('Unknown Channel');
    unknown.code = ERR_UNKNOWN_CHANNEL;
    doomed.failNextSend = unknown;
    engine.onMessage(humanMessage(doomed));
    await advance(REPOST_COOLDOWN_MS);
    assert(!engine._watched.has('C_DELETED'), 'an Unknown Channel error retires the watch');
    assert(!stickyCol._docs.has('C_DELETED'), 'and cleans up the record (spec §6)');

    // --- a TRANSIENT send failure must NOT throw the sticky away -----------
    resetStore();
    const client3 = makeClient();
    const flaky = client3.addChannel('C_FLAKY');
    await runSet(client3, flaky, { content: 'keep me' });
    const keptId = stickyCol._docs.get('C_FLAKY').messageId;

    flaky.failNextSend = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    engine.onMessage(humanMessage(flaky));
    await advance(REPOST_COOLDOWN_MS);
    assert(engine._watched.has('C_FLAKY'), 'a permissions error does NOT retire the watch');
    assert(stickyCol._docs.has('C_FLAKY'), 'and does NOT delete the officer\'s sticky');
    assert(stickyCol._docs.get('C_FLAKY').messageId === keptId, 'the persisted message id is untouched');

    const sentBefore = flaky.sent.length;
    engine.onMessage(humanMessage(flaky));
    await advance(REPOST_COOLDOWN_MS * 2);
    assert(flaky.sent.length === sentBefore + 1, 'and it retries on the next message — transient means transient');

    // --- the sticky was deleted BY HAND ------------------------------------
    resetStore();
    const client4 = makeClient();
    const hand = client4.addChannel('C_HAND');
    await runSet(client4, hand, { content: 'delete me by hand' });
    const oldId = stickyCol._docs.get('C_HAND').messageId;
    hand.live.delete(oldId);                   // a moderator removes it manually
    const sentBefore4 = hand.sent.length;

    engine.onMessage(humanMessage(hand));
    await advance(REPOST_COOLDOWN_MS);
    assert(hand.sent.length === sentBefore4 + 1, 'a hand-deleted sticky is reposted on the next human message (spec §6)');
    const newId = hand.sent[hand.sent.length - 1].id;
    assert(stickyCol._docs.get('C_HAND').messageId === newId, 'and the NEW message id is persisted');
    assert(newId !== oldId, 'which is a different id from the one that was deleted');

    // --- a send failure during `set` must not leave a phantom record -------
    resetStore();
    const client5 = makeClient();
    const nogo = client5.addChannel('C_NOGO');
    nogo.failNextSend = Object.assign(new Error('Missing Access'), { code: 50001 });
    const r = await runSet(client5, nogo, { content: 'never posted' });
    assert(!stickyCol._docs.has('C_NOGO'), 'if the first post fails, the record is rolled back — the store never claims a sticky that is not there');
    assert(!engine._watched.has('C_NOGO'), 'and the channel is not watched');
    assert(/couldn't post/i.test(r.submitted.last.content), 'and the officer is told');
    assert(/Nothing was saved/i.test(r.submitted.last.content), 'explicitly, that nothing was saved');
  }

  // =========================================================================
  section('M. out of scope — threads, forums, DMs (spec §10)');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();

    const thread = client.addChannel('C_THREAD', { type: ChannelType.PublicThread });
    const cmd = slash(client, thread, 'set');
    await stickyCommand.execute(cmd);
    assert(cmd.modals.length === 0, 'set is refused in a thread');
    assert(/text channels/i.test(cmd.lastReply), 'with an explanation');

    const forum = client.addChannel('C_FORUM', { type: ChannelType.GuildForum });
    const cmd2 = slash(client, forum, 'set');
    await stickyCommand.execute(cmd2);
    assert(cmd2.modals.length === 0, 'and in a forum channel');

    const announce = client.addChannel('C_NEWS', { type: ChannelType.GuildAnnouncement });
    const cmd3 = slash(client, announce, 'set');
    await stickyCommand.execute(cmd3);
    assert(cmd3.modals.length === 1, 'but an announcement channel is allowed');
  }

  // =========================================================================
  section('N. mentions in a sticky are shown but never ping');
  // =========================================================================
  {
    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_PING');
    const text = 'Reminder for @everyone and <@&123456789012345678>!';
    const r = await runSet(client, ch, { content: text });

    const payload = ch.sent[0].payload;
    assert(payload.content === text, 'the officer\'s text is posted VERBATIM — the mention is not mangled');
    assert(payload.allowedMentions && Array.isArray(payload.allowedMentions.parse) && payload.allowedMentions.parse.length === 0,
      'but allowedMentions is empty, so a sticky reposting every 10s cannot re-ping the server');
    assert(/never ping/i.test(r.submitted.last.content), 'and the confirmation tells the officer that');

    const ch2 = client.addChannel('C_PING2');
    await runSet(client, ch2, { content: 'x'.repeat(2500), title: '' });
    assert(ch2.sent[0].payload.allowedMentions.parse.length === 0, 'the embed path suppresses mentions too');
  }

  // =========================================================================
  section('O. router isolation — both directions (the carry-build check)');
  // =========================================================================
  {
    const guildapp = require('../guildapp/handlers');
    const officerapp = require('../officerapp/handlers');
    const partyfinder = require('../partyfinder/handlers');
    const carry = require('../carry/handlers');
    const quiz = require('../quiz/handlers');
    const activitycampaign = require('../activitycampaign/handlers');
    const gvgReminder = require('../gvg/reminder');
    const monsterquiz = require('../monsterquiz/engine');
    const ticket = require('../ticket/handlers');
    const petition = require('../petition/handlers');

    const btn = (customId) => ({
      customId,
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
      async reply() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async update() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async showModal() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async deferUpdate() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
      async deferReply() { throw new Error(`route() ACTED on a foreign customId: ${customId}`); },
    });
    const sel = (customId) => ({ ...btn(customId), isButton: () => false, isStringSelectMenu: () => true, values: ['x'] });
    const mod = (customId) => ({ ...btn(customId), isButton: () => false, isModalSubmit: () => true });

    // --- direction 1: sticky must claim nobody else's ids ------------------
    const foreign = [
      'ticket:open', 'ticket:modal', 'ticket:accept:ticket:0001', 'ticket:resolve:ticket:0001',
      'carry:pick', 'carry:tier', 'carry:pay:carryrun:0001:0', 'carry:paid:carrybooking:000001',
      'partyfinder:start', 'pf:join:DPS:3', 'pf:details', 'guildapp:start', 'guildapp:modal',
      'quiz:answer:A', 'petition:sign', 'petition:modal', 'monsterquiz:join', 'monsterquiz:category',
      'activitycampaign:yes', 'activitycampaign:startmodal:123', 'gvgrsvp:yes:k',
      'jobad:modal', 'jobapply:1', 'officerapp:modal:1', 'officerreview:daddy:1:2',
      // near-misses: the same prefix without the separator must NOT be claimed
      'stickymessage:set', 'sticky', 'stickynote:1',
    ];
    let overclaimed = [];
    for (const id of foreign) {
      for (const mk of [btn, sel, mod]) {
        if (await handlers.route(mk(id))) overclaimed.push(id);
      }
    }
    assert(overclaimed.length === 0,
      `sticky.route() claims NONE of the ${foreign.length} foreign customIds${overclaimed.length ? ` — over-claimed ${[...new Set(overclaimed)].join(', ')}` : ''}`);

    // A malformed sticky: id is disowned rather than crashing the chain.
    assert(await handlers.route(mod('sticky:modal')) === false, 'a truncated sticky:modal id is not claimed');
    assert(await handlers.route(mod('sticky:modal:bogus:123')) === false, 'an unknown mode is not claimed');
    assert(await handlers.route(mod('sticky:something:else')) === false, 'an unknown sticky: id is not claimed');
    assert(await handlers.route(btn(`${IDS.MODAL}:${MODES.SET}:123`)) === false,
      'and a sticky modal id arriving as a BUTTON is not claimed — this feature owns no buttons');

    // --- direction 2: nobody else may claim a sticky: id -------------------
    const mine = [
      `${IDS.MODAL}:${MODES.SET}:123456789012345678`,
      `${IDS.MODAL}:${MODES.EDIT}:123456789012345678`,
    ];
    const others = [
      ['guildapp', guildapp], ['officerapp', officerapp], ['partyfinder', partyfinder],
      ['carry', carry], ['quiz', quiz], ['activitycampaign', activitycampaign],
      ['gvgReminder', gvgReminder], ['monsterquiz', monsterquiz], ['ticket', ticket],
      ['petition', petition],
    ];
    let stolen = [];
    for (const id of mine) {
      for (const mk of [btn, sel, mod]) {
        for (const [name, router] of others) {
          if (typeof router.route !== 'function') continue;
          try {
            if (await router.route(mk(id))) stolen.push(`${name} claimed ${id}`);
          } catch (err) {
            stolen.push(`${name} THREW on ${id}: ${err.message}`);
          }
        }
      }
    }
    assert(stolen.length === 0,
      `no other router in the bot claims a sticky: customId${stolen.length ? ` — ${stolen.join('; ')}` : ''}`);
    assert(others.length === 10, `checked against all ${others.length} existing routers, not a sample`);

    // --- and sticky DOES claim its own -------------------------------------
    resetStore();
    const client = makeClient();
    client.addChannel('C_ROUTE');
    const ok = modalSubmit(client, { channelId: 'C_ROUTE', content: 'routed' });
    assert(await handlers.route(ok) === true, 'sticky.route() DOES claim its own modal submit');
    await flush();

    // --- the router order in the real event file ---------------------------
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'events', 'interactionCreate.js'), 'utf8');
    assert(/stickymessage\.route\(interaction\)/.test(src), 'events/interactionCreate.js actually calls sticky route()');
    assert(/require\('\.\.\/sticky\/handlers'\)/.test(src), 'and requires the module');

    const mcSrc = fs.readFileSync(path.join(__dirname, '..', 'events', 'messageCreate.js'), 'utf8');
    assert(/stickyEngine\.onMessage\(message\)/.test(mcSrc), 'events/messageCreate.js actually calls the sticky onMessage hook');
    const guarded = /try \{\s*stickyEngine\.onMessage\(message\);\s*\} catch \(err\) \{/.test(mcSrc);
    assert(guarded, 'and it is wrapped in its OWN try/catch — a sticky failure cannot take down kudos or the quiz');
    assert((mcSrc.match(/\} catch \(err\) \{/g) || []).length >= 5,
      'every additive hook in messageCreate keeps its own guard (5+ catch blocks)');

    const readySrc = fs.readFileSync(path.join(__dirname, '..', 'events', 'ready.js'), 'utf8');
    assert(/stickyDb\.initSchema\(\)/.test(readySrc) && /stickyResume\.resume\(client\)/.test(readySrc),
      'events/ready.js initialises the store and runs resume on boot');
  }

  // =========================================================================
  section('P. command registration — up by EXACTLY one');
  // =========================================================================
  {
    const fs = require('node:fs');
    const { Collection, REST } = require('discord.js');
    const { registerCommands } = require('../lib/registerCommands');

    const commands = new Collection();
    const dir = path.join(__dirname, '..', 'commands');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const cmd = require(path.join(dir, file));
      if ('data' in cmd && 'execute' in cmd) commands.set(cmd.data.name, cmd);
    }

    // Intercept the REST call — nothing leaves the machine.
    let sent = null;
    const origPut = REST.prototype.put;
    REST.prototype.put = async function put(route, opts) { sent = opts.body; return sent; };
    const origEnv = { ...process.env };
    process.env.DISCORD_TOKEN = 'x'; process.env.CLIENT_ID = 'x'; process.env.GUILD_ID = 'x';
    await registerCommands(commands);
    REST.prototype.put = origPut;
    process.env.DISCORD_TOKEN = origEnv.DISCORD_TOKEN ?? '';
    process.env.CLIENT_ID = origEnv.CLIENT_ID ?? '';
    process.env.GUILD_ID = origEnv.GUILD_ID ?? '';

    const names = sent.map(c => c.name).sort();

    // The baseline this build started from: 30 registered commands (31 files,
    // with /partyfinder loaded but retired). Expected now: 31.
    const BASELINE = ['activitycampaign', 'card', 'carrypanel', 'carryrun', 'guildapplication',
      'guildexpedition', 'guildroster', 'guildsupport', 'gvgschedule', 'gvgvc', 'help', 'item',
      'jobad', 'kudosboard', 'map', 'memberclasses', 'monster', 'pet', 'petition', 'ping',
      'polarityraid', 'profile', 'qna', 'refine', 'roquiz', 'rune', 'shop', 'siege', 'skill',
      'syncmembers'];
    assert(BASELINE.length === 30, 'the pre-build baseline was 30 registered commands');

    const lost = BASELINE.filter(n => !names.includes(n));
    assert(lost.length === 0, `every pre-existing command still registers${lost.length ? ` — MISSING ${lost.join(', ')}` : ''}`);
    assert(names.includes('stickymessage'), '/stickymessage is registered');
    assert(names.length === 31, `31 commands registered — exactly one more than 30 (got ${names.length})`);
    assert(commands.has('partyfinder') && !names.includes('partyfinder'),
      '/partyfinder is still LOADED but still NOT registered — the retirement is untouched');

    // The five Nanna named explicitly.
    for (const n of ['carrypanel', 'carryrun', 'siege', 'polarityraid', 'guildroster']) {
      assert(names.includes(n), `/${n} still loads and registers`);
    }

    const sm = commands.get('stickymessage').data.toJSON();
    assert(sm.options.map(o => o.name).sort().join(',') === 'edit,list,remove,set',
      '/stickymessage exposes exactly set / edit / remove / list (spec §3)');
    assert(sm.options.every(o => o.type === 1), 'all four are subcommands');
    assert(new Set(names).size === names.length, 'no duplicate command names');
  }

  // =========================================================================
  section('Q. the modal itself (spec §4)');
  // =========================================================================
  {
    const modal = handlers.buildModal('123456789012345678', MODES.SET, null).toJSON();
    assert(modal.components.length === 3, 'three inputs, at most (spec §4)');

    const [content, title, color] = modal.components.map(r => r.components[0]);
    assert(content.style === 2 && content.required === true, 'Content is a required PARAGRAPH');
    assert(content.max_length === MODAL_CONTENT_MAX, `Content accepts up to ${MODAL_CONTENT_MAX} chars — Discord's modal cap`);
    assert(title.style === 1 && title.required === false, 'Title is an optional SHORT input');
    assert(title.max_length === 256, "Title is capped at Discord's 256-char embed-title limit");
    assert(color.style === 1 && color.required === false, 'Colour is an optional SHORT input');
    assert(/leave blank/i.test(title.label), "the Title label explains that blank means plain text");
    assert(modal.custom_id.length <= 100, `the customId fits Discord's 100-char cap (${modal.custom_id.length})`);
    assert(modal.custom_id === 'sticky:modal:set:123456789012345678', 'and carries the mode + target channel id');

    // A blank optional field must not be sent with value:'' — Discord rejects it.
    assert(title.value === undefined && color.value === undefined,
      'blank optional fields carry no value at all (an empty string would be rejected)');
  }

  // =========================================================================
  section('R. everything an officer sees is EPHEMERAL');
  // =========================================================================
  {
    // A sticky can be 4,000 characters. A confirmation that accidentally went
    // public would dump the whole thing into the channel underneath the sticky
    // itself — so this is checked, not assumed.
    const { MessageFlags } = require('discord.js');
    const EPH = MessageFlags.Ephemeral;

    resetStore();
    const client = makeClient();
    const ch = client.addChannel('C_EPH');

    // set -> modal submit
    const r = await runSet(client, ch, { content: 'y'.repeat(3000) });
    assert(r.submitted.defers.length === 1, 'the modal submit defers its reply');
    assert(r.submitted.defers[0]?.flags === EPH, 'and defers it EPHEMERALLY — a 3,000-char confirmation never goes public');
    assert(ch.sent.length === 1, 'and exactly one thing was posted publicly: the sticky itself');

    // remove
    const rm = slash(client, ch, 'remove');
    await stickyCommand.execute(rm);
    assert(rm.defers[0]?.flags === EPH, '/stickymessage remove is ephemeral');

    // list
    await runSet(client, ch, { content: 'again' });
    const ls = slash(client, ch, 'list');
    await stickyCommand.execute(ls);
    assert(ls.defers[0]?.flags === EPH, '/stickymessage list is ephemeral');
    assert(ls.replies[0].allowedMentions?.parse?.length === 0, 'and the listing cannot ping anyone it quotes');

    // every straight-to-reply refusal path
    const paths = [
      ['non-officer', slash(client, ch, 'set', { roles: [] })],
      ['thread', slash(client, client.addChannel('C_EPH_T', { type: ChannelType.PublicThread }), 'set')],
      ['no sticky to edit', slash(client, client.addChannel('C_EPH_E'), 'edit')],
    ];
    for (const [label, cmd] of paths) {
      await stickyCommand.execute(cmd);
      assert(cmd.replies[cmd.replies.length - 1]?.flags === EPH, `the "${label}" refusal is ephemeral`);
    }

    // the conflict refusal
    ticketSticky._watched.set('C_EPH_C', { ticketId: 'ticket:0009' });
    const conf = slash(client, client.addChannel('C_EPH_C'), 'set');
    await stickyCommand.execute(conf);
    assert(conf.replies[0]?.flags === EPH, 'the sticky-on-sticky refusal is ephemeral');
    ticketSticky._watched.delete('C_EPH_C');
  }

  // -------------------------------------------------------------------------
  restoreClock();
  console.log('\n---- summary ----');
  console.log(`${assertions} assertions`);
  if (failures === 0) console.log('ALL PASS');
  else console.error(`${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { restoreClock(); console.error('SIM CRASHED:', err); process.exit(1); });
