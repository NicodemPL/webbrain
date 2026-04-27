# WebBrain Hardened Fork Safety Notes

This fork is for local, source-loaded use in a separate Chrome profile.

## What Was Removed Or Restricted

- Removed the default WebBrain Cloud provider configuration.
- Disabled the WebBrain Cloud account/auth UI path.
- Removed direct runtime references to the hosted WebBrain auth domain.
- Narrowed extension `connect-src` from `*` to localhost plus OpenAI, Anthropic, and OpenRouter.
- Removed redundant `http://*/*` host permission. The extension still needs `<all_urls>` to read and act on pages.

## Audit Findings

- No PostHog, Sentry, Mixpanel, Segment, Amplitude, Google Analytics, or `sendBeacon` usage was found in the Chrome extension source.
- The only network calls made by provider code are to configured LLM endpoints or localhost fallback proxying.
- WebBrain Cloud sign-in used `window.postMessage` to receive an auth token and store it in `chrome.storage.local`; that path is now disabled.
- Provider API keys, optional profile text, conversation state, and traces are still stored locally by Chrome extension storage APIs.
- The extension remains powerful by design: content scripts match `<all_urls>`, and Act mode can use CDP/debugger APIs to interact with real browser tabs.

## What Still Needs Care

- The extension can read page text and screenshots, click, type, navigate, use CDP, access cross-origin frames, and download/read files when Act mode tools are used.
- Profile auto-fill is stored in Chrome local storage as plaintext. Do not store important passwords there.
- Tracing is local IndexedDB only and off by default, but it can store LLM prompts, tool results, and screenshots if enabled.
- Any configured cloud LLM provider receives page/task context. Use a local provider or the Codex bridge when privacy matters.

## Codex CLI Bridge

The extension cannot call `codex` directly. Use the local bridge:

```bash
cd src/chrome
node scripts/codex-bridge.mjs
```

Then select `Codex Local Bridge` in WebBrain settings. The bridge calls:

```bash
codex exec --skip-git-repo-check --ephemeral --sandbox read-only
```

For faster text/tool-planning turns, run the bridge through ACP:

```bash
WEBBRAIN_CODEX_BACKEND=acpx node scripts/codex-bridge.mjs
```

In `acpx` mode the bridge calls `acpx codex` with a persistent ACP session and
defaults to `gpt-5.3-codex-spark/low`. Screenshot/image turns currently fall
back to `codex exec` if `acpx` rejects the image request.

Codex credentials remain in the normal Codex CLI auth location and are not copied into Chrome storage.
