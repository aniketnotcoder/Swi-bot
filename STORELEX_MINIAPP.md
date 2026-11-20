# Storelex Telegram Mini App

A separate, black-only Storelex UI at `/storelex` served by the same Node process as `npm start`. Open using Telegram's Web App menu, not a browser login screen. The browser never receives `STORELEX_USER_KEY`; its requests include Telegram `initData`, validated server-side. Only `BOSS_ID` / `BOSS_IDS` can access the shared Storelex key. Do not embed a shared access key in frontend JavaScript or put it into a URL; a key previously posted in chat must be rotated. No OTP, JSON-import or access-key login UI exists.

## Environment

Copy `storelex.env.example` to an untracked `.env` locally or set the equivalent variables in the host's private environment: `BOT_TOKEN`, `BOSS_ID`, `STORELEX_USER_KEY`, `STORELEX_API_BASE_URL`, `DATA_DIR`, `PORT`, and public `PUBLIC_URL` (if the host does not supply `RENDER_EXTERNAL_URL` or `RAILWAY_PUBLIC_DOMAIN`). **Never commit the real `.env`.** Production requires a persistent `DATA_DIR`; a single bot instance is recommended. Docker/Render provides `/app/data`. The server binds `0.0.0.0:$PORT`. Use an HTTPS Web Service (not a worker/serverless function); Telegram requires an HTTPS Mini App URL. The Render blueprint has been changed from worker to web: **stop the old worker before running the web service with the same BOT_TOKEN**, or two pollers can conflict and legacy flows can send misleading messages. The Telegram menu is set to `/storelex` when a public URL is available. In the owner's private bot chat, `/start` and `/app` also show a persistent **🍽 Open Swiggy Mini App** keyboard button. The URL comes from `PUBLIC_URL`, `RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN`, or the known Render service hostname; other users do not receive this shared-key app button.

At boot the server authenticates with `GET /me` and aborts if `success !== true`. It does **not** call `/auth/validate_key/{key}` because that would put the reusable access key in a URL (reverse-proxy/access logs and browser histories). This intentionally differs from the supplied boot instruction. HTTP calls use the existing secret-safe Storelex client with a 60-second ceiling. API key stays server-side and is never logged.

## Per-user scratch storage

`storelex-mini.sqlite` under `DATA_DIR` is a SQLite database (sql.js) with `scratch(telegram_id PRIMARY KEY, mobile, cart_id, address_id, lat, lng, updated_at)` and a one-attempt `placements(telegram_id, cart_id, state, order_id, txn_id)` journal. Account/address selections are checked against Storelex and scoped by selected mobile. The journal is not a replacement for a durable single-instance volume or remote idempotency guarantees.

## Enabled UI

- **Accounts:** `/sessions` selection, `/profile/{mobile}` guard, `/accounts/{mobile}/export`, free-cash check, key-login-only login key, confirmed `/accounts/remove_all`.
- **Addresses:** selected mobile's account addresses, manual add, link add, delete with `is_global`, account sync, location search/details/reverse.
- **Explore:** restaurant search, menu and menu search, outlets, item/cart-context import. Optional variant/add-on selection JSON is only sent if explicitly supplied from the displayed menu metadata.
- **Cart:** server backup, group import, and `/search/cart` repricing after each add/remove (when no items remain, cart clears in the browser). Prices from the API are paise and are converted only in display.
- **Checkout:** coupons/best/apply/remove, payment options, Swiggy One, explicit bill confirmation, one-attempt UPI/COD/card placement. If the provider says `amount_changed`, the UI requires a new bill and confirmation. If `unconfirmed` has a transaction id, the server makes at most one bounded retry with the **same** cart and transaction id; otherwise it requires manual reconciliation. No automatic retry after network uncertainty.
- **Payment:** payment-status polling every 5 seconds for 3 minutes, then 10 then 20 seconds, deep every fourth check, 20-minute cap. Only after a paid provider response does the server confirm and allow order status/tracking. UPI opener uses only the returned `upi://pay` URL. Paylog telemetry available.
- **Orders:** history/detail/rating for the selected mobile only.

## Deliberately disabled

`mark_used`, `mark_fresh`, single-account remove, Swiggy account delete/start/confirm, mobile OTP login, JSON import, batch/diya/claimed offers/breakfast/night tools, other accounts' address lists, and bulk `/orders_recent`. These routes are absent from the server allowlist, not just hidden in the UI.

## Theme tokens

Background `#000000`, surfaces `#0d0d0d`–`#111111`, primary text `#f5f5f5`, muted `#8a8a8a`, one accent `#fb923c` (orange); system font stack, no theme toggle/gradients/shadows. Logo slot is the outlined `S` at top left.

## Limitations

This is not a live Storelex E2E verification. No real order, card charge or payment was made in this environment. The public OpenAPI describes many request bodies as arbitrary objects; test with an owner-controlled account before wider rollout. Current owner-only gate intentionally prevents exposing every saved account and destructive operations to arbitrary Telegram users under a single shared key. The user-supplied key was not copied into source or the example env file.
