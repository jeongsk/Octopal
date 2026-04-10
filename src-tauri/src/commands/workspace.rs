use crate::state::{AppState, ManagedState, Workspace};
use tauri::State;

#[tauri::command]
pub fn load_state(state: State<'_, ManagedState>) -> Result<AppState, String> {
    let s = state.app_state.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

#[tauri::command]
pub fn create_workspace(name: String, state: State<'_, ManagedState>) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    let id = format!("ws-{}", chrono::Utc::now().timestamp_millis());
    s.workspaces.push(Workspace {
        id: id.clone(),
        name,
        folders: vec![],
    });
    s.active_workspace_id = Some(id);
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}

#[tauri::command]
pub fn rename_workspace(
    id: String,
    name: String,
    state: State<'_, ManagedState>,
) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == id) {
        ws.name = name;
    }
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}

#[tauri::command]
pub fn remove_workspace(id: String, state: State<'_, ManagedState>) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    s.workspaces.retain(|w| w.id != id);
    if s.active_workspace_id.as_deref() == Some(&id) {
        s.active_workspace_id = s.workspaces.first().map(|w| w.id.clone());
    }
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}

#[tauri::command]
pub fn set_active_workspace(
    id: String,
    state: State<'_, ManagedState>,
) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    s.active_workspace_id = Some(id);
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}
