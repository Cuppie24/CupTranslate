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

// emits "popup-shown" so the frontend can tell an actual fresh popup apart
// from an ordinary OS focus event and clear the input/translation for it
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
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
        .invoke_handler(tauri::generate_handler![translate, get_languages, set_hotkey, detect_language])
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
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
