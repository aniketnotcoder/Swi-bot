# Swiggy PRO master architecture and delivery map

## Evidence reviewed

- Supplied `storexapi.txt` (142 lines) documents the Storelex endpoints, key-per-user identity, Telegram WebApp initData, mobile sessions, addresses, restaurant/menu, cart repricing, checkout and wallet fee. It does not give complete response schemas for all payment/mutation variants or an admin user-management API.
- Existing repo: `storelex-api.js` is the HTTP client; `storelex-bot.js` is the running polling bot; `storelex-mini-service.js` supports Telegram-initData owner requests and standalone key sessions; `storelex-mini.js` is a shared UI; `storelex-mini-db.js` stores SQLite scratch data. `index.js` and the old mini app are retained but are **not** the `npm start` runtime. `render.yaml` expects one Render web service; old worker must be stopped.
- A previously disclosed API key must be rotated. No key or bot token is copied to repository files.

## Trust boundaries

1. Browser/Mini App never receives a configured owner key. All Storelex calls happen server-side with `x-user-key`; only known paths are exposed. Never put a key in `/auth/validate_key/{key}` URLs: authenticated `/me` is a safer live key check.
2. Telegram Mini App: verify `initData` HMAC, age and identity server-side. The current implementation only allows `BOSS_ID`/`BOSS_IDS`; before broadening, account keys must be assigned per verified user, not one owner's key shared with everyone.
3. Standalone website: Telegram initData does not exist. It needs a separate HTTPS key-login flow that validates a user's own Storelex key server-side (via `/me`), gives an HttpOnly SameSite session cookie, uses CSRF protection and does not persist plaintext credentials. An owner key must not become a public default.
4. Owner role: explicit numeric Telegram ID allowlist and a separately authenticated web owner session. Storelex `/me.is_owner` describes *upstream* permission, not this app's owner role. Admin actions without documented upstream endpoints (maintenance edit, service fee edit, user/key management) are **not implemented** or claimed to work.
5. SQLite: per-user selected mobile/address/cart and a one-attempt placement journal. Durable disk and a single instance are needed. Without it, uncertainty must not be retried as a new order.
6. Destructive account endpoints (`DELETE /accounts/{mobile}`, `POST /accounts/remove_all`, `/delete/start`, `/delete/confirm`) are **denylisted for every user including owner** at application routing. This protects only our application routes; an upstream keyholder can still call the upstream API directly.

## API feature map

| Area | Documented upstream operations | Current app status / next work |
|---|---|---|
| Identity | `/me`, `/maintenance`, `/auth/validate_webapp`, key validation | Owner-only Telegram gate and in-memory standalone web sessions exist. Per-user Telegram key ownership is still needed. |
| Accounts | `/sessions`, `/profile/{mobile}`, export, check FC, mark used/fresh, login key | Account-scoped data exists. Mark used/fresh and key-login permissions need UI and tests. Account removal forbidden. |
| Add account | check mobile, send OTP, verify OTP; import JSON; login by key | Not yet in new Mini App. Require per-user key and short-lived server-only OTP state. Never log OTP/session JSON. |
| Address | list, add, add link, delete address, geo search/details/reverse | Existing Mini App supports these; address delete is NOT account delete. Filter by selected mobile. |
| Food | search restaurants/menu/menu search/outlets; cart state, group import, `/search/cart` | Existing owner Mini App supports basic flow, but variant/add-on UX is raw JSON, not production-grade. |
| Offers | coupons/best/apply/remove, FC, breakfast/night claims | Coupon flow exists; deals need consent and actual readback before claiming savings. |
| Checkout | payment options, one status, place, payment status/confirm/order status | Owner-only flow/journal exists, with bounded same-ID retry. Must prove real status/amount variants before public checkout. |
| Orders | `/orders/{mobile}`, detail, rating | Account-scoped UI exists; distinguish QR from paid confirmed order. |
| Wallet | `/me` balance/fee | Read-only display safe. Upstream fee configuration and deposits are undocumented: no fake edit buttons. |
| Owner | stats via sessions/orders, health, local audit | Read-only aggregates and app-side audit/diagnostics possible. No upstream admin mutation endpoints documented. |

## UX plan

- Bot: one editable menu card per owner/user journey with Home, Accounts, Addresses, Order Food, Cart, Offers, Orders, Wallet, Settings and Help/Support; callbacks must enforce role and state. OTP and card/checkout actions get explicit confirmations, no phantom success.
- Mini App + website: shared server API, mobile-first dashboard, scoped pages, clear bill/pay gates, real empty/loading/error states; light/dark themes on the standalone experience. Light/dark theme controls now exist, but visual QA and accessibility validation are still needed.
- Destructive controls: no account deletion buttons/routes anywhere, including owner. Address deletion remains allowed but explicit.

## Delivery phases and acceptance gates

1. **Now:** remove account-deletion entry points, add regression tests, document architecture, strengthen authorization/error boundaries. This can be tested offline.
2. Per-user identity + web sessions: implement Telegram key mapping and standalone key-login with secure cookies, CSRF, rate limits and encrypted state. Test cross-user isolation, signature replay and unauthorized access.
3. Conversational bot navigation and OTP/key/JSON workflows: mocked upstream contract tests, callback state and permissions.
4. Unified responsive website and Mini App: production UI, selected-account restaurant/menu/cart variants, accessible forms, live error states and tests.
5. Owner read-only console: real aggregates and local audit/health; admin mutations only if owner API becomes documented and authorized.
6. Checkout/polling/durability: mock all payment outcomes, reject mismatched bills and unknown state. Live test ONLY with consented owner account and non-sensitive test order. No real E2E or admin permission claim without live credentials and hosting access.

## Deployment/testing notes

Run the documented focused suites with `node --test`; never assume mock tests prove live Swiggy/Storelex payment. Stop any older Telegram poller sharing `BOT_TOKEN`. Host must provide a private persistent disk for SQLite and operator-owned secrets. Vercel serverless is not suitable for this polling runtime without an architectural split.
