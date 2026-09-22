// The printer's "open web interface" link, shown on Fleet cards and the
// Dashboard/Webcams fleet grid. Defaults to the printer's local IP (only
// meaningful for connectors that ARE a browser-reachable web UI); when the
// operator has set an OctoEverywhere URL (https://octoeverywhere.com) for the
// printer, that takes over instead, since it works off the local network too.
// OctoEverywhere itself is a remote-access proxy for an existing OctoPrint or
// Moonraker/Klipper web UI, not a printer connector, so this is purely a link
// choice: it has no effect on polling, dispatch, or any driver behavior.
export function webUiLink(printer) {
  if (printer.octoeverywhere_url) {
    return { url: printer.octoeverywhere_url, label: 'OctoEverywhere ↗' };
  }
  if (printer.type === 'klipper') {
    return { url: `http://${printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`, label: 'Mainsail ↗' };
  }
  if (printer.type === 'octoprint') {
    return { url: `http://${printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`, label: 'OctoPrint ↗' };
  }
  return null;
}
