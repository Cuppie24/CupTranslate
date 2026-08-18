use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const DEFAULT_HOTKEY: &str = "Ctrl+Shift+Space";

fn first_string(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    value.as_array()?.first()?.as_str().map(|s| s.to_string())
}

#[derive(Serialize)]
pub struct DetectResult {
    pub language: String,
    pub confidence: Option<f64>,
}

#[tauri::command]
async fn detect_language(text: String, api_key: String) -> Result<DetectResult, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "q": text });

    let response = client
        .post("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect")
        .header("x-rapidapi-host", "deep-translate1.p.rapidapi.com")
        .header("x-rapidapi-key", &api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(error_obj) = json.get("error") {
        let msg = error_obj["errors"][0]["message"]
            .as_str()
            .or_else(|| error_obj["message"].as_str())
            .unwrap_or("Unknown API error");
        return Err(format!("API error: {}", msg));
    }

    if !status.is_success() {
        return Err(format!("API error {}: {}", status.as_u16(), json));
    }

    // detections has been observed as a flat array of objects; defend against
    // a nested array (Google's real API batches this way) just in case
    let detections = &json["data"]["detections"];
    let first = detections.get(0).unwrap_or(detections);
    let detection = if first.is_array() { first.get(0).unwrap_or(first) } else { first };

    let language = detection["language"]
        .as_str()
        .ok_or_else(|| format!("Unexpected response: missing language — raw: {}", json))?
        .to_string();

    let confidence = detection["confidence"].as_f64();

    Ok(DetectResult { language, confidence })
}

#[derive(Serialize)]
pub struct TranslateResult {
    pub translated_text: String,
    pub detected_language: Option<String>,
}

#[tauri::command]
async fn translate(
    text: String,
    source: String,
    target: String,
    api_key: String,
) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // the underlying Google-Translate-compatible API rejects the literal
    // string "auto" as a source language code — omit the field entirely to
    // request auto-detection instead
    let mut body = serde_json::json!({
        "q": text,
        "target": target,
    });
    if source != "auto" && !source.is_empty() {
        body["source"] = serde_json::Value::String(source);
    }

    let response = client
        .post("https://deep-translate1.p.rapidapi.com/language/translate/v2")
        .header("x-rapidapi-host", "deep-translate1.p.rapidapi.com")
        .header("x-rapidapi-key", &api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // some failures come back as HTTP 200 with the error embedded in the body
    if let Some(error_obj) = json.get("error") {
        let msg = error_obj["errors"][0]["message"]
            .as_str()
            .or_else(|| error_obj["message"].as_str())
            .unwrap_or("Unknown API error");
        return Err(format!("API error: {}", msg));
    }

    if !status.is_success() {
        return Err(format!("API error {}: {}", status.as_u16(), json));
    }

    // translations can come back as a single object or an array of objects,
    // and translatedText/detectedSourceLanguage can each be a plain string or
    // a single-element array — this API is inconsistent about it, so accept
    // either shape at both levels
    let translations = &json["data"]["translations"];
    let translation = translations.get(0).unwrap_or(translations);

    let translated_text = first_string(&translation["translatedText"])
        .ok_or_else(|| format!("Unexpected response: missing translatedText — raw: {}", json))?;

    let detected_language = first_string(&translation["detectedSourceLanguage"]);

    Ok(TranslateResult {
        translated_text,
        detected_language,
    })
}

#[derive(Serialize)]
pub struct LanguageInfo {
    pub language: String,
    pub name: String,
}

#[tauri::command]
async fn get_languages(api_key: String) -> Result<Vec<LanguageInfo>, String> {
    let client = reqwest::Client::new();

    let response = client
        .get("https://deep-translate1.p.rapidapi.com/language/translate/v2/languages")
        .header("x-rapidapi-host", "deep-translate1.p.rapidapi.com")
        .header("x-rapidapi-key", &api_key)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !status.is_success() {
        let msg = json["message"]
            .as_str()
            .unwrap_or("Unknown API error")
            .to_string();
        return Err(format!("API error {}: {}", status.as_u16(), msg));
    }

    // deep-translate1 wraps most responses in a top-level "data" object, but
    // the languages endpoint has been observed to also return it unwrapped —
    // accept either shape.
    let languages_arr = json["data"]["languages"]
        .as_array()
        .or_else(|| json["languages"].as_array())
        .ok_or("Unexpected response: missing languages array")?;

    let languages = languages_arr
        .iter()
        .filter_map(|l| {
            Some(LanguageInfo {
                language: l["language"].as_str()?.to_string(),
                name: l["name"].as_str()?.to_string(),
            })
        })
        .collect();

    Ok(languages)
}

fn monitor_name(window: &tauri::WebviewWindow) -> String {
    window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_else(|| "?".to_string())
}

// resizes and re-centers in one native call so the frontend never has to
// derive "center" from the window's own current (potentially already
// rounding-drifted) position — center() always recomputes fresh from the
// monitor's absolute bounds, so nothing can accumulate across repeated calls
#[tauri::command]
fn resize_and_center(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale_before = window.scale_factor();
    let monitor_before = monitor_name(&window);
    let pos_before = window.outer_position().ok();
    let size_before = window.outer_size().ok();

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // scale/monitor right after set_size, BEFORE center() runs — isolates
    // whether set_size() alone (still on the old monitor) or center()
    // (which can hop monitors) is where a scale mismatch is introduced
    let scale_after_set_size = window.scale_factor();
    let monitor_after_set_size = monitor_name(&window);

    window.center().map_err(|e| e.to_string())?;
    let mut scale_after_center = window.scale_factor();
    let mut monitor_after_center = monitor_name(&window);

    // center() can land the window on a monitor with a different DPI than the
    // one set_size() used to compute the physical pixel size — that physical
    // size is never reconverted, so the window ends up the wrong size for its
    // new monitor (confirmed via [resize]/[event] logs, see
    // docs/window-centering-bug.md). Redo set_size()+center() once with the
    // now-current scale if it changed; the second set_size() commits physical
    // pixels using the correct (post-hop) scale, and re-centering keeps it
    // aligned on that same monitor.
    if scale_after_set_size.as_ref().ok().copied() != scale_after_center.as_ref().ok().copied() {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window.center().map_err(|e| e.to_string())?;
        scale_after_center = window.scale_factor();
        monitor_after_center = monitor_name(&window);
    }

    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
        log_debug(&window, format!(
            "[resize] requested={}x{} (logical) before: monitor={} scale={:?} outer_pos={:?} outer_size={:?} | after set_size: monitor={} scale={:?} | after center: monitor={} scale={:?} outer_pos=({}, {}) outer_size={}x{}",
            width, height,
            monitor_before, scale_before, pos_before, size_before,
            monitor_after_set_size, scale_after_set_size,
            monitor_after_center, scale_after_center,
            pos.x, pos.y, size.width, size.height,
        ));
    }
    Ok(())
}

#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("Failed to clear previous hotkey: {}", e))?;
    app.global_shortcut()
        .register(accelerator.as_str())
        .map_err(|e| format!("Invalid or already-in-use hotkey: {}", e))?;
    Ok(())
}

// TEMPORARY: mirrors every debug line to stderr (for `tauri dev`) and to the
// frontend's in-app debug panel via a "debug-log" event (for release/MSI
// builds, which have no attached console) — remove once the off-center bug
// report is resolved
fn log_debug(window: &tauri::WebviewWindow, msg: String) {
    eprintln!("{msg}");
    let _ = window.emit("debug-log", msg);
}

// emits "popup-shown" so the frontend can tell an actual fresh popup apart
// from an ordinary OS focus event and clear the input/translation for it
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // window.center() centers on whichever monitor the window itself is
        // currently sitting on, not on the monitor the user is actually
        // looking at. On a single-monitor machine those are the same thing,
        // but on a multi-monitor setup the popup's "home" monitor never
        // changes unless it's manually dragged there, so on mixed-DPI rigs
        // (e.g. a 150%-scaled laptop panel plus a 100% external display) it
        // keeps reopening on its home monitor even while the user works on
        // the other one — which looks like a large, constant jump off-center
        // rather than a real centering bug. Center on the cursor's monitor
        // instead so it always appears where the user actually is.
        let centered = (|| -> tauri::Result<()> {
            let cursor = window.cursor_position()?;
            let monitor = window
                .monitor_from_point(cursor.x, cursor.y)?
                .or(window.current_monitor()?)
                .ok_or(tauri::Error::FailedToReceiveMessage)?;
            let size = window.outer_size()?;
            // use the monitor's work area (excludes the taskbar), not its
            // full size — window.center()/resize_and_center's center() call
            // centers against the work area too, and mixing the two here
            // made the popup visibly jump by half the taskbar height every
            // time it resized right after being shown
            let work_area = monitor.work_area();
            let x = work_area.position.x + (work_area.size.width as i32 - size.width as i32) / 2;
            let y = work_area.position.y + (work_area.size.height as i32 - size.height as i32) / 2;
            log_debug(&window, format!(
                "[show] cursor=({}, {}) monitor={:?} work_area_pos=({}, {}) work_area_size={}x{} monitor_scale={} window_scale={:?} outer_size={}x{} target=({}, {})",
                cursor.x, cursor.y,
                monitor.name(),
                work_area.position.x, work_area.position.y,
                work_area.size.width, work_area.size.height,
                monitor.scale_factor(),
                window.scale_factor(),
                size.width, size.height,
                x, y,
            ));
            window.set_position(tauri::PhysicalPosition::new(x, y))
        })();
        if let Err(e) = &centered {
            log_debug(&window, format!("[show] cursor-based centering failed, falling back to center(): {e}"));
            let _ = window.center();
        }
        let _ = window.show();
        let _ = window.set_focus();
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
            log_debug(&window, format!("[show] after show(): outer_pos=({}, {}) outer_size={}x{}", pos.x, pos.y, size.width, size.height));
        }
        let _ = window.emit("popup-shown", ());
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    } else {
        show_main_window(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![translate, get_languages, set_hotkey, detect_language, resize_and_center])
        .setup(|app| {
            let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_hide" => toggle_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Err(e) = app.global_shortcut().register(DEFAULT_HOTKEY) {
                eprintln!("Failed to register default hotkey: {}", e);
            }

            if let Some(window) = app.get_webview_window("main") {
                // one id per process launch — a repeat of this line in the
                // (persisted, cross-remount) frontend log means the webview
                // itself reloaded/remounted, not just that logs were cleared
                log_debug(&window, format!(
                    "[boot] pid={} started_at={:?}",
                    std::process::id(),
                    std::time::SystemTime::now(),
                ));

                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = window_clone.hide();
                        }
                        // raw OS-driven notifications — logged independently of
                        // our own resize_and_center/show_main_window calls, so
                        // we can see DPI/monitor moves Windows makes on its own
                        // (e.g. after set_position(), before our code reads
                        // outer_position() back) that our own logging would miss
                        WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size, .. } => {
                            log_debug(&window_clone, format!(
                                "[event] ScaleFactorChanged scale_factor={} new_inner_size={}x{} monitor={}",
                                scale_factor, new_inner_size.width, new_inner_size.height, monitor_name(&window_clone),
                            ));
                        }
                        WindowEvent::Moved(pos) => {
                            log_debug(&window_clone, format!(
                                "[event] Moved outer_pos=({}, {}) monitor={}",
                                pos.x, pos.y, monitor_name(&window_clone),
                            ));
                        }
                        WindowEvent::Resized(size) => {
                            log_debug(&window_clone, format!(
                                "[event] Resized inner_size={}x{} monitor={}",
                                size.width, size.height, monitor_name(&window_clone),
                            ));
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
