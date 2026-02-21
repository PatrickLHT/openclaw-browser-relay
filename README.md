# OpenClaw Browser Relay (LHT Fork)

Chrome extension that bridges OpenClaw's Gateway to your browser tabs via a local CDP (Chrome DevTools Protocol) relay server.

Forked from the extension bundled with [OpenClaw](https://github.com/openclaw/openclaw) v0.1.0 to add connection stability improvements.

## Changes from Upstream

| Fix | Description |
|-----|-------------|
| Auto-reconnect | Exponential backoff reconnection (1s to 30s) when WebSocket drops |
| SW keepalive | `chrome.alarms` keepalive prevents MV3 service worker termination while tabs are attached |
| State persistence | Attached tab state persisted in `chrome.storage.session` — survives service worker restarts |
| Non-destructive disconnect | Debuggers stay attached during relay reconnection instead of being torn down |
| Double-fire fix | `ws.onerror` no longer triggers duplicate `onRelayClosed` calls |
| Health pings | Periodic pings detect dead connections and trigger reconnection |

## Install (Load Unpacked)

1. Clone this repo to a stable path:
   ```bash
   git clone https://github.com/PatrickLHT/openclaw-browser-relay.git ~/openclaw-browser-relay
   ```
2. Open Chrome/Arc/Brave and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned directory
5. Pin the extension in the toolbar

## Install (Replace OpenClaw's Built-in)

Copy the files over the built-in extension:
```bash
# Source (used by `openclaw browser extension install`)
cp background.js manifest.json /opt/homebrew/lib/node_modules/openclaw/assets/chrome-extension/

# Installed copy (what Chrome actually loads)
cp background.js manifest.json ~/.openclaw/browser/openclaw/user-data/Default/Extensions/ggelegohbnnkblhehacgpkgficpgmgki/0.1.0_0/
```

Then restart the OpenClaw browser or reload the extension.

## Usage

1. Ensure the OpenClaw Gateway is running with browser control enabled
2. Verify the relay server is reachable: `curl -s http://127.0.0.1:18792/`
3. Click the toolbar icon on any tab to attach/detach
4. Badge states:
   - **ON** (red) — attached and relaying
   - **...** (amber) — connecting or reconnecting
   - **!** (dark red) — relay not reachable
   - No badge — detached

## Options

- **Relay port**: defaults to `18792`. Change in the extension options page if your OpenClaw profile uses a different `cdpUrl` port.

## How It Works

The extension acts as a CDP relay bridge:
1. Connects to the local relay server via WebSocket (`ws://127.0.0.1:18792/extension`)
2. Attaches Chrome's Debugger API to the target tab
3. Forwards CDP commands from the Gateway to the tab, and events back
4. Handles tab lifecycle (`Target.createTarget`, `closeTarget`, `activateTarget`) and child session tracking

## Keeping Up with Upstream

`openclaw update` will overwrite the built-in extension. After updating OpenClaw, either:
- Re-run the "Replace OpenClaw's Built-in" install steps above, or
- Use the "Load Unpacked" method which is independent of OpenClaw updates
