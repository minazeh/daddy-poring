// ---------------------------------------------------------------------------
// In-memory open/closed flag for officer applications.
// Defaults to CLOSED (false) on every bot start — a restart is always safe.
// ---------------------------------------------------------------------------

let _open = false;

function isOfficerAppOpen() {
  return _open;
}

function setOfficerAppOpen(bool) {
  _open = Boolean(bool);
}

module.exports = { isOfficerAppOpen, setOfficerAppOpen };
