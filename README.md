# WebBrain Codex Bridge

This is a hardened fork of [WebBrain](https://github.com/esokullu/webbrain) that
adds a local Codex/ChatGPT OAuth bridge for the Chrome extension.

The goal is simple: use WebBrain as a live Chrome browser agent while routing LLM
planning/tool decisions through local Codex tooling instead of a hosted WebBrain
Cloud account or separate OpenAI API key.

## What This Fork Changes

- Adds a local OpenAI-compatible bridge at `http://127.0.0.1:1455/v1`.
- Adds a default `Codex Local Bridge` provider for the Chrome extension.
- Supports a faster `acpx codex` backend with persistent ACP sessions.
- Keeps `codex exec` as a conservative fallback, especially for image/screenshot turns.
- Disables the WebBrain Cloud sign-in path in the Chrome settings UI.
- Removes the default WebBrain Cloud provider configuration.
- Narrows Chrome extension CSP network access from wildcard `connect-src *`.
- Removes redundant `http://*/*` host permission.

Most upstream WebBrain functionality is otherwise preserved: Ask/Act modes, page
reading, browser actions, multi-step tool loops, screenshot fallback, traces, and
multi-provider support.

## Quick Start

Install the local bridge dependencies:

```bash
npm install -g acpx
```

Make sure Codex is already authenticated on your machine:

```bash
codex --version
acpx codex sessions ensure
```

Start the bridge from the Chrome extension folder:

```bash
cd src/chrome
WEBBRAIN_CODEX_BACKEND=acpx WEBBRAIN_CODEX_VERBOSE=1 node scripts/codex-bridge.mjs
```

Load the Chrome extension:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `src/chrome`.

Recommended WebBrain settings:

```text
Provider / Codex Local Bridge
Base URL: http://127.0.0.1:1455/v1
Model:    gpt-5.3-codex-spark/low

Vision
Base URL: http://127.0.0.1:1455/v1
Model:    gpt-5.4-mini/low
API key:  leave empty
```

## Bridge Backends

The bridge is controlled with environment variables:

```bash
WEBBRAIN_CODEX_BACKEND=acpx
```

Uses `acpx codex` with a persistent ACP session. This is usually faster for
text/tool-planning turns.

```bash
WEBBRAIN_CODEX_BACKEND=cli
```

Uses `codex exec` directly. This is slower, but conservative and useful as a
fallback.

Useful options:

```bash
WEBBRAIN_CODEX_VERBOSE=1
WEBBRAIN_CODEX_PORT=1455
WEBBRAIN_CODEX_ACPX_MODEL=gpt-5.3-codex-spark/low
WEBBRAIN_CODEX_ACPX_TIMEOUT=60
WEBBRAIN_CODEX_ACPX_FALLBACK_TO_CLI=1
WEBBRAIN_CODEX_TIMEOUT_MS=180000
```

## Safety Notes

This fork is intended for source-loaded local use, ideally in a dedicated Chrome
profile.

WebBrain remains powerful by design. In Act mode it can read pages, inspect DOM
and accessibility data, take screenshots, click, type, navigate, interact with
frames, and use Chrome extension APIs. Do not run it unsupervised on important
accounts.

See [src/chrome/SAFETY_AUDIT.md](src/chrome/SAFETY_AUDIT.md) for the current
safety notes.

## What Is Not Included

- No Codex tokens are copied into the extension.
- No local Codex auth files are read by the Chrome extension.
- No hosted WebBrain Cloud login flow is used by default.
- No private local paths or credentials are required in the repository.

## Development Checks

```bash
node --check src/chrome/scripts/codex-bridge.mjs
node --check src/chrome/src/providers/manager.js
node --check src/chrome/src/ui/settings.js
jq empty src/chrome/manifest.json
```

Bridge health check:

```bash
curl http://127.0.0.1:1455/health
```

## Upstream

Original project: [esokullu/webbrain](https://github.com/esokullu/webbrain)

This fork currently focuses on the Chrome extension. Firefox and website files
may still reflect upstream WebBrain behavior unless explicitly changed.

## License

MIT. Original WebBrain was built by Emre Sokullu.
