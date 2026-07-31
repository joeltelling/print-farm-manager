const helmet = require('helmet');

// Security headers. CSP is scoped to what the client actually needs:
// - style-src allows 'unsafe-inline' because every page in client/src uses React's
//   style={{...}} prop, which renders as inline style="" attributes — blocking that
//   would break the entire UI's styling, not just a few components.
// - style-src/font-src allow fonts.googleapis.com/fonts.gstatic.com for the Inter/Fira
//   Code font import in client/src/index.css.
// - crossOriginEmbedderPolicy is disabled — Google Fonts doesn't send the CORP header
//   COEP: require-corp would need, so leaving helmet's default on would silently break
//   font loading. This app has no need for cross-origin isolation (no SharedArrayBuffer).
// - hsts is disabled — this app is served over plain HTTP on the LAN (see README), and
//   browsers ignore Strict-Transport-Security entirely when it's not delivered over
//   HTTPS anyway, so sending it here is just misleading noise, not a real protection.
// - upgradeInsecureRequests is explicitly disabled for the same reason: Helmet's CSP
//   defaults include the `upgrade-insecure-requests` directive unless told otherwise.
//   On the documented plain-HTTP LAN deployment, a browser enforcing that directive can
//   try to upgrade same-origin asset/API requests to HTTPS — which nothing here serves —
//   breaking the app entirely.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: false,
});

// helmet dropped Permissions-Policy support (spec churn) — set a minimal one directly.
// This app doesn't use any of these browser features, so deny them outright.
function permissionsPolicy(_req, res, next) {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  next();
}

module.exports = (app) => {
  app.use(helmetMiddleware);
  app.use(permissionsPolicy);
};
