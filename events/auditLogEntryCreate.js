// ---------------------------------------------------------------------------
// Audit log: the central guildAuditLogEntryCreate dispatcher.
//
// This ONE event is the source of truth for every moderator/admin action that
// carries an actor: kicks, bans, timeouts, nickname changes, member-role
// add/remove, role CRUD, channel CRUD + permission overwrites, threads, server
// config, emoji/sticker, webhooks, integrations/bots, invites, and scheduled
// events. Each audit entry gives us executor + target + changes in one place, so
// we don't have to correlate the actor-less gateway events.
//
// Requires the GuildModeration intent + the bot having View Audit Log permission.
//
// Two entries feed the correlation store instead of logging directly:
//   - MemberKick / MemberBanAdd  → mark the removal so guildMemberRemove stays
//                                  silent (avoids a double "left" + "kicked").
//   - MessageDelete              → record the mod deleter so messageDelete can
//                                  attribute it (audit carries no content).
// ---------------------------------------------------------------------------

const { Events, AuditLogEvent, ChannelType } = require('discord.js');
const { logEvent, resolveActor, userLabel, truncate } = require('../auditlog/logger');
const { COLORS } = require('../auditlog/constants');
const { markRemoval, markModDelete } = require('../auditlog/correlation');

// Human labels for common change keys.
const KEY_LABELS = {
  name: 'Name', topic: 'Topic', nick: 'Nickname', color: 'Color', hoist: 'Hoisted',
  mentionable: 'Mentionable', rate_limit_per_user: 'Slowmode (s)', nsfw: 'NSFW',
  bitrate: 'Bitrate', user_limit: 'User Limit', icon_hash: 'Icon', banner_hash: 'Banner',
  vanity_url_code: 'Vanity URL', splash_hash: 'Splash', discovery_splash_hash: 'Discovery Splash',
  afk_channel_id: 'AFK Channel', afk_timeout: 'AFK Timeout', system_channel_id: 'System Channel',
  default_message_notifications: 'Default Notifications', explicit_content_filter: 'Content Filter',
  verification_level: 'Verification Level', description: 'Description', archived: 'Archived',
  locked: 'Locked', auto_archive_duration: 'Auto-Archive (min)', position: 'Position',
  channel_id: 'Channel', max_uses: 'Max Uses', max_age: 'Max Age (s)', temporary: 'Temporary',
  code: 'Code', privacy_level: 'Privacy', entity_type: 'Type', status: 'Status',
};

// Keys whose values are large bitfields / opaque — don't dump raw.
const OPAQUE_KEYS = new Set(['permissions', 'permissions_new', 'permissions_old', 'allow', 'deny', 'allow_new', 'deny_new']);

function fmtVal(v) {
  if (v == null || v === '') return '*none*';
  if (typeof v === 'object') return '*(changed)*';
  return truncate(String(v), 180);
}

function formatChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const lines = [];
  for (const c of changes) {
    if (OPAQUE_KEYS.has(c.key)) {
      lines.push(`• **${KEY_LABELS[c.key] || 'Permissions'}** updated`);
      continue;
    }
    if (c.key === '$add' || c.key === '$remove') continue; // handled separately
    const label = KEY_LABELS[c.key] || c.key;
    lines.push(`• **${label}:** ${fmtVal(c.old)} → ${fmtVal(c.new)}`);
  }
  return lines.length ? truncate(lines.join('\n'), 1024) : null;
}

// Pull the {id,name}[] from a $add / $remove role change.
function roleChangeList(changes, key) {
  const c = Array.isArray(changes) ? changes.find(x => x.key === key) : null;
  if (!c || !Array.isArray(c.new)) return [];
  return c.new.map(r => r.name || r.id);
}

const CHANNEL_TYPE_LABELS = {
  [ChannelType.GuildText]: 'Text',
  [ChannelType.GuildVoice]: 'Voice',
  [ChannelType.GuildCategory]: 'Category',
  [ChannelType.GuildAnnouncement]: 'Announcement',
  [ChannelType.GuildStageVoice]: 'Stage',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.PublicThread]: 'Public Thread',
  [ChannelType.PrivateThread]: 'Private Thread',
  [ChannelType.AnnouncementThread]: 'Announcement Thread',
};

module.exports = {
  name: Events.GuildAuditLogEntryCreate,
  async execute(entry, guild) {
    try {
      const client = guild.client;
      const actor = await resolveActor(entry, guild);
      const reason = entry.reason ? truncate(entry.reason, 512) : 'No reason provided';
      const changes = entry.changes;
      const action = entry.action;

      // Helper: resolve a target user label (fetch if only id present).
      const targetUser = async () => {
        if (entry.target && entry.target.username) return userLabel(entry.target);
        if (entry.targetId) {
          try { return userLabel(await client.users.fetch(entry.targetId)); } catch { /* ignore */ }
          return `<@${entry.targetId}> (\`${entry.targetId}\`)`;
        }
        return 'Unknown';
      };
      const targetName = () => entry.target?.name || (entry.targetId ? `\`${entry.targetId}\`` : 'Unknown');

      switch (action) {
        // ---- Members: moderation ------------------------------------------
        case AuditLogEvent.MemberKick: {
          markRemoval(entry.targetId, 'kick');
          await logEvent(client, {
            color: COLORS.RED, title: '👢 Member Kicked',
            fields: [
              { name: 'Member', value: await targetUser(), inline: false },
              { name: 'Kicked By', value: actor, inline: false },
              { name: 'Reason', value: reason, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.MemberBanAdd: {
          markRemoval(entry.targetId, 'ban');
          await logEvent(client, {
            color: COLORS.RED, title: '🔨 Member Banned',
            fields: [
              { name: 'Member', value: await targetUser(), inline: false },
              { name: 'Banned By', value: actor, inline: false },
              { name: 'Reason', value: reason, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.MemberBanRemove: {
          await logEvent(client, {
            color: COLORS.GREEN, title: '♻️ Member Unbanned',
            fields: [
              { name: 'Member', value: await targetUser(), inline: false },
              { name: 'Unbanned By', value: actor, inline: false },
              { name: 'Reason', value: reason, inline: false },
            ],
          });
          break;
        }

        // ---- Members: nickname + timeout (MemberUpdate) --------------------
        case AuditLogEvent.MemberUpdate: {
          const nickChange = Array.isArray(changes) ? changes.find(c => c.key === 'nick') : null;
          const timeoutChange = Array.isArray(changes)
            ? changes.find(c => c.key === 'communication_disabled_until') : null;

          if (nickChange) {
            const isSelf = entry.executorId && entry.targetId && entry.executorId === entry.targetId;
            await logEvent(client, {
              color: COLORS.BLUE, title: '✏️ Nickname Changed',
              fields: [
                { name: 'Member', value: await targetUser(), inline: false },
                { name: 'Nickname', value: `\`${nickChange.old ?? '—'}\` → \`${nickChange.new ?? '—'}\``, inline: false },
                { name: 'Changed By', value: isSelf ? 'themselves' : actor, inline: false },
              ],
            });
          }

          if (timeoutChange) {
            const until = timeoutChange.new ? new Date(timeoutChange.new) : null;
            const active = until && until.getTime() > Date.now();
            if (active) {
              await logEvent(client, {
                color: COLORS.ORANGE, title: '🔇 Member Timed Out',
                fields: [
                  { name: 'Member', value: await targetUser(), inline: false },
                  { name: 'Until', value: `<t:${Math.floor(until.getTime() / 1000)}:R>`, inline: true },
                  { name: 'By', value: actor, inline: true },
                  { name: 'Reason', value: reason, inline: false },
                ],
              });
            } else {
              await logEvent(client, {
                color: COLORS.GREEN, title: '🔊 Timeout Removed',
                fields: [
                  { name: 'Member', value: await targetUser(), inline: false },
                  { name: 'By', value: actor, inline: true },
                ],
              });
            }
          }
          break;
        }

        // ---- Members: role add/remove -------------------------------------
        case AuditLogEvent.MemberRoleUpdate: {
          const added = roleChangeList(changes, '$add');
          const removed = roleChangeList(changes, '$remove');
          const who = await targetUser();
          if (added.length) {
            await logEvent(client, {
              color: COLORS.GOLD, title: '➕ Role Added to Member',
              fields: [
                { name: 'Member', value: who, inline: false },
                { name: 'Role(s)', value: added.map(r => `\`${r}\``).join(', '), inline: false },
                { name: 'By', value: actor, inline: false },
              ],
            });
          }
          if (removed.length) {
            await logEvent(client, {
              color: COLORS.GOLD, title: '➖ Role Removed from Member',
              fields: [
                { name: 'Member', value: who, inline: false },
                { name: 'Role(s)', value: removed.map(r => `\`${r}\``).join(', '), inline: false },
                { name: 'By', value: actor, inline: false },
              ],
            });
          }
          break;
        }

        // ---- Messages -----------------------------------------------------
        case AuditLogEvent.MessageDelete: {
          // Feed correlation only — the gateway messageDelete handler logs content.
          const channelId = entry.extra?.channel?.id || entry.extra?.channelId || null;
          markModDelete(entry.targetId, channelId, actor);
          break;
        }
        case AuditLogEvent.MessageBulkDelete: {
          const count = entry.extra?.count ?? '?';
          await logEvent(client, {
            color: COLORS.RED, title: '🧹 Bulk Message Delete',
            fields: [
              { name: 'Channel', value: entry.targetId ? `<#${entry.targetId}>` : 'unknown', inline: true },
              { name: 'Messages', value: String(count), inline: true },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }

        // ---- Roles (CRUD) -------------------------------------------------
        case AuditLogEvent.RoleCreate: {
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color: COLORS.GOLD, title: '🆕 Role Created',
            fields: [
              { name: 'Role', value: `\`${nameChange?.new || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }
        case AuditLogEvent.RoleDelete: {
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color: COLORS.GOLD, title: '🗑️ Role Deleted',
            fields: [
              { name: 'Role', value: `\`${nameChange?.old || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }
        case AuditLogEvent.RoleUpdate: {
          await logEvent(client, {
            color: COLORS.GOLD, title: '✏️ Role Edited',
            fields: [
              { name: 'Role', value: `\`${targetName()}\``, inline: false },
              { name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }

        // ---- Channels -----------------------------------------------------
        case AuditLogEvent.ChannelCreate: {
          const typeChange = Array.isArray(changes) ? changes.find(c => c.key === 'type') : null;
          await logEvent(client, {
            color: COLORS.GREEN, title: '🆕 Channel Created',
            fields: [
              { name: 'Channel', value: entry.targetId ? `<#${entry.targetId}>` : `\`${targetName()}\``, inline: true },
              { name: 'Type', value: CHANNEL_TYPE_LABELS[typeChange?.new] || String(typeChange?.new ?? '—'), inline: true },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.ChannelDelete: {
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          const typeChange = Array.isArray(changes) ? changes.find(c => c.key === 'type') : null;
          await logEvent(client, {
            color: COLORS.RED, title: '🗑️ Channel Deleted',
            fields: [
              { name: 'Channel', value: `\`${nameChange?.old || targetName()}\``, inline: true },
              { name: 'Type', value: CHANNEL_TYPE_LABELS[typeChange?.old] || String(typeChange?.old ?? '—'), inline: true },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.ChannelUpdate: {
          await logEvent(client, {
            color: COLORS.BLUE, title: '✏️ Channel Edited',
            fields: [
              { name: 'Channel', value: entry.targetId ? `<#${entry.targetId}>` : `\`${targetName()}\``, inline: false },
              { name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.ChannelOverwriteCreate:
        case AuditLogEvent.ChannelOverwriteUpdate:
        case AuditLogEvent.ChannelOverwriteDelete: {
          const verb = action === AuditLogEvent.ChannelOverwriteCreate ? 'Created'
            : action === AuditLogEvent.ChannelOverwriteDelete ? 'Removed' : 'Updated';
          // entry.extra identifies the affected role/member.
          const extra = entry.extra;
          let affected = 'unknown';
          if (extra) {
            if (extra.name) affected = `role \`${extra.name}\``;
            else if (extra.id && extra.type === 'member') affected = `<@${extra.id}>`;
            else if (extra.id) affected = `role <@&${extra.id}>`;
          }
          await logEvent(client, {
            color: COLORS.BLUE, title: `🔐 Permission Overwrite ${verb}`,
            fields: [
              { name: 'Channel', value: entry.targetId ? `<#${entry.targetId}>` : 'unknown', inline: false },
              { name: 'Applies To', value: affected, inline: false },
              { name: 'Changes', value: formatChanges(changes) || '*(permission bits changed)*', inline: false },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }

        // ---- Threads ------------------------------------------------------
        case AuditLogEvent.ThreadCreate: {
          await logEvent(client, {
            color: COLORS.GREEN, title: '🧵 Thread Created',
            fields: [
              { name: 'Thread', value: entry.targetId ? `<#${entry.targetId}>` : `\`${targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }
        case AuditLogEvent.ThreadDelete: {
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color: COLORS.RED, title: '🧵 Thread Deleted',
            fields: [
              { name: 'Thread', value: `\`${nameChange?.old || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }
        case AuditLogEvent.ThreadUpdate: {
          const archivedChange = Array.isArray(changes) ? changes.find(c => c.key === 'archived') : null;
          let title = '✏️ Thread Edited';
          let color = COLORS.BLUE;
          if (archivedChange) {
            title = archivedChange.new ? '🧵 Thread Archived' : '🧵 Thread Unarchived';
          }
          await logEvent(client, {
            color, title,
            fields: [
              { name: 'Thread', value: entry.targetId ? `<#${entry.targetId}>` : `\`${targetName()}\``, inline: false },
              { name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }

        // ---- Server config ------------------------------------------------
        case AuditLogEvent.GuildUpdate: {
          await logEvent(client, {
            color: COLORS.BLUE, title: '⚙️ Server Settings Changed',
            fields: [
              { name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.EmojiCreate:
        case AuditLogEvent.EmojiDelete:
        case AuditLogEvent.EmojiUpdate: {
          const verb = action === AuditLogEvent.EmojiCreate ? 'Added'
            : action === AuditLogEvent.EmojiDelete ? 'Removed' : 'Renamed';
          const color = action === AuditLogEvent.EmojiCreate ? COLORS.GREEN
            : action === AuditLogEvent.EmojiDelete ? COLORS.RED : COLORS.BLUE;
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          const name = nameChange?.new || nameChange?.old || targetName();
          await logEvent(client, {
            color, title: `😀 Emoji ${verb}`,
            fields: [
              { name: 'Emoji', value: `\`${name}\``, inline: true },
              { name: 'By', value: actor, inline: true },
              ...(verb === 'Renamed' && nameChange ? [{ name: 'Change', value: `\`${nameChange.old ?? '—'}\` → \`${nameChange.new ?? '—'}\``, inline: false }] : []),
            ],
          });
          break;
        }
        case AuditLogEvent.StickerCreate:
        case AuditLogEvent.StickerDelete:
        case AuditLogEvent.StickerUpdate: {
          const verb = action === AuditLogEvent.StickerCreate ? 'Added'
            : action === AuditLogEvent.StickerDelete ? 'Removed' : 'Updated';
          const color = action === AuditLogEvent.StickerCreate ? COLORS.GREEN
            : action === AuditLogEvent.StickerDelete ? COLORS.RED : COLORS.BLUE;
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color, title: `🏷️ Sticker ${verb}`,
            fields: [
              { name: 'Sticker', value: `\`${nameChange?.new || nameChange?.old || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }

        // ---- Webhooks -----------------------------------------------------
        case AuditLogEvent.WebhookCreate:
        case AuditLogEvent.WebhookDelete:
        case AuditLogEvent.WebhookUpdate: {
          const verb = action === AuditLogEvent.WebhookCreate ? 'Created'
            : action === AuditLogEvent.WebhookDelete ? 'Deleted' : 'Edited';
          const color = action === AuditLogEvent.WebhookCreate ? COLORS.GREEN
            : action === AuditLogEvent.WebhookDelete ? COLORS.RED : COLORS.BLUE;
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color, title: `🪝 Webhook ${verb}`,
            fields: [
              { name: 'Webhook', value: `\`${nameChange?.new || nameChange?.old || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
              ...(verb === 'Edited' ? [{ name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false }] : []),
            ],
          });
          break;
        }

        // ---- Integrations / bots ------------------------------------------
        case AuditLogEvent.IntegrationCreate:
        case AuditLogEvent.IntegrationDelete: {
          const added = action === AuditLogEvent.IntegrationCreate;
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color: added ? COLORS.GREEN : COLORS.RED,
            title: added ? '🔌 Integration Added' : '🔌 Integration Removed',
            fields: [
              { name: 'Integration', value: `\`${nameChange?.new || nameChange?.old || targetName()}\``, inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }
        case AuditLogEvent.BotAdd: {
          await logEvent(client, {
            color: COLORS.GREEN, title: '🤖 Bot Added',
            fields: [
              { name: 'Bot', value: await targetUser(), inline: false },
              { name: 'Added By', value: actor, inline: false },
            ],
          });
          break;
        }

        // ---- Invites ------------------------------------------------------
        case AuditLogEvent.InviteCreate: {
          const get = (k) => (Array.isArray(changes) ? changes.find(c => c.key === k)?.new : undefined);
          const code = get('code');
          const maxUses = get('max_uses');
          const maxAge = get('max_age');
          const channelId = get('channel_id');
          await logEvent(client, {
            color: COLORS.GREEN, title: '✉️ Invite Created',
            fields: [
              { name: 'Code', value: code ? `\`${code}\`` : '—', inline: true },
              { name: 'Channel', value: channelId ? `<#${channelId}>` : '—', inline: true },
              { name: 'Max Uses', value: (maxUses === 0 || maxUses == null) ? '∞' : String(maxUses), inline: true },
              { name: 'Expires', value: (maxAge === 0 || maxAge == null) ? 'never' : `<t:${Math.floor(Date.now() / 1000) + Number(maxAge)}:R>`, inline: true },
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }
        case AuditLogEvent.InviteDelete: {
          const code = Array.isArray(changes) ? changes.find(c => c.key === 'code')?.old : undefined;
          await logEvent(client, {
            color: COLORS.RED, title: '✉️ Invite Deleted',
            fields: [
              { name: 'Code', value: code ? `\`${code}\`` : '—', inline: true },
              { name: 'By', value: actor, inline: true },
            ],
          });
          break;
        }

        // ---- Scheduled events ---------------------------------------------
        case AuditLogEvent.GuildScheduledEventCreate:
        case AuditLogEvent.GuildScheduledEventUpdate:
        case AuditLogEvent.GuildScheduledEventDelete: {
          const verb = action === AuditLogEvent.GuildScheduledEventCreate ? 'Created'
            : action === AuditLogEvent.GuildScheduledEventDelete ? 'Cancelled' : 'Updated';
          const color = action === AuditLogEvent.GuildScheduledEventCreate ? COLORS.GREEN
            : action === AuditLogEvent.GuildScheduledEventDelete ? COLORS.RED : COLORS.BLUE;
          const nameChange = Array.isArray(changes) ? changes.find(c => c.key === 'name') : null;
          await logEvent(client, {
            color, title: `📅 Scheduled Event ${verb}`,
            fields: [
              { name: 'Event', value: `\`${nameChange?.new || nameChange?.old || targetName()}\``, inline: false },
              ...(verb === 'Updated' ? [{ name: 'Changes', value: formatChanges(changes) || '*(details unavailable)*', inline: false }] : []),
              { name: 'By', value: actor, inline: false },
            ],
          });
          break;
        }

        default:
          // Unhandled audit action — ignore silently to keep the channel clean.
          break;
      }
    } catch (err) {
      console.warn('[auditlog:auditEntry]', err?.message || err);
    }
  },
};
