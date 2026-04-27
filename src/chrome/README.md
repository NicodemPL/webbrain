# WebBrain Chrome: Codex Local Bridge Fork

This Chrome extension is a hardened WebBrain fork configured to use a local
Codex bridge by default.

## Load The Extension

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `src/chrome`.

## Start The Bridge

From the repository root:

```bash
cd src/chrome
WEBBRAIN_CODEX_BACKEND=acpx WEBBRAIN_CODEX_VERBOSE=1 node scripts/codex-bridge.mjs
```

The bridge listens on:

```text
http://127.0.0.1:1455/v1
```

## Recommended Settings

Provider:

```text
Provider: Codex Local Bridge
Base URL: http://127.0.0.1:1455/v1
Model: gpt-5.3-codex-spark/low
API key: empty
```

Vision:

```text
Base URL: http://127.0.0.1:1455/v1
Model: gpt-5.4-mini/low
API key: empty
```

## Backend Modes

`WEBBRAIN_CODEX_BACKEND=acpx` uses `acpx codex` and a persistent ACP session.
This is the preferred fast path for text and browser tool planning.

`WEBBRAIN_CODEX_BACKEND=cli` uses `codex exec` directly. It is slower, but is
kept as a fallback and currently handles screenshot/image turns more reliably.

The default `acpx` mode falls back to `codex exec` when the ACP request fails.

## Safety Notes

WebBrain acts inside your real browser. In Act mode it can click, type, navigate,
read page state, inspect frames, take screenshots, and use Chrome extension APIs.
Use a dedicated Chrome profile for testing and avoid storing important passwords
in the profile auto-fill text.

See `SAFETY_AUDIT.md` for the detailed notes.
