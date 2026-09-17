# eBay Sell APIs (CoMa ERP)

Integrates eBay seller APIs into the embedded ERP: import paid orders into `sales_order`, push finished-goods price and quantity to existing offers, and surface Analytics / Account diagnostics.

**Hardware / account status:** implemented from eBay OpenAPI contracts (Fulfillment, Account, Analytics) and the Inventory API reference for `bulkUpdatePriceQuantity`. **Not yet validated against a real eBay sandbox or production seller account.**

## What it does

| Direction | Behavior |
|---|---|
| eBay to CoMa | Pull paid/checkout-complete orders via Fulfillment `GET /sell/fulfillment/v1/order` with `lastmodifieddate` watermark |
| CoMa to eBay | Update price and quantity on **existing** offers only (`POST /sell/inventory/v1/bulk_update_price_quantity`). Does not create or publish listings |
| Analytics | Read traffic report and seller standards; Account `privilege` as connection probe |

## Hybrid order posting

1. Each eBay line item upserts into `ebay_order` / `ebay_order_line` keyed by `line_item_id` (unique).
2. SKU resolution: `ebay_listing.ebay_sku` first, else exact match on `item.sku`.
3. If `auto_post` is enabled, the SKU is mapped, and `fin_good` stock covers the qty: create `sales_order` + negative `stock_move` with `idem_key = ebay-line-{line_item_id}-sale`, status `auto_posted`.
4. Otherwise the line stays `pending` for the operator at `/erp/ebay` (confirm, confirm with shortage, or dismiss).
5. Re-importing the same order never double-fires stock or sales: status check inside the transaction + unique `idem_key`.

This path never touches `parts.completed_qty`.

## Credentials

Stored in `ebay_credential` (single row, id=1). **Excluded from Settings JSON backup** so secrets do not land in export files. After a restore, paste credentials again (or use env vars).

| Source | Keys |
|---|---|
| Env (wins over DB) | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, optional `EBAY_ENVIRONMENT`, `EBAY_MARKETPLACE_ID` |
| DB / UI | Same fields via `PUT /api/erp/ebay/credentials` (API returns masked values only) |

OAuth uses `grant_type=refresh_token` against the Identity token endpoint. Paste a user refresh token from the eBay developer portal (sandbox first). There is no RuName callback flow in this release.

Recommended scopes (space-separated):

- `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`
- `https://api.ebay.com/oauth/api_scope/sell.inventory`
- `https://api.ebay.com/oauth/api_scope/sell.account.readonly`
- `https://api.ebay.com/oauth/api_scope/sell.analytics.readonly`

## Inventory push

- Quantity: `SUM(stock_move.qty)` for the mapped item in `fin_good` (same source as ERP sales stock checks).
- Price: `bomCostForItem` + `pricingNumbers` (applies `MARGIN_DEF`, `ADDS_PCT`, `EBAY_FEE` / per-item overrides).
- One SKU per API call; up to 25 offer IDs per call (comma-separated `offer_id` on the mapping row).
- `offer_id` is required on the mapping; without it the push records an error and skips.

## Background runner

`server/ebay/runner.js` starts with Express (`ebayRunner.start(db)`). Interval is 5 minutes. Skips when `DEMO_MODE=true` or credentials are missing. Repeated failures raise an in-memory notification (not a toast storm).

## UI

Route `/erp/ebay` (sidebar: Ventas / eBay). Connection status, masked credentials form, SKU mappings, pending queue, recent orders, analytics JSON panels.

## Module layout

| File | Role |
|---|---|
| `server/ebay/schema.js` | CREATE TABLE IF NOT EXISTS |
| `server/ebay/credentials.js` | Env/DB resolution + masking |
| `server/ebay/client.js` | Token cache, axios, backoff |
| `server/ebay/orders.js` | Import + hybrid apply |
| `server/ebay/inventory.js` | Listings CRUD + push |
| `server/ebay/analytics.js` | Traffic / standards / privilege |
| `server/ebay/runner.js` | Periodic sync |
| `server/ebay/index.js` | Express factory mounted at `/api/erp/ebay` |

## Troubleshooting

| Symptom | Check |
|---|---|
| Test connection fails | Sandbox vs production environment, refresh token for that environment, scopes on the app |
| Orders never appear | Fulfillment only returns checkout-complete orders; sandbox purchases must be marked paid |
| Auto-post never runs | Mapping exists, `auto_post` enabled, stock in `fin_good` |
| Push fails with offer_id error | Paste the Inventory offer ID from eBay into the mapping |
| Credentials vanish after restore | Expected: re-enter them or set env vars |

## Limits (eBay)

- `getOrders` history window: up to two years; default lookback when no watermark is seven days.
- `bulkUpdatePriceQuantity`: one product SKU per call, max 25 offers.
- Rate limits: client retries 429/5xx with exponential backoff (1s, 2s, 4s).
