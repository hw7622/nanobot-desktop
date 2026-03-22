# Nanobot Desktop Handoff

## Repo

- Local: `D:\personal\code\nanobot-desktop`
- Main repo: `https://github.com/hw7622/nanobot-desktop`

## Current Status

- Desktop UI/config work is ongoing on top of release `0.1.1`.
- Core desktop/backend/runtime build chain is usable locally.
- A larger desktop UI architecture rewrite is now in place under `desktop/ui/`.
- This UI pass intentionally stays on the existing no-build static frontend (`index.html` + `app.js` + `styles.css`) instead of introducing a React/Tailwind toolchain, so local desktop startup stays stable.
- Latest local rebuild in this round completed for:
  - `desktop/dist/backend/nanobot-desktop-backend`
  - `desktop/dist/runtime/nanobot-runtime`
  - `desktop/src-tauri/target/debug/nanobot-desktop.exe`

## What Was Finished This Round

### UI / UX

- Latest pass focused only on the `AI 配置` page in `desktop/ui/`:
  - replaced the provider strip with a standard `AI 服务商` select
  - removed the extra explanatory copy from the page header and section headers
  - reduced the basic area to `默认模型` + `API Key` + `API Base`
  - converted advanced settings into a collapsed-by-default `<details>` panel
  - reduced advanced settings to:
    - model tuning: `上下文窗口` / `Max Tokens` / `Temperature`
    - tools: `推理强度` / `工具迭代上限`
    - environment/network: `工作区路径` / `仅允许访问工作区` / `Web 代理` / `额外请求头`
  - fixed the workspace-only checkbox sizing/alignment with a compact explicit checkbox style
  - kept provider switching live so the visible fields rerender immediately when the select changes
  - kept AI page scrolling on the normal page scroll only; no nested AI-specific scroller was added

- Dev startup console noise was reduced:
  - `desktop/src-tauri/tauri.conf.json` now uses `pythonw.exe` for `beforeDevCommand`
  - this is intended to stop the extra backend command window from appearing during local Tauri dev startup

- Follow-up AI settings polish:
  - replaced the small-hit-target advanced toggle with a full-width dark header button
  - the whole advanced header row is now clickable and shows hover feedback / pointer cursor
  - the right-side chevron now rotates with expand/collapse state
  - advanced content now opens with a smooth height/opacity slide transition
  - advanced fields are now grouped into:
    - `模型微调`
    - `网络与环境`
    - `开发者配置`
  - card styling on the AI page was tightened with lighter borders, softer shadows, and larger rounded corners
  - local verification after relaunch:
    - `nanobot-desktop` process running
    - `GET http://127.0.0.1:18791/api/bootstrap` -> `200`

- Larger layout redesign pass across config/catalog pages:
  - `AI 配置`, `渠道配置`, `MCP`, and `Skills` now all use a unified page shell with:
    - larger top hero block
    - compact status chips / summary stats
    - heavier card hierarchy instead of loose stacked panels
  - AI page:
    - provider selector now sits inside a dedicated side card with summary stats
    - page header now carries provider/model chips to avoid the earlier “single empty select floating alone” problem
  - Channel page:
    - redesigned hero with enabled counts
    - each channel card now has a badge block, meta strip, and stronger visual hierarchy
  - MCP / Skills pages:
    - redesigned hero area + actions
    - cards now include left icon tile, title block, status pill, and cleaner footer count/meta layout
    - empty states were simplified to shorter, more product-like copy

- Latest structure change after user feedback:
  - removed `聊天` and `MCP` from the left navigation
  - kept `chat` as an internal immersive page, but entry now lives on the dashboard via `进入聊天`
  - `打开配置文件` remains on the dashboard controls
  - `MCP` page is no longer reachable from the sidebar
  - `渠道配置` was simplified into one channel per block:
    - default collapsed
    - click header to expand
    - plain form fields inside
  - immersive chat page was tightened again:
    - session rail narrowed
    - session list height fixed instead of stretching adaptively

- Latest follow-up adjustments:
  - chat page now opens as immersive-only by default
  - removed the old enter/exit immersive button from the chat rail header
  - session list height was reduced further
  - channel configuration blocks were changed again to behave like simpler accordions:
    - one channel per block
    - plain form layout inside
    - forced block layout / auto row sizing to avoid the earlier non-Telegram expand issues
  - removed the top-level `新增 Skill` button from the Skills page

- Latest focused bug-fix pass:
  - channel configuration cards no longer use native `<details>` collapsing
  - channel expand/collapse is now controlled only by the card header button, so clicking blank space or inputs inside the expanded body no longer folds the card back up
  - chat immersive mode now hides the top title/status bar as well as the main sidebar, so entering chat feels like a dedicated full-page workspace instead of the normal shell with one panel hidden
  - chat session list height was reduced again from the prior compact size to a shorter fixed rail, closer to a two-line-per-item visible stack

- Follow-up polish after another user pass:
  - entering chat now forces a shell-frame refresh immediately, so the left main navigation hides as soon as the chat page is opened instead of waiting for a later render path
  - chat page rail header no longer renders the `?` help popover
  - the readonly compose helper sentence under external-channel sessions was removed
  - channel accordion headers were reduced again with tighter padding and a smaller badge tile
  - Windows open-target handling now uses `explorer.exe` directly:
    - folders open via Explorer instead of the older `os.startfile` path
    - config file opens in Explorer with selection, which should improve frontmost/focus behavior when the user triggers open-folder actions from the dashboard

- Hotfix after user got stuck in chat:
  - active immersive chat page now has a visible `返回主页面` button in the left rail header
  - the currently visible dashboard/chat status copy was normalized back to readable Chinese where mojibake had leaked into the UI

- Global mojibake cleanup:
  - `desktop/ui/app.js` visible copy was swept page-by-page and normalized for:
    - bootstrap / status / updater / gateway / open-folder error messages
    - dashboard cards and controls
    - AI page headings and provider picker labels
    - channels / skills / logs page headings and actions
    - session empty state / chat empty state / common dialog copy
  - old legacy page builders with corrupted text were collapsed back onto the current live page implementations so stale garbled templates no longer sit behind alternate code paths

- Desktop-specific layout hardening was added after the broader UI rewrite:
  - root shell remains viewport-locked with no app-level scroll
  - the right content area owns normal page scrolling
  - chat page keeps scrolling isolated to the session rail and message feed
- A later visual polish pass tightened page-specific desktop details:
  - Overview hero actions now behave like an even toolbar instead of loose wrapped buttons
  - chat back button now stays on one line with a directional icon
  - channel status text and toggle now share one aligned row
  - form textareas now span full grid width where appropriate to keep 2-column form alignment cleaner
  - runtime log actions now live inside a dedicated dark terminal header instead of floating above the log
  - MCP empty state icon was reduced / softened
  - Skills footer metadata now anchors to the bottom-right more cleanly
- A follow-up logic fix pass corrected several regressions:
  - runtime Gateway actions now have explicit busy-state feedback and error handling instead of silent async failures
  - direct backend verification for `POST /api/gateway/restart` returned success again during this round
  - Skills inventory now scans the configured workspace plus legacy desktop/dev nanobot skill directories and deduplicates results by resolved `SKILL.md`
  - Skills source labels are now localized to `内置` / `自定义`
  - the duplicate lower `builtin` pill was removed from skill cards
  - AI config was changed from side-by-side equal-height cards to a vertical stack to eliminate the large blank area under required fields
  - outer content scrolling was tightened further so page roots are fixed and scrolling is pushed into inner page/content regions
- Chat page interaction was tightened again:
  - session rail now has explicit stacking / pointer-event ownership
  - clicking a session updates the right pane immediately, then hydrates message history async
  - compose area is pinned as a non-shrinking footer to avoid horizontal overflow artifacts
- Long-text overflow handling was tightened across the desktop UI:
  - Overview resource paths now render full values with truncation + tooltip
  - Skills and MCP cards now protect card width with `min-width: 0` style equivalents and truncated mono path lines
  - conversation header/session rows now guard against long titles and subtitles stretching layout
- Overview / forms / cards / logs were tightened against the user-reported desktop bugs:
  - Overview action rows now use stronger horizontal alignment
  - AI inputs/selects were normalized to a single fixed height
  - channel card grid now uses equal-height rows
  - MCP empty state now fills and centers within the remaining page height
  - runtime terminal log now has a fixed inner height and scrolls internally instead of stretching the full page

- `desktop/ui/app.js` and `desktop/ui/styles.css` were restructured into a cleaner single-state frontend shell:
  - global `isMainNavVisible` state now controls the left main navigation
  - entering the chat page hides the main nav by default
  - chat page now supports an immersive mode that lets the session rail sit flush on the far left
- Chat page was rebuilt into a mainstream IM-style 2-column layout:
  - left session rail
  - right conversation pane
  - sticky conversation header
  - bubble-style message feed
  - bottom compose area
- Chat page noise was reduced again:
  - the session storage explanation is no longer always visible
  - it now lives behind a `?` popover in the session rail header
- Chat page scrolling was tightened again:
  - the page shell now hides outer chat overflow
  - the session list and message feed each own their own internal scroll area
  - this is intended to reduce the earlier “outer page scroll + inner chat scroll” behavior
- Runtime Control log panel now includes:
  - refresh
  - clear current view
  - copy
- The rewritten UI was relaunched locally through `cargo tauri dev --no-watch`, and the desktop backend served:
  - `/` -> `200`
  - `/styles.css` -> `200`
  - `/app.js` -> `200`
  - `/api/bootstrap` -> `200`
  - `/api/sessions` -> `200`
  - `/api/session?...` -> `200`

- Chat page layout was tightened:
  - left session column narrowed
  - right message area widened
  - chat page now uses a dedicated full-height layout path
- Chat page was further reshaped to feel more like a chat app:
  - after switching into the chat page, the session list now sits directly on the left side of the main workspace
  - the conversation pane now sits directly on the right side
  - the previous “big panel wrapped around another chat layout” structure was removed
- Global layout overflow was adjusted to reduce the “outer page scroll + inner chat scroll” problem.
- Chat page noisy copy was reduced:
  - removed the long Telegram session explanation from the always-visible area
  - replaced the session-storage explanation with a `?` popover
- “Auto launch on Windows startup” entry is now more visible:
  - still shown in Runtime page
  - also exposed in Overview page with direct action buttons
- Overview page now shows chat auto-refresh interval.

### Refresh / polling

- Chat polling path was kept and made more forceful:
  - interval refresh now explicitly calls `refreshVisibleData({ forceRender: true })`
  - content area now tags current tab via `data-tab` for tab-specific layout handling

### Startup behavior

- Tauri desktop app is now built with Windows GUI subsystem even in local debug builds:
  - this is intended to remove the empty console window when launching the desktop app directly
- Runtime PyInstaller build now uses `--noconsole`
  - this is intended to remove the blank console window from packaged runtime/gateway startup
- Desktop backend auto-start path now logs a warning if Gateway fails to stay alive after auto-start.
- Tauri dev startup is now pinned to Python 3.13 in `desktop/src-tauri/tauri.conf.json`
  - this avoids accidentally using system Python 3.10 with `pydantic 1.x`
  - `cargo tauri dev --no-watch` now reaches a running local desktop session again
- Tauri debug app no longer auto-spawns the packaged backend in dev mode
  - this avoids having two different backends listening on `127.0.0.1:18791`
  - local dev now relies only on `beforeDevCommand` for the Python desktop backend

### Version / meta

- Desktop backend now reads desktop version from `desktop/src-tauri/Cargo.toml` instead of hardcoding `0.1.0`.

## Important Root Cause Found

The user-reported “desktop startup did not auto-start Gateway” issue was at least partly caused by stale packaged artifacts.

What happened:

- UI code was new, but the desktop app was still launching older packaged backend/runtime binaries.
- After rebuilding `backend`, `runtime`, and the Tauri debug app together, startup chain behavior changed.

## Verified In This Round

### Static checks

- `node --check desktop\ui\app.js`
- `python -m py_compile desktop\backend\nanobot_desktop_backend\app.py desktop\backend\nanobot_desktop_backend\config_manager.py desktop\backend\nanobot_desktop_backend\schemas.py desktop\build_runtime.py desktop\build_backend.py`
- `cargo check` in `desktop\src-tauri`

All passed.

### Rebuilds completed

- `C:\Users\huwei\AppData\Local\Programs\Python\Python313\python.exe desktop\build_backend.py`
- `C:\Users\huwei\AppData\Local\Programs\Python\Python313\python.exe desktop\build_runtime.py`
- `cargo build` in `desktop\src-tauri`

### Runtime chain verified

After launching rebuilt desktop app, these processes were observed running together:

- `nanobot-desktop`
- `nanobot-desktop-backend`
- `nanobot-runtime`

This confirms that, in the rebuilt local desktop chain, Gateway auto-start is now working.

### Dev launch verified

- `cargo tauri dev --no-watch` now launches the desktop app without the earlier Python / pydantic mismatch.
- The chat page bootstrap path now reaches:
  - `GET /api/bootstrap` -> `200`
  - `GET /api/sessions` -> `200`
  - `GET /api/session?...` -> `200`
- `/favicon.ico` now returns `204` instead of polluting logs with `404`.

## Important Fixes After Relaunch Testing

- Desktop loading page no longer surfaces raw `Failed to fetch` during normal startup retries.
- Chat/session APIs now validate against a desktop-free config payload:
  - the desktop-only `desktop.*` block is stripped before feeding the core `nanobot.config.schema.Config`
  - this fixed the `extra_forbidden` validation error that previously broke session loading.
- Gateway startup now has a desktop-side preflight for AI provider readiness:
  - if the active provider/model is not actually usable yet, desktop does not hard-start Gateway anymore
  - bootstrap status now returns a user-facing `status.note` / `statusCode`
  - current common case is: missing API key for `openrouter`
- Desktop UI now surfaces that blocked-start reason in the header, Overview, and Runtime pages instead of leaving the user with raw CLI output only.
- Auto-start skip because of missing AI config is now logged as info, not as a misleading warning.
- Core config loader now strips the desktop-only `desktop` block before validating shared config files.
  - this fixes the case where Gateway rejected `config.json`, fell back to default config, and then incorrectly reported `No API key configured`
  - verified against `C:\Users\huwei\AppData\Local\NanobotDesktop\config.json`
  - after the fix, Gateway starts successfully with the existing `custom` provider config and Telegram connects again

## Still Needs Manual User Verification

These items were implemented or adjusted, but still need the user’s real interaction check:

1. Chat page scroll experience
   - confirm outer page scroll no longer fights inner chat scroll
   - confirm overall chat page feels shorter/tighter

2. Chat page width balance
   - confirm session list is narrow enough
   - confirm chat content area is wide enough

3. Auto-launch entry visibility
   - user previously said they could not find it
   - it now appears in both Overview and Runtime pages

4. Chat auto-refresh
   - user previously said it only refreshed after switching away and back
   - polling logic was tightened, but should be tested again in the rebuilt app

5. Blank console window on app start
   - likely fixed by:
     - Windows GUI subsystem for desktop app
     - `--noconsole` for runtime build
   - still needs real user confirmation

## Relevant Files

- `desktop/ui/app.js`
- `desktop/ui/styles.css`
- `desktop/ui/index.html`
- `desktop/backend/nanobot_desktop_backend/app.py`
- `desktop/backend/nanobot_desktop_backend/config_manager.py`
- `desktop/backend/nanobot_desktop_backend/gateway_manager.py`
- `desktop/backend/nanobot_desktop_backend/schemas.py`
- `desktop/build_backend.py`
- `desktop/build_runtime.py`
- `desktop/src-tauri/src/main.rs`

## Recommended Next Step

Launch the rebuilt local desktop app and have the user verify:

1. no blank console window
2. Gateway auto-starts on desktop launch
3. chat page auto-refresh works while staying on the page
4. chat page scroll/layout feels right
5. Windows auto-launch button is obvious and usable

If any of those still fail, continue from the rebuilt local state in this repo; do not trust older running binaries.

## 2026-03-22 Weixin Plugin Shell Integration

- Confirmed from the real desktop workspace session:
  - `telegram:1300030695` documents a standalone `nanobot-weixin-plugin`
  - the plugin already exposes login / bridge / account / send-media HTTP APIs on `127.0.0.1:31966`
  - this integration should stay in the desktop shell layer, not by modifying `nanobot` core
- Added a desktop-side plugin manager:
  - new file: `desktop/backend/nanobot_desktop_backend/weixin_manager.py`
  - detects plugin install state from `workspace/nanobot-weixin-plugin`
  - can start / stop the plugin API process with `node src/index.js api`
  - proxies login / bridge / account requests to the plugin API
  - reads local plugin state when the API is not running
- Rebuilt desktop backend schema metadata:
  - `desktop/backend/nanobot_desktop_backend/schemas.py` was rewritten cleanly
  - added `channels.weixin`
  - added shell-side fields for the standalone plugin:
    - `apiPort`
    - `baseUrl`
    - `pluginDir`
    - `autoStartApi`
    - `autoStartBridge`
  - also removed a large chunk of previous mojibake labels in schema metadata
- Rebuilt `desktop/backend/nanobot_desktop_backend/app.py` cleanly:
  - bootstrap now returns `weixin` status
  - added shell endpoints:
    - `GET /api/weixin/status`
    - `GET /api/weixin/account`
    - `GET /api/weixin/login/status`
    - `GET /api/weixin/bridge/status`
    - `POST /api/weixin/api/start`
    - `POST /api/weixin/api/stop`
    - `POST /api/weixin/login/start`
    - `POST /api/weixin/login/confirm`
    - `POST /api/weixin/bridge/start`
    - `POST /api/weixin/bridge/stop`
    - `POST /api/weixin/bridge/restart`
    - `POST /api/weixin/logout`
  - added `open` target for the plugin directory
  - session titles now render `weixin` as `微信`
  - desktop session fallback labels were cleaned to normal Chinese
  - added desktop bootstrap-side auto-start for:
    - weixin API
    - weixin bridge after login if `autoStartBridge` is enabled
- Reworked the channel configuration page in `desktop/ui/app.js`:
  - `微信` now has a dedicated special card instead of a generic form-only card
  - the card shows:
    - API running status
    - login status
    - bridge status
    - weixin session count
    - plugin directory
    - current logged-in weixin user id
    - context count
  - added actions:
    - start API
    - stop API
    - scan login
    - check login status
    - start bridge
    - stop bridge
    - refresh status
    - logout
    - open plugin directory
  - QR login state is tracked in the frontend and polled until confirmed / expired
  - QR content is rendered as a scannable image via a generated QR URL
- Updated `desktop/ui/styles.css` for the new weixin card layout:
  - status chips
  - action row
  - QR login panel
  - plugin/account meta grid
  - responsive collapse on narrower widths
- Small frontend cleanup bundled into the same pass:
  - header version separator changed from mojibake-style glyphs to `·`
  - chat page eyebrow labels were partially normalized to Chinese
  - role labels now use `·` instead of the earlier bad separator glyph

## Verification Completed

- `node --check desktop/ui/app.js`
- `python -m py_compile desktop/backend/nanobot_desktop_backend/app.py desktop/backend/nanobot_desktop_backend/schemas.py desktop/backend/nanobot_desktop_backend/weixin_manager.py`

## Still Needs Runtime Verification

- Desktop app relaunch with the new shell-side weixin integration
- Confirm the weixin card can:
  - start the plugin API
  - generate a QR code
  - poll until login confirmation
  - start the bridge after login
- Confirm the channel page reflects existing weixin sessions from:
  - `C:\Users\huwei\AppData\Local\NanobotDesktop\workspace\sessions\weixin_*.jsonl`

## 2026-03-22 Follow-up UX Fixes

- Weixin runtime controls were simplified again in `desktop/ui/app.js`:
  - removed separate manual `启动接口 / 停止接口 / 启动桥接 / 停止桥接` buttons
  - replaced them with two direct runtime toggles:
    - `微信接口`
    - `消息桥接`
  - toggling now immediately calls the shell-side API start/stop or bridge start/stop actions
- Channel page no longer participates in the generic polling re-render path:
  - removed `channels` from the `refreshRuntime()` auto-`renderBody()` tab list
  - this was done specifically to stop the channel page from jumping back to the top while the user is scrolling or editing
- Added page-level scroll position persistence in `desktop/ui/app.js`:
  - `.page-scroll` position is captured before same-tab rerenders
  - scroll is restored after rerender
  - this helps all page-frame based screens, including channels / AI / dashboard / skills / logs
- Chat page entry was tightened:
  - entering chat now renders immediately and then refreshes chat data
  - intended to make chat polling feel more stable instead of waiting on the async refresh path
- Scrollbars are now visually hidden while keeping scrolling enabled:
  - implemented in `desktop/ui/styles.css`
  - applied globally via hidden scrollbar rules
- Added matching responsive layout for the new weixin runtime toggle row in `desktop/ui/styles.css`

## Verification Completed After Follow-up

- `node --check desktop/ui/app.js`
- `python -m py_compile desktop/backend/nanobot_desktop_backend/app.py desktop/backend/nanobot_desktop_backend/schemas.py desktop/backend/nanobot_desktop_backend/weixin_manager.py`

## 2026-03-22 Weixin Card Simplification

- The weixin channel card was simplified again in `desktop/ui/app.js` to match the latest product requirement:
  - keep only one main channel toggle: `启用渠道`
  - remove user-facing runtime toggles for:
    - weixin API
    - weixin bridge
  - remove user-facing plugin config fields from the card body:
    - port
    - service/base URL
    - plugin directory
    - other shell-only fields
  - keep only:
    - channel enabled/disabled
    - scan login
    - logout
    - status chips
    - current logged-in weixin user
    - context count
- New channel-toggle behavior:
  - enabling `channels.weixin.enabled` now immediately starts the plugin API
  - if a login token already exists, enabling also starts the bridge automatically
  - disabling stops bridge + API, but does not forcibly delete the saved login
  - login confirmation now auto-starts the bridge whenever the weixin channel is enabled
- Desktop bootstrap behavior in `desktop/backend/nanobot_desktop_backend/app.py` was aligned with this:
  - startup now only checks `channels.weixin.enabled`
  - if enabled:
    - start plugin API
    - if already logged in, start bridge

## 2026-03-22 Weixin Bridge Stability Fix

- Root cause of `微信操作失败: {"ok":false,"error":"login_not_found"}` was confirmed to be plugin-side process instability, not shell-only state:
  - plugin login sessions were stored in-memory in `nanobot-weixin-plugin/src/api-server.js`
  - plugin API used to crash during bridge startup, which dropped the in-memory `loginId`
- External plugin fix was applied directly in:
  - `C:\Users\huwei\AppData\Local\NanobotDesktop\workspace\nanobot-weixin-plugin\src\api-server.js`
- Plugin-side changes:
  - replaced bridge child launch from `spawn(..., { shell: true })` to direct Node launch via `process.execPath`
  - fixed Windows plugin cwd resolution by switching to `fileURLToPath(import.meta.url)`
  - added child-process `error` / `close` handling so bridge startup failure no longer crashes the plugin API
  - bridge status now writes explicit `running / starting / stoppedAt / lastError / lastExitCode`
- Verified result after patch:
  - plugin API stays alive after `POST /api/weixin/bridge/start`
  - bridge now reaches running state with a live pid
  - desktop shell now reports `apiRunning: true`, `loggedIn: true`, `bridge.running: true`
- Shell-side cleanup in `desktop/ui/app.js`:
  - removed manual `检查登录状态` action from the weixin card
  - QR polling now handles `login_not_found` gracefully and asks for re-scan instead of surfacing the raw backend error
  - QR polling no longer throws raw transient errors back to the user during background polling
  - enabling weixin now avoids redundant `bridge/start` calls when the bridge is already running
- Local relaunch performed:
  - stale `cargo tauri dev` / `nanobot-desktop.exe` processes were cleaned up
  - a fresh hidden `cargo tauri dev --no-watch` instance was started
  - backend health and desktop shell were confirmed up again
