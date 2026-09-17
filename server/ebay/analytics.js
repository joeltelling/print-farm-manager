/**
 * eBay Analytics + Account read helpers with short in-memory cache.
 */
const { ebayRequest } = require('./client');
const { getCredentials } = require('./credentials');

// Cache traffic/standards for 5 minutes so the ERP page can poll without
// hammering eBay analytics quotas.
const ANALYTICS_CACHE_MS = 5 * 60 * 1000;

const _cache = {
  traffic: null,
  trafficAt: 0,
  standards: null,
  standardsAt: 0,
  privilege: null,
  privilegeAt: 0,
};

function clearAnalyticsCache() {
  _cache.traffic = null;
  _cache.trafficAt = 0;
  _cache.standards = null;
  _cache.standardsAt = 0;
  _cache.privilege = null;
  _cache.privilegeAt = 0;
}

async function getPrivilege(db, { force } = {}) {
  const now = Date.now();
  if (!force && _cache.privilege && now - _cache.privilegeAt < ANALYTICS_CACHE_MS) {
    return { ok: true, cached: true, data: _cache.privilege };
  }
  const res = await ebayRequest(db, {
    method: 'GET',
    path: '/sell/account/v1/privilege',
  });
  if (!res.ok) return res;
  _cache.privilege = res.data;
  _cache.privilegeAt = now;
  return { ok: true, cached: false, data: res.data };
}

async function getSellerStandards(db, { force } = {}) {
  const now = Date.now();
  if (!force && _cache.standards && now - _cache.standardsAt < ANALYTICS_CACHE_MS) {
    return { ok: true, cached: true, data: _cache.standards };
  }
  const res = await ebayRequest(db, {
    method: 'GET',
    path: '/sell/analytics/v1/seller_standards_profile',
  });
  if (!res.ok) return res;
  _cache.standards = res.data;
  _cache.standardsAt = now;
  return { ok: true, cached: false, data: res.data };
}

/**
 * Traffic report for the last 30 days by DAY (default metrics).
 * Official params: dimension, metric, filter (date_range + marketplace_ids).
 */
async function getTrafficReport(db, opts = {}) {
  const now = Date.now();
  if (!opts.force && _cache.traffic && now - _cache.trafficAt < ANALYTICS_CACHE_MS) {
    return { ok: true, cached: true, data: _cache.traffic };
  }

  const creds = getCredentials(db);
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const dateRange = `[${fmt(start)}..${fmt(end)}]`;
  const marketplace = creds.marketplace_id || 'EBAY_US';

  const res = await ebayRequest(db, {
    method: 'GET',
    path: '/sell/analytics/v1/traffic_report',
    params: {
      dimension: opts.dimension || 'DAY',
      metric: opts.metric || 'LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,TRANSACTION',
      filter: `marketplace_ids:{${marketplace}},date_range:${dateRange}`,
    },
  });
  if (!res.ok) return res;
  _cache.traffic = res.data;
  _cache.trafficAt = now;
  return { ok: true, cached: false, data: res.data };
}

module.exports = {
  ANALYTICS_CACHE_MS,
  clearAnalyticsCache,
  getPrivilege,
  getSellerStandards,
  getTrafficReport,
};
