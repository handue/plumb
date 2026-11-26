# Plumb

Plumb is a Chrome web app for property and field inspectors. It captures
findings where there is no signal, using Gemini Nano on the device, and turns
them into a clear report once the connection is back, using Gemini in the
cloud. Both tiers run through
[Firebase AI Logic](https://firebase.google.com/docs/ai-logic/hybrid) hybrid
inference.

> **Status: early scaffold.** The app currently ships a routing bench that
> proves the hybrid wiring. The capture, floor plan, sync and report screens
> are in progress.

## Why hybrid

An inspector walking through a basement or a stairwell often has no
connection, so anything that has to work during the walkthrough must run on
the device. Judging how serious a defect is, and writing it up clearly, is a
harder task that benefits from a larger model. Plumb splits the work along
that line:

| Step | Inference mode | Why |
|---|---|---|
| Structure a note into fields | `PREFER_ON_DEVICE` | Works with no network. Falls back to the cloud on machines without Gemini Nano. |
| Structure a note, device only | `ONLY_ON_DEVICE` | Never reaches the cloud, so it keeps working with the network off. |
| Polish wording and assign severity | `ONLY_IN_CLOUD` | A judgment call that waits for a connection instead of falling back to the small model. |

The app reads `response.inferenceSource` from the SDK and shows which tier
answered each call, with the latency measured in the browser.

## Requirements

- Chrome desktop 148 or later on Windows, macOS, Linux or Chromebook Plus.
  On-device inference needs about 22 GB of free disk space and either a GPU
  with more than 4 GB of VRAM or 16 GB of RAM with 4 or more cores. See
  Chrome's [built-in AI requirements](https://developer.chrome.com/docs/ai/get-started).
- Node.js 22.12 or later.
- A Firebase project with Firebase AI Logic enabled (Gemini Developer API)
  and App Check.

## Setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. In the [Firebase console](https://console.firebase.google.com/), create a
   project, open **AI Services > AI Logic**, choose the Gemini Developer API
   and register a web app.

3. Copy the example environment file and fill in the web app config.

   ```bash
   cp .env.example .env
   ```

4. Set `VITE_APPCHECK_DEBUG_TOKEN=true` in `.env`, start the dev server and
   open the page.

   ```bash
   npm run dev
   ```

   The DevTools console prints an App Check debug token. Register it under
   **Security > App Check > Apps > Manage debug tokens**. Treat the token as
   a secret: keep it in `.env` and never commit it.

5. Click **Prepare on-device model** once to download Gemini Nano.

For a hosted build, create a reCAPTCHA Enterprise key for your domain,
register it as the App Check provider and set
`VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`. The debug token is only read by the dev
server on localhost and is left out of production builds.

## Project layout

```
src/
  firebase.ts     Firebase app, App Check and the single getAI() call
  ai/models.ts    One model instance per routing decision
  ai/schema.ts    Shared JSON schemas, prompts and output validation
  ai/run.ts       Timed model calls that record which tier answered
  main.ts         Routing bench UI
```

## Limitations

- English input only.
- Chrome desktop only. Other browsers and mobile Chrome have no on-device
  model, so only the cloud path works there.
- The first use downloads the on-device model, which needs an unmetered
  connection.

## License

[Apache License 2.0](LICENSE)
