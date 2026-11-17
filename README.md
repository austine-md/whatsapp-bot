# WhatsApp Business Platform app

A minimal Node.js and TypeScript app for Meta's WhatsApp Business Platform
Cloud API. The default responder sends one concise text reply to an inbound
message only when its text is exactly `hi`, `hello`, `hey`, or `good morning`
(case- and surrounding-punctuation-insensitive).

## Requirements

- Node.js 20.6 or newer
- npm
- A Meta developer app with the WhatsApp product

## Local setup

```sh
npm install
cp .env.example .env
```

Set the environment variables listed below in `.env`. Never commit `.env` or
share its values. Run the app locally with Node's env-file support:

```sh
node --env-file=.env --import tsx --watch src/server.ts
```

The server listens on `0.0.0.0` and uses `PORT` when set, otherwise port
`3000`. `GET /health` returns `200` with `{"status":"ok"}`. Run the checks with
`npm test` and `npm run build`.

## Meta test-number setup

1. In the [Meta for Developers](https://developers.facebook.com/) dashboard,
   create or select an app and add the WhatsApp product.
2. Open the WhatsApp API setup page and use its provided test business phone
   number and test access token.
3. Add and verify your own WhatsApp number as an allowed test recipient. Use
   the country code and number format requested by Meta.
4. Copy the test phone number ID, access token, app secret, and a real Graph API
   version into the environment. The `vXX.X` value in `.env.example` is only a
   placeholder.
5. Send `hi` or another supported exact greeting from the allowed recipient to
   the test number. The app replies through the Cloud API.

Test tokens can expire. Keep them out of source control, terminal recordings,
screenshots, and logs.

## Webhook subscription

Meta must be able to reach the callback over public HTTPS. For local testing,
use a trusted HTTPS tunnel and configure its URL with the `/webhook` path.

1. Set `VERIFY_TOKEN` in the server environment to a random value you choose.
2. In the Meta app's WhatsApp webhook configuration, enter the public
   `https://.../webhook` callback URL and the exact same verify token.
3. Complete Meta's verification challenge. The app returns `hub.challenge`
   only when `hub.mode=subscribe` and the token matches.
4. Subscribe the WhatsApp Business Account to the `messages` webhook field.
   Status-only updates are acknowledged but not processed.

The POST endpoint verifies `X-Hub-Signature-256` with `META_APP_SECRET` against
the raw request bytes before parsing JSON. Invalid signatures are rejected.
Valid notifications are acknowledged promptly; unique inbound text messages
are then handled asynchronously.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_TOKEN` | Bearer token used for the Graph API send request. |
| `PHONE_NUMBER_ID` | WhatsApp business phone number ID used in the messages endpoint. |
| `GRAPH_API_VERSION` | Graph API version, for example `vXX.X` with a current version substituted. |
| `VERIFY_TOKEN` | Secret value shared with Meta for GET subscription verification. |
| `META_APP_SECRET` | Meta app secret used to validate webhook signatures. |
| `WHATSAPP_GREETING_REPLY` | Optional concise reply; defaults to `Hello! How can I help?`. |
| `PORT` | Optional HTTP listen port; defaults to `3000`. |

For deployment, inject secrets through the platform's secret manager rather
than committing or baking `.env` into an image.

## Customer service window and messaging policy

The 24-hour customer service window starts or resets when the user messages
your business. During that window, free-form service replies are allowed.
Outside it, send only Meta-approved message templates, and only to recipients
who have opted in. Do not use free-form messages to initiate or resume a
conversation outside the window.

This app sends only an immediate greeting reply in response to an inbound text
message; it does not initiate conversations, queue delayed replies, or send
templates. Follow the current Meta policy and confirm a message is permitted
before adding other sending behavior.

## Deployment and production notes

- Terminate HTTPS at a trusted proxy/load balancer and preserve the original
  request body bytes. Do not parse, rewrite, or decompress webhook bodies before
  signature verification.
- Set a valid `GRAPH_API_VERSION`, protect and rotate credentials, and use
  Meta's production token and business phone number configuration.
- The default deduplication store is in-memory and scoped to one app process.
  It prevents duplicate message IDs from being handled twice during that
  process lifetime, but does not survive restarts or coordinate multiple
  replicas. Use a durable shared idempotency store before deploying multiple
  instances or if restart-safe deduplication is required.
- Keep operational logs privacy-preserving. Do not log access tokens, app
  secrets, verification tokens, phone numbers, full message bodies, raw webhook
  payloads, or authorization/signature headers. The app logs only generic
  processing failures or Graph API status codes.
- Status viewing, presence simulation, and View Once media access are
  intentionally not implemented.

## Troubleshooting

- **Meta verification fails:** check that `VERIFY_TOKEN` is set in the running
  process and exactly matches the value in Meta's webhook configuration.
- **POST returns 401:** check `META_APP_SECRET` and ensure any proxy forwards
  the original body unchanged. Do not compute the signature from parsed or
  re-serialized JSON.
- **POST returns 400:** inspect the payload shape locally without recording
  real message content; the endpoint requires valid WhatsApp webhook JSON.
- **No greeting reply:** confirm the event contains an inbound text message
  whose entire text is a supported greeting, that the sender is not the
  business number, and that `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, and
  `GRAPH_API_VERSION` are valid. Check Meta's token permissions and API error
  status without logging credentials or response bodies.
- **A test number cannot receive messages:** verify it is added as an allowed
  recipient in Meta's WhatsApp API setup and that the test token is current.
