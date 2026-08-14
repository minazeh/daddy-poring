// ---------------------------------------------------------------------------
// Ticket transcript: fetch the full channel history, render it, post it to the
// archive channel.
//
// Plain .txt rather than HTML: greppable, no rendering dependency, and readable
// in Discord's own file preview. The summary embed alongside it carries the
// metadata so the archive is scannable without opening attachments.
//
// ATTACHMENTS ARE RECORDED AS URLS, NOT CAPTURED. Discord CDN links now carry
// expiring signatures, so an archived URL will eventually stop resolving. The
// transcript therefore preserves that a file was sent, its name and its size —
// which survives — rather than pretending the link is durable. Actually
// archiving attachment bytes is separate work and deliberately out of scope.
// ---------------------------------------------------------------------------

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { CHANNELS, COLORS } = require('./constants');

// Discord's default upload ceiling on an unboosted guild is 8 MiB. Truncate
// rather than fail — a partial transcript beats a lost one.
const MAX_TRANSCRIPT_BYTES = 7.5 * 1024 * 1024;

const PAGE_SIZE = 100;   // Discord's per-fetch maximum

function pad(n) {
  return String(n).padStart(2, '0');
}

// YYYY-MM-DD HH:MM:SS UTC — sortable, unambiguous, timezone-explicit.
function formatTimestamp(date) {
  const d = new Date(date);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

// ---------------------------------------------------------------------------
// Fetch the entire channel history, oldest first.
//
// channel.messages.fetch() returns at most 100, so this pages backwards with
// `before` until exhausted. HARD_CAP stops a pathological channel from pulling
// the process into a very long loop; the renderer notes when it bites.
// ---------------------------------------------------------------------------
async function fetchAllMessages(channel, hardCap = 5000) {
  const all = [];
  let before;

  for (;;) {
    const batch = await channel.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) });
    if (batch.size === 0) break;

    // fetch() returns newest-first within the batch.
    const arr = [...batch.values()];
    all.push(...arr);
    before = arr[arr.length - 1].id;

    if (batch.size < PAGE_SIZE) break;
    if (all.length >= hardCap) break;
  }

  // Oldest first for reading.
  all.reverse();
  return { messages: all, truncated: all.length >= hardCap };
}

// One rendered line (plus continuation lines for embeds/attachments).
function renderMessage(msg) {
  const lines = [];
  const author = msg.author
    ? `${msg.author.username} (${msg.author.id})`
    : 'unknown';
  const content = (msg.content || '').replace(/\r?\n/g, '\n    ');

  lines.push(`[${formatTimestamp(msg.createdTimestamp)}] ${author}: ${content}`);

  for (const att of msg.attachments?.values?.() ?? []) {
    const kb = att.size ? ` (${Math.round(att.size / 1024)} KB)` : '';
    lines.push(`    ↳ attachment: ${att.name}${kb} — ${att.url}`);
  }

  // Bot embeds (the header card, the sticky's resolved notice) carry meaning
  // too; record title/description so the transcript isn't full of blank lines.
  for (const emb of msg.embeds ?? []) {
    if (emb.title) lines.push(`    ↳ [embed] ${emb.title}`);
    if (emb.description) lines.push(`    ↳ [embed] ${emb.description.replace(/\r?\n/g, ' ')}`);
    for (const f of emb.fields ?? []) {
      lines.push(`    ↳ [embed] ${f.name}: ${String(f.value).replace(/\r?\n/g, ' ')}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Render the whole transcript body. Truncates from the TOP if oversized, so
// the most recent (and usually most relevant) exchange is what survives.
// ---------------------------------------------------------------------------
function renderTranscript(ticket, messages, truncatedByCap) {
  const num = String(ticket.number).padStart(4, '0');
  const header = [
    '='.repeat(72),
    `TICKET #${num}`,
    '='.repeat(72),
    `Subject      : ${ticket.subject}`,
    `Opened by    : ${ticket.displayName} (${ticket.username}, ${ticket.userId})`,
    `Opened at    : ${formatTimestamp(ticket.createdAt)}`,
    ticket.acceptedAt ? `Accepted at  : ${formatTimestamp(ticket.acceptedAt)}` : null,
    ticket.resolvedAt ? `Resolved at  : ${formatTimestamp(ticket.resolvedAt)}` : null,
    `Messages     : ${messages.length}`,
    '='.repeat(72),
    '',
    'ORIGINAL REQUEST',
    '-'.repeat(72),
    ticket.message,
    '',
    '='.repeat(72),
    'CONVERSATION',
    '='.repeat(72),
    '',
  ].filter(l => l !== null).join('\n');

  const rendered = messages.map(renderMessage);
  let body = rendered.join('\n');

  const notes = [];
  if (truncatedByCap) {
    notes.push('[!] History exceeded the fetch cap — the oldest messages are not included.');
  }

  // Byte-budget check against the header + notes.
  const overhead = Buffer.byteLength(header, 'utf8') + 512;
  if (Buffer.byteLength(body, 'utf8') + overhead > MAX_TRANSCRIPT_BYTES) {
    // Drop from the front until it fits.
    let start = 0;
    while (
      start < rendered.length &&
      Buffer.byteLength(rendered.slice(start).join('\n'), 'utf8') + overhead > MAX_TRANSCRIPT_BYTES
    ) {
      start += Math.max(1, Math.floor((rendered.length - start) * 0.1));
    }
    body = rendered.slice(start).join('\n');
    notes.push(`[!] Transcript exceeded the file-size limit — the oldest ${start} message(s) were dropped.`);
  }

  const footer = notes.length ? `\n\n${'='.repeat(72)}\n${notes.join('\n')}\n` : '\n';
  return header + body + footer;
}

// ---------------------------------------------------------------------------
// Build + post. Returns the posted message.
//
// THROWS on failure, deliberately. The caller must NOT touch the channel if
// this fails — a lost conversation is unrecoverable, a stuck channel is a
// nuisance.
// ---------------------------------------------------------------------------
async function postTranscript(client, channel, ticket, resolverName) {
  const { messages, truncated } = await fetchAllMessages(channel);
  const text = renderTranscript(ticket, messages, truncated);

  const num = String(ticket.number).padStart(4, '0');
  const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
    name: `ticket-${num}-transcript.txt`,
  });

  const embed = new EmbedBuilder()
    .setTitle(`📄 Transcript — Ticket #${num}`)
    .setColor(COLORS.RESOLVED)
    .addFields(
      { name: 'Subject',   value: (ticket.subject || '—').slice(0, 1024), inline: false },
      { name: 'Opened by', value: `<@${ticket.userId}> (${ticket.username})`, inline: true },
      { name: 'Resolved by', value: resolverName || '—', inline: true },
      { name: 'Messages', value: String(messages.length), inline: true },
      {
        name: 'Opened',
        value: `<t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:F>`,
        inline: true,
      },
      {
        name: 'Resolved',
        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
        inline: true,
      },
    )
    .setTimestamp();

  const archive = await client.channels.fetch(CHANNELS.TRANSCRIPTS);
  if (!archive?.isTextBased?.()) {
    throw new Error(`Transcript channel ${CHANNELS.TRANSCRIPTS} is missing or not text-based.`);
  }

  return archive.send({ embeds: [embed], files: [file] });
}

module.exports = {
  fetchAllMessages,
  renderTranscript,
  renderMessage,
  formatTimestamp,
  postTranscript,
  MAX_TRANSCRIPT_BYTES,
};
