# Popup window opens off-center (multi-monitor, mixed DPI)

## Status: investigating

## Symptom

The tray popup window sometimes opens visibly off-center. Toggling something that
triggers a resize (e.g. opening the settings panel) snaps it back to the correct
centered position.

## Where the logging lives

`log_debug` in [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) mirrors every debug
line to stderr (`tauri dev`) and to the frontend via a `debug-log` event, so it's
visible in release/MSI builds too (no attached console there). Marked `TEMPORARY —
remove once the off-center bug report is resolved`.

- `[show]` — logged in `show_main_window`: cursor position, the monitor under the
  cursor, that monitor's work area, monitor/window scale factors, current
  `outer_size`, and the computed `target` position — then a second `[show] after
  show()` line with the actual `outer_pos`/`outer_size` once `show()` returns.
- `[resize]` — logged in the `resize_and_center` command: requested logical
  size, `window_scale_before`/`window_scale_after` (scale factor read before and
  after `set_size()` + `center()`), and the resulting `outer_pos`/`outer_size`.

The frontend's debug panel (`TranslatePage.tsx`) collects these `debug-log`
events into an in-app buffer capped at 500 lines, so they can be copied out of
a release/MSI build. It's now (2026-08-11) persisted to `localStorage`, not
just React state — see the 2026-08-11 entry below for why.

## Progress log

### 2026-08-11 — ruled out `show_main_window`'s cursor-based centering

Reviewed a log spanning several open/resize cycles across two monitors
(DISPLAY1 @ 100%, DISPLAY2 seen at 100%/125%/150% scale at different times).

All three `[show]` events in the log had `target == outer_pos` after `show()`:

```
09:33:54 target=(759,337) → after show() (759,337)
09:58:54 target=(658,248) → after show() (658,248)
11:06:04 target=(759,286) → after show() (759,286)
```

So the cursor-based centering path in `show_main_window` is not the source of
the bug — every logged show landed exactly where it computed.

**Found instead, in the `[resize]` entries:** after a monitor/DPI change,
`outer_size` doesn't match `requested × window_scale_after` — it matches
`requested × window_scale_before`:

```
09:49:49.777 requested=401x355 scale_before=1.0 scale_after=1.5 outer_pos=(759,326) outer_size=401x355
   expected ~601x532 (401x355 × 1.5) if the window really landed on the 1.5 monitor — got 401x355 instead

09:50:19.498 requested=402x357 scale_before=1.5 scale_after=1.0 outer_pos=(658,248) outer_size=603x536
   603x536 = 402x357 × 1.5 (the OLD scale) — should be 402x357 if it landed on the 1.0 monitor
```

**Hypothesis:** `resize_and_center` ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs),
`resize_and_center` command) calls `set_size(LogicalSize)` using the scale
factor in effect *before* the resize, then `center()` can move the window onto
a monitor with a *different* DPI. The physical pixel size committed by
`set_size()` is never reconverted for the monitor the window actually ends up
on, so the window is the wrong physical size for its new monitor — which is
very likely what reads visually as "off center," even though the `center()`
call itself is internally consistent with the (wrong) size it was given.

This matches the reported symptom: it opens visibly wrong, then a later
`resize_and_center` call — once the DPI has settled and scale factor is
stable — recomputes correctly and "snaps" to center.

**Not yet done:** implement/verify a fix (e.g. re-check `scale_factor()` after
`center()` and re-`set_size` if it changed), reproduce on the real multi-monitor
mixed-DPI rig to confirm, then remove the temporary logging.

### 2026-08-11 — debug log was in-memory only; enriched logging to isolate the fix

User reported the in-app debug log appeared to clear when opening Settings to
copy it out. Checked `TranslatePage.tsx`: `debugLogs` was plain `useState`
with no `localStorage` backing, and the popup hides rather than unmounts on a
normal close ([lib.rs](../src-tauri/src/lib.rs) intercepts `CloseRequested`
and just hides), so the buffer should normally survive across show/hide
cycles for the life of the process. Opening Settings itself doesn't touch
`debugLogs` in code (only an explicit "Clear" button does, `setDebugLogs([])`).

That raised a real possibility, and it ties directly into the centering bug:
if a DPI/monitor change (which is exactly what's happening during these
off-center incidents) causes the WebView2 surface to reload, the whole React
tree remounts and any non-persisted state — including `debugLogs` — silently
resets to empty. That would explain both symptoms at once: the window
"snapping to center" (a fresh `show_main_window`-style layout) and the debug
log appearing to clear, from a single underlying event.

Changes made (no fix yet — instrumentation only, to catch it next time):

- **`debugLogs` now persists to `localStorage`** (`tp_debug_logs`, still
  capped at 500 lines) so a remount no longer loses history — see
  `appendDebugLog` in `TranslatePage.tsx`.
- **`[frontend] mounted` marker** pushed once per component mount. If this
  line repeats in the persisted log without a new backend `[boot]` line also
  appearing, that's direct proof the webview remounted while the Rust
  process kept running (as opposed to the whole app relaunching, or the user
  just perceiving a clear that didn't happen).
- **`[boot] pid=... started_at=...`** logged once in Rust `setup()` — one per
  actual process launch, the counterpart to the marker above.
- **`[event] ScaleFactorChanged / Moved / Resized`** — raw OS-driven window
  events, logged independently of our own `resize_and_center`/
  `show_main_window` calls (`on_window_event` in `lib.rs`). These catch
  anything Windows does to the window on its own (e.g. between our
  `set_position()` call and our own read-back of `outer_position()`) that our
  existing logging would never see.
- **`resize_and_center` now logs monitor identity, not just scale factor**,
  at three points: before the call, right after `set_size()` (still on the
  old monitor), and right after `center()` (possibly a new monitor) — plus
  the pre-call `outer_pos`/`outer_size`. This directly tests the "landed on a
  different-DPI monitor than the size was computed for" hypothesis instead of
  inferring it from scale-factor numbers alone.

**Not yet done:** reproduce the off-center-on-open case again with this
build, correlate the `[frontend] mounted`/`[boot]` markers to confirm or rule
out the reload theory, and check whether `[event] ScaleFactorChanged/Moved`
fires between a `[show]` and the next `[resize]` on a bad open.
