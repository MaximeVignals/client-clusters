# Desktop workspace design

Client Clusters keeps Electron, vanilla JavaScript, Leaflet and the existing file/data infrastructure. This modernization adds no runtime dependency and leaves clustering, planning, import/export, backups and integrations in their existing modules.

## Presentation architecture

- `src/renderer/styles.css`: feature-specific components for visits, opening hours, prospects, map markers and import previews.
- `src/renderer/desktop.css`: shared semantic tokens, desktop shell, component treatments, themes, responsive rules, reduced-motion and high-contrast adaptations. Tokens cover canvas/chrome/surfaces, primary/secondary text, separators, accent and visit states. Segoe UI Variable uses the existing system font stack; controls use compact 28–32 logical-pixel heights, 6–10 pixel corners and restrained hover transitions.
- `src/renderer/appearance.js`: applies system/light/dark appearance before first paint. The preference stays in local storage, outside client records and backups, and follows system changes when set to System.
- `src/renderer/desktop-ui.js`: navigation, pane resizing, keyboard access, contextual actions, dynamic accessible labels, modal focus containment and map size observation. The small hooks in `app.js` refresh the shell and reveal selected clients in compact mode.

The native Windows frame and its move, resize, snap and maximize controls are retained. Opaque layered surfaces keep dense forms and map labels readable without expensive desktop blur effects.

## Adaptive layout

- Wide windows use a navigation rail, resizable client pane and map. At 1500 logical pixels and above, the client inspector docks beside the map rather than covering it.
- Below 1200 pixels the rail becomes compact. Search and sorting retain their own rows and never compete with navigation.
- Below 900 pixels navigation becomes horizontal and List / Map & details switches expose full-width working surfaces. Selecting a client reveals its inspector; choosing a workspace tab returns to the list.
- The client pane supports pointer dragging and keyboard resizing with Left/Right, Home and End. Its width is remembered locally and constrained to leave room for the map.
- Lists, inspectors and dialog bodies scroll independently. Dialog actions remain outside their scrolling body. Small windows reserve useful list height while allowing attention banners to scroll.
- The initial native window is limited to the primary display's available work area. The normal minimum is 640 × 480; Electron/Chromium retains native DPI handling. A ResizeObserver updates Leaflet when pane, viewport or inspector dimensions change.

## Desktop input

Ctrl+F searches, Ctrl+O imports, Ctrl+N adds a client, Ctrl+Shift+P opens day planning, and Ctrl+1–4 switches workspaces. Existing Escape behavior, Ctrl+click map selection and Shift+drag selection remain available. Tabs support arrows and Home/End; menus support arrows, Home/End and Escape. Client and group rows have contextual actions. Dialogs trap Tab, disable background interaction, announce their titles and restore focus when closed. Tooltips and the Keyboard shortcuts dialog expose these interactions.

## Validation

Run `npm test` for core/main-process regression coverage and `npm run test:smoke` for the real sandboxed renderer with isolated offline demo data. `npm run test:ui` extends this to six viewport sizes (640 × 480 through 2560 × 1080), both themes and Chromium device-scale factors 1, 1.25, 1.5, 1.75 and 2. The suite asserts the actual devicePixelRatio, checks all workspace lists, inspector/map bounds, dialog bounds and keyboard behavior, and writes local previews under `.test-tmp/ui/`.

Device-scale emulation checks renderer layout and rasterization. It does not certify physical mixed-DPI monitor transitions, Windows Snap/maximize interaction, a screen reader, live network services or native file pickers. Those require a manual Windows pass. Tests use neutral offline map tiles, not real cartography or private client data.

API references used for the implementation: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [Electron screen](https://www.electronjs.org/docs/latest/api/screen), [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html), and [Chromium device metrics](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride).
