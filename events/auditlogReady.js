// ---------------------------------------------------------------------------
// Audit log: boot init.
// Separate ready listener (the loader registers both this and events/ready.js).
// Snapshots invite use-counts so joins can resolve which invite was used.
// Best-effort — a failure here never affects boot.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const inviteTracker = require('../auditlog/inviteTracker');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      await inviteTracker.init(client);
      console.log('[auditlog] Ready — invite snapshot taken, audit logging active.');
    } catch (err) {
      console.warn('[auditlog] Invite tracker init failed (join invite-resolution degraded):', err?.message || err);
    }
  },
};
