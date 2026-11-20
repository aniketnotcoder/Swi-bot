# Storelex Swiggy PRO API client

The bot repository now has a secret-safe HTTP client in `storelex-api.js` for the documented Storelex API. It sends `x-user-key` only as a request header, uses HTTPS, caps requests at 60 seconds, and does not log request headers or bodies.

## Configuration

Set these only in the host's secret environment (never in source control, Telegram, or a checked-in `.env`):

- `STORELEX_API_BASE_URL=https://storelex.store/swiggy_web/api`
- `STORELEX_USER_KEY=<new rotated key>`

The key that was pasted into chat should be revoked/rotated before any live use. Do not call `/auth/validate_key/{key}` from application code; use an authenticated `/me` request so the key is not placed in a URL.

## Current integration status

The HTTP client and mock tests are implemented. Existing Telegram chat/order handlers have **not** been switched to Storelex yet, and no live Storelex calls or real order/payment flows have been tested. Do not set the key and assume the existing flow now uses the remote backend.

## Fixed Hindi voice replies

Private customer text replies, edited cards and media captions are paired with pre-generated Hindi voice clips in `assets/voice/`; no TTS key or third-party speech request is needed at runtime. The same selected voice is used for channel join, link request, bill, QR, payment pending, tracking and a generic update. `/voice` toggles a mildly stern bill reminder; it stays respectful. Exact amounts, addresses, OTPs, UPI identifiers and tracking URLs remain in the chat text rather than being spoken. The channel membership gate runs before customer handlers, so an unjoined user first hears the channel-join prompt. Existing English text is not auto-translated; the audio clips themselves are Hindi/Hinglish.

Before routing live cart/checkout actions, obtain sanitized sample JSON (redact mobile numbers, address text, IDs, and any tokens while keeping field names/types) for:

1. `POST /cart/address_by_link`
2. `POST /cart/import_group`
3. `POST /search/cart` using the imported response
4. `POST /checkout/place` request and both UPI / payment-pending responses

These shapes determine safe mapping of the real restaurant, item variants/add-ons, cart id, address and payable amount. The bot must not guess those fields or display/place an unverified bill.

The Storelex API would own Swiggy sessions and order operations. The Telegram bot process still needs a host to receive Telegram updates; an API key alone does not deploy that process onto the Storelex server.
