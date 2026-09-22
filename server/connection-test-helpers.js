// Shared helper for driver testConnection() functions (the "Test Connection" button
// on the Add Printer and printer-edit forms). Unlike getStatus, which must swallow
// every error into the canonical OFFLINE status, a connection test exists specifically
// to surface the real reason a connection failed, so operators can tell a bad hostname
// apart from a bad API key apart from an unreachable printer.

function describeConnectionError(err) {
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'Hostname did not resolve';
  if (err.code === 'ECONNREFUSED') return 'Connection refused (check the port)';
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return 'Connection timed out';
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return 'Host unreachable';
  if (err.response?.status === 401 || err.response?.status === 403) return 'Rejected: check the API key';
  if (err.response) return `Printer responded with HTTP ${err.response.status}`;
  return err.message || 'Connection failed';
}

module.exports = { describeConnectionError };
