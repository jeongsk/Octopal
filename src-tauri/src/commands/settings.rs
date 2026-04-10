use crate::state::{AppSettings, ManagedState};
use tauri::State;

#[tauri::command]
pub fn load_settings(state: State<'_, ManagedState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    *s = settings;
    drop(s);
    state.save_settings()?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn get_version() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": "2.x",
        "rust": "1.84+"
    })
}
