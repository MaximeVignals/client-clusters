# Changelog

## 1.9.2 — 2026-11-09

### Added

- Recovery screen: when the data file can't be read at startup, the app offers the readable daily backups (date, clients and visits), a backup file, or an empty start. Nothing is saved until you choose, and a “Recover…” banner stays visible if the dialog is closed.

### Fixed

- A damaged data file is copied to the backups folder before anything can replace it, and the daily backup no longer copies a damaged file over the good ones.
- “Locate this address again” keeps a pin placed by hand or read from a file when the address isn't found.
- A client added by hand is saved before the address search, not after it.
- Addresses found just before closing the app are written to the address cache.
- Cancelling a confirmation shown over another dialog brings that dialog back exactly as it was (in Restore, the password and the Combine / Replace choice were reset).
- A dialog that was closed can no longer change or close the next one when a slow search answers late.
- Town names with special characters no longer break a row of the groups list.
- A postal code containing punctuation no longer stops the Google page matching.
- A damaged shape in a prospecting file is skipped instead of stopping the map.
- Very long sheets can be imported.
- Google Maps links are accepted from Google addresses only.
- Map and address requests identify the app with its real version.

### Compatibility and validation

- No change to data, file formats or backups. No data migration is required.
- Windows packages still use Electron 44.10.1, so the update ZIP works on 1.9.0 and 1.9.1 folder installations.
- Validation: 18 core/main-process tests and the Electron smoke and UI suites.

## 1.9.1 — 2026-11-04

### Improved

- Code reorganised into smaller modules: the interface is split into one script per area (map, lists, day planner, client details, Google pages, import, export, backups…) and the main process into `src/main/` (files, geocoding, Google pages, backups).
- Duplicate code removed: one shared distance calculation and text normaliser, and unused helpers dropped.

### Compatibility and validation

- No change to features, data, file formats or backups. No data migration is required.
- Windows packages still use Electron 44.10.1, so the update ZIP works on 1.9.0 folder installations.
- Validation: 12 core/main-process tests, the Electron smoke and UI suites, and a launch of the packaged app with demo data on an isolated profile.

## 1.9.0 — 2026-11-03

### Added

- A modern desktop workspace with navigation for Groups, Clients, Planned visits and Prospects.
- Light, dark and system appearance, remembered on this device and applied before the first render.
- A resizable client pane with mouse and keyboard controls and a locally remembered width.
- Full-width List / Map & details views for compact windows, with automatic detail reveal when selecting a client.
- A docked client inspector on wide windows, leaving the map visible beside it.
- Client and group context menus for planning, logging visits, routes and other common actions.
- Keyboard shortcuts: Ctrl+F to search, Ctrl+O to import, Ctrl+N to add a client, Ctrl+Shift+P to plan a day and Ctrl+1–4 to switch workspaces.
- A keyboard shortcuts reference, accessible dialog titles and form labels, tab/menu keyboard navigation, modal focus containment and focus restoration.
- A repeatable Electron UI validation suite with six viewport sizes, both themes and five emulated device scales from 100% to 200%.

### Improved

- Consistent typography, spacing, semantic colors, controls, cards, visit statuses, dialogs and interactive states across the interface.
- Separate navigation, search and sorting areas, a persistent day-planning action and clearer client summaries.
- First-run guidance, tooltips, notification presentation, reduced-motion handling and high-contrast adaptations.
- Window sizing down to a normal minimum of 640 × 480, with initial bounds limited to the display work area.
- Map sizing after pane changes and inspector docking, with an adaptive pan offset when selecting clients.

### Fixed

- Crowded navigation and sorting controls at narrow widths.
- Insufficient list space in compact windows.
- Wide import, day-planning and address-review dialogs extending beyond small windows.
- Dialog actions becoming difficult to reach when the content needs to scroll.

### Compatibility and validation

- Keeps Electron, vanilla JavaScript, Leaflet and existing dependencies. No new runtime framework or dependency.
- Preserves client and prospect data, visit history, clustering, planning, file formats, backups and integrations. No data migration is required.
- Appearance and pane-width preferences stay local and are not added to client records or backups.
- Windows packages use Electron 44.10.1. The update-only ZIP requires a folder installation using the same Electron version; other installations should use the full archive.
- Validation: 12 core/main-process regression tests and 330 Electron smoke/UI checks across the five emulated device scales. Rendered previews were reviewed in light and dark mode.
- Physical mixed-DPI monitor moves, Windows Snap/maximize interaction, native file dialogs, screen readers and live integrations still require manual validation.

[Full Windows package](https://github.com/MaximeVignals/client-clusters/releases/download/v1.9.0/ClientClusters-1.9.0-win-x64.7z) · [Update ZIP](https://github.com/MaximeVignals/client-clusters/releases/download/v1.9.0/ClientClusters-1.9.0-update.zip)
