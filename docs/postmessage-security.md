# PostMessage Security Configuration

Huey now validates trusted origins for postMessage requests and responses.

## Trusted Origins

Huey accepts incoming postMessage requests only from trusted origins.

Configure trusted origins via URL query string when embedding Huey:

- `postMessageOrigins=http://app.example.com,https://embed.example.com`
- `postMessageOrigin=https://app.example.com` (single origin convenience)

Notes:
- `window.location.origin` is always trusted.
- `document.referrer` origin is auto-added when available.

## Ready Message Behavior

`PostMessageInterface.sendReadyMessage()` sends to the hosting window only when a trusted target origin can be determined.

If no trusted hosting origin is available, Huey logs a warning and does not send the ready message.

## Session Cloner

Session clone messages are sent using `window.location.origin` as `targetOrigin`.
Wildcard (`*`) target origins are no longer used.
