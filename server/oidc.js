// Generic OIDC login: config-driven so any OIDC-compliant provider (Okta,
// Authentik, Auth0, Keycloak, generic OIDC, etc.) works without code changes.
// Reference: https://github.com/panva/openid-client/blob/v5.x/docs/README.md
//
// Configured entirely via environment variables, matching this repo's existing
// env-var-driven optional features (DEMO_MODE):
//   OIDC_ISSUER_URL    : e.g. https://your-idp.example.com
//   OIDC_CLIENT_ID
//   OIDC_CLIENT_SECRET
//   OIDC_REDIRECT_URI   : e.g. http://localhost:3000/api/auth/oidc/callback
//
// If any are missing, isConfigured() is false and the OIDC login routes
// return a clear "not configured" error instead of attempting discovery.
// The openid-client Issuer/Client is discovered lazily on first use (not at
// module load) so a farm that never sets these env vars pays no discovery
// round-trip and never needs network access to an identity provider it isn't
// using: the same lazy pattern server/drivers/index.js uses for connectors.

let clientPromise = null;

function isConfigured() {
  return !!(process.env.OIDC_ISSUER_URL && process.env.OIDC_CLIENT_ID &&
            process.env.OIDC_CLIENT_SECRET && process.env.OIDC_REDIRECT_URI);
}

async function getClient() {
  if (!isConfigured()) {
    throw Object.assign(new Error('OIDC is not configured'), { code: 'OIDC_NOT_CONFIGURED' });
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Issuer } = require('openid-client');
      const issuer = await Issuer.discover(process.env.OIDC_ISSUER_URL);
      return new issuer.Client({
        client_id: process.env.OIDC_CLIENT_ID,
        client_secret: process.env.OIDC_CLIENT_SECRET,
        redirect_uris: [process.env.OIDC_REDIRECT_URI],
        response_types: ['code'],
      });
    })();
  }
  return clientPromise;
}

// Returns { url, state, codeVerifier }: state and codeVerifier must be kept
// (in the session-less pre-login flow, a short-lived signed cookie) until the
// callback arrives, then passed back into handleCallback.
async function getAuthorizationUrl() {
  const { generators } = require('openid-client');
  const client = await getClient();
  const state = generators.state();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const url = client.authorizationUrl({
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url, state, codeVerifier };
}

// Exchanges the callback's query params for tokens and returns the claims
// needed to resolve or create a local user: { sub, email, name }.
async function handleCallback(callbackUrl, { state, codeVerifier }) {
  const client = await getClient();
  const params = client.callbackParams(callbackUrl);
  const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URI, params, {
    state,
    code_verifier: codeVerifier,
  });
  const claims = tokenSet.claims();
  return { sub: claims.sub, email: claims.email, name: claims.name || claims.email };
}

module.exports = { isConfigured, getAuthorizationUrl, handleCallback };
