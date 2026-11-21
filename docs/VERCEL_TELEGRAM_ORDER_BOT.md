# Vercel Telegram order bot

## Current implementation and verification boundary

The Telegram/Storelex order flow is implemented behind `VERCEL_ORDER_FLOW_ENABLED` (default `false`). The primary address route is manual/map based: customer shares a Telegram location, enters building/area/landmark/receiver details, and the bot calls `POST /addresses/add`; checkout uses the `address.id` returned by Storelex as `address_id`. An unclear add response is not retried automatically, since an address may already have been persisted.

Optional address-link import has its own independent `STORELEX_ADDRESS_LINK_ENABLED` flag (default `false`). When enabled, `POST /cart/address_by_link` sends exactly `{ mobile, link }` with a 45-second timeout. The bot uses `address.id`, falls back from `address.lat/lng` to `saved.lat/lng`, takes receiver name/phone from `saved`, honors `existing: true` as success, does not make a second add call, and drops its local selection on `gone: true`.

Storelex contracts supplied in the conversation are covered by synthetic tests only. No live response sample or bundle audit has been captured. Do not set the order flag true until the preview test confirms the manual `/addresses/add` body/response and live pricing/checkout mappings. The link-import flag can remain off independently.

The previously pasted Storelex key is considered exposed and should be rotated. `.env.local` has been created with an empty `STORELEX_KEY=` line and is ignored by Git. Fill it locally; never paste the value into chat or commit the file.

## Mapped Storelex calls

- `POST /addresses/add`: primary map/manual flow. Request contains the authorized account `mobile`, shared location coordinates, building/area/landmark and receiver details. The response must be successful and include `address.id`; otherwise checkout stops.
- Optional `POST /cart/address_by_link`: request exactly `{ mobile, link }`; 45s timeout. No `/cart/add_address_to_account` follow-up.
- `POST /cart/import_group`: starts with `leave_old:false`; on `already_in_group`, retries once with `leave_old:true` (30s/45s timeout).
- `POST /search/cart`: sole pricing authority. Provider payable paise is used; `bill_lines[].value` is displayed as returned. Out-of-stock non-free items and item-ID mismatches block review.
- `/checkout/place`: provider cart/address/restaurant fields, API payable and UPI method plus telemetry-only `snap`. Amount changes trigger fresh repricing and customer approval; `unconfirmed` is never blind-retried.
- Payment status/confirm/order status: paid is counted only after provider confirmation; inconclusive remains pending; tracking/status are provider-sourced.

## Poll scheduling

- QStash is chained per order: a delayed callback checks one `order_id`, then schedules the next due check. The cadence is 5s, 10s, and 20s by elapsed-time ladder, then 60s after 20 minutes, through a 24-hour maximum. It forwards `Authorization: Bearer <CRON_SECRET>` and authenticates to QStash with `QSTASH_TOKEN`. A KV lock prevents concurrent duplicate status calls.
- The connected Vercel team is on Hobby, so the Pro-only one-minute Vercel Cron was not configured in `vercel.json`. The QStash chain supplies the minute fallback after 20 minutes; a Vercel Cron backstop can be added if the project moves to a plan supporting it.
- If QStash is not configured or enqueue fails, automated polling cannot be guaranteed; manual “Payment check” remains. Configure `QSTASH_TOKEN`, `CRON_SECRET`, and Vercel's `VERCEL_URL` (provided by Vercel) before enabling orders; never put credentials in URLs.

## Vercel preview checklist

Configure secrets only in Vercel's encrypted environment store: `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, rotated `STORELEX_USER_KEY`, `CRON_SECRET`, `QSTASH_TOKEN`, KV/Upstash REST URL/token, and `TELEGRAM_ACCOUNT_MAP`; set `VERCEL_ORDER_FLOW_ENABLED=false` and `STORELEX_ADDRESS_LINK_ENABLED=false`. Do not create or promote a production deployment as part of a preview test. Environment-variable changes require a new deployment.

At the user's direction, a dedicated Vercel project `ammi-abbu-storelex-order-bot` has now been created for this repository (`prj_Qm8m0AwyOgiA1KWfZTDHRvwFRr0E`). Only the two preview-safe feature flags were configured there, both `false`; no production environment values were changed. The Vercel team is on Hobby, so this deployment omits Pro-only Vercel Cron and relies on the QStash per-order chain. The project is not yet deployed; production promotion remains explicitly out of scope without user approval.

After a preview exists, audit `/swiggy_web/app.js`, `/swiggy_web/search.js`, and `/swiggy_web/cart.js`, then capture redacted samples for `/addresses/add`, optional `/cart/address_by_link`, `/cart/import_group`, `/search/cart`, `/checkout/place`, and payment status/confirmation. Do not include keys, phone numbers, full addresses, or real order IDs in committed samples.

## Local checks

```sh
npm run test:vercel-chat
npm run test:storelex-api
node --check api/telegram.js
node --check api/payment-poll.js
```
