use crate::commands::agent::sanitize_prompt_field;
use crate::commands::octo::sanitize_role;
use crate::state::{AppState, ConversationMeta, HistoryMessage, ManagedState, OctoFile};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Serialize)]
pub struct PagedHistory {
    pub messages: Vec<HistoryMessage>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[tauri::command]
pub async fn pick_folder(
    workspace_id: String,
    state: State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let result = rx.await.map_err(|e| e.to_string())?;

    match result {
        Some(path) => {
            let folder_path = path.to_string();
            // Allow the asset protocol to serve files from this folder
            let fp = std::path::Path::new(&folder_path);
            let _ = app.asset_protocol_scope().allow_directory(fp, true);
            // Explicitly allow .octopal subdir (hidden dirs may be skipped by glob)
            let _ = app.asset_protocol_scope().allow_directory(&fp.join(".octopal"), true);
            {
                let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
                if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == workspace_id) {
                    if !ws.folders.contains(&folder_path) {
                        ws.folders.push(folder_path.clone());
                    }
                }
            }
            state.save_state()?;
            Ok(Some(folder_path))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn remove_folder(
    workspace_id: String,
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == workspace_id) {
        ws.folders.retain(|f| f != &folder_path);
    }
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}

/// The subfolder inside each workspace folder where .octo agent files live.
const AGENTS_DIR: &str = "octopal-agents";

/// Set up a filesystem watcher that notifies the frontend when agent files
/// (config.json / prompt.md) in the folder change (created, modified, deleted).
/// Debounced to 150ms so a single save that fires multiple events collapses
/// into one emit.
fn ensure_folder_watcher(folder_path: &str, state: &State<'_, ManagedState>, app: &AppHandle) {
    let mut watchers = match state.folder_watchers.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if watchers.contains_key(folder_path) {
        return;
    }

    let folder_clone = folder_path.to_string();
    let app_clone = app.clone();
    let last_scheduled: Arc<StdMutex<Option<Instant>>> = Arc::new(StdMutex::new(None));

    let mut watcher = match notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            let has_agent_file = event.paths.iter().any(|p| {
                let ext = p.extension().and_then(|e| e.to_str());
                ext == Some("json") || ext == Some("md") || ext == Some("octo")
            });
            let has_history = event.paths.iter().any(|p| {
                p.file_name().and_then(|n| n.to_str()) == Some("room-history.json")
            });
            let has_conversation = event.paths.iter().any(|p| {
                let name = p.file_name().and_then(|n| n.to_str());
                if name == Some("conversations.json") {
                    return true;
                }
                // Anything inside .octopal/conversations/
                p.components().any(|c| c.as_os_str() == "conversations")
                    && p.extension().and_then(|e| e.to_str()) == Some("json")
            });
            if !has_agent_file && !has_history && !has_conversation {
                return;
            }
            {
                let mut ls = match last_scheduled.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if let Some(t) = *ls {
                    if t.elapsed() < Duration::from_millis(150) {
                        return;
                    }
                }
                *ls = Some(Instant::now());
            }
            let app_spawn = app_clone.clone();
            let folder_spawn = folder_clone.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                let _ = app_spawn.emit("folder:octosChanged", folder_spawn);
            });
        },
    ) {
        Ok(w) => w,
        Err(_) => return,
    };

    let mut watch_ok = false;

    // Watch octopal-agents/ recursively (each agent is a subfolder now)
    let agents_dir = Path::new(folder_path).join(AGENTS_DIR);
    if agents_dir.is_dir() {
        watch_ok = watcher
            .watch(&agents_dir, RecursiveMode::Recursive)
            .is_ok();
    }

    // Also watch root for legacy .octo files (migration period)
    if watcher
        .watch(Path::new(folder_path), RecursiveMode::NonRecursive)
        .is_ok()
    {
        watch_ok = true;
    }

    // Watch .octopal/ subdir for room-history.json + conversations.json
    let octopal_dir = Path::new(folder_path).join(".octopal");
    if octopal_dir.is_dir() {
        let _ = watcher.watch(&octopal_dir, RecursiveMode::NonRecursive);
    }
    // Watch .octopal/conversations/ recursively so per-conversation file
    // changes (writes from the agent process) are picked up.
    let conv_dir = octopal_dir.join("conversations");
    if conv_dir.is_dir() {
        let _ = watcher.watch(&conv_dir, RecursiveMode::Recursive);
    }
    if watch_ok {
        watchers.insert(folder_path.to_string(), watcher);
    }
}

/// Migrate legacy agent files into the v3 subfolder structure:
///   `octopal-agents/{name}/config.json` + `prompt.md`
///
/// Handles three legacy layouts:
///   Case 1: Root `.octo` files  →  subfolder
///   Case 2: Flat `octopal-agents/{name}.json` + `{name}.md`  →  subfolder
///   Case 3: Root `.octo` files already inside `octopal-agents/`
///
/// Migration uses **copy** (originals are preserved for safety).
fn migrate_octo_files(folder_path: &str) {
    let root = Path::new(folder_path);
    let agents_dir = root.join(AGENTS_DIR);

    // Always ensure octopal-agents/ exists (even for fresh folders with no legacy files)
    if !agents_dir.is_dir() {
        if fs::create_dir_all(&agents_dir).is_err() {
            eprintln!("[octopal] failed to create {}", agents_dir.display());
            return;
        }
    }

    // ── Case 1 & 3: Collect legacy .octo files from root and octopal-agents/ ──
    let mut legacy_octos: Vec<std::path::PathBuf> = vec![];
    for search_dir in [root.to_path_buf(), agents_dir.clone()] {
        if let Ok(entries) = fs::read_dir(&search_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) == Some("octo") && path.is_file() {
                    legacy_octos.push(path);
                }
            }
        }
    }

    // ── Case 2: Collect flat .json files in octopal-agents/ (not inside a subfolder) ──
    let mut flat_jsons: Vec<std::path::PathBuf> = vec![];
    if let Ok(entries) = fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|x| x.to_str()) == Some("json")
                && path.file_name().and_then(|n| n.to_str()) != Some("config.json")
            {
                flat_jsons.push(path);
            }
        }
    }

    if legacy_octos.is_empty() && flat_jsons.is_empty() {
        return;
    }

    if fs::create_dir_all(&agents_dir).is_err() {
        eprintln!("[octopal] failed to create {}", agents_dir.display());
        return;
    }

    // ── Migrate .octo files ──
    for src in legacy_octos {
        let stem = match src.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let sub_dir = agents_dir.join(&stem);
        let config_dest = sub_dir.join("config.json");

        // Skip if subfolder config already exists
        if config_dest.exists() {
            continue;
        }

        let content = match fs::read_to_string(&src) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[octopal] failed to read {}: {}", src.display(), e);
                continue;
            }
        };
        let mut octo: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[octopal] failed to parse {}: {}", src.display(), e);
                continue;
            }
        };

        let role = octo
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(obj) = octo.as_object_mut() {
            obj.remove("history");
        }

        if fs::create_dir_all(&sub_dir).is_err() {
            continue;
        }

        match serde_json::to_string_pretty(&octo) {
            Ok(json) => {
                if let Err(e) = fs::write(&config_dest, json) {
                    eprintln!("[octopal] failed to write {}: {}", config_dest.display(), e);
                    continue;
                }
            }
            Err(e) => {
                eprintln!("[octopal] failed to serialize {}: {}", stem, e);
                continue;
            }
        }

        let prompt_dest = sub_dir.join("prompt.md");
        if !prompt_dest.exists() && !role.is_empty() {
            let _ = fs::write(&prompt_dest, &role);
        }

        // Remove original .octo file after successful migration
        if let Err(e) = fs::remove_file(&src) {
            eprintln!("[octopal] migrated but failed to remove {}: {}", src.display(), e);
        } else {
            eprintln!(
                "[octopal] migrated .octo {} → {}/config.json",
                src.display(),
                sub_dir.display()
            );
        }
    }

    // ── Migrate flat .json + .md files ──
    for src in flat_jsons {
        let stem = match src.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let sub_dir = agents_dir.join(&stem);
        let config_dest = sub_dir.join("config.json");

        if config_dest.exists() {
            continue;
        }

        // Validate that this is actually an agent file (has "name" field)
        let content = match fs::read_to_string(&src) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let json_val: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if json_val.get("name").and_then(|v| v.as_str()).is_none() {
            continue; // Not an agent file
        }

        if fs::create_dir_all(&sub_dir).is_err() {
            continue;
        }

        // Copy .json → config.json
        if let Err(e) = fs::copy(&src, &config_dest) {
            eprintln!("[octopal] failed to copy {}: {}", src.display(), e);
            continue;
        }

        // Copy companion .md → prompt.md
        let old_md = agents_dir.join(format!("{}.md", stem));
        let prompt_dest = sub_dir.join("prompt.md");
        if old_md.exists() && !prompt_dest.exists() {
            let _ = fs::copy(&old_md, &prompt_dest);
        }

        // Remove original flat files after successful migration
        if let Err(e) = fs::remove_file(&src) {
            eprintln!("[octopal] migrated but failed to remove {}: {}", src.display(), e);
        }
        if old_md.exists() {
            let _ = fs::remove_file(&old_md);
        }
        eprintln!(
            "[octopal] migrated flat {} → {}/config.json",
            src.display(),
            sub_dir.display()
        );
    }
}

/// Parse agent config files from a directory.
///
/// **v3 (primary)**: Each agent is a subfolder with `config.json` inside.
///   `octopal-agents/developer/config.json`
///
/// **Legacy fallback**: Flat `.json` / `.octo` files in the directory itself
/// are still picked up during the migration period.
fn collect_octos_from_dir(dir: &Path, octos: &mut Vec<OctoFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();

        // v3 subfolder: {dir}/{agent_name}/config.json
        if path.is_dir() {
            let config_path = path.join("config.json");
            if config_path.is_file() {
                if let Some(octo) = parse_agent_config(&config_path) {
                    octos.push(octo);
                }
            }
            continue;
        }

        // Legacy flat files: {dir}/{name}.json or {dir}/{name}.octo
        if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str());
            if ext == Some("json") || ext == Some("octo") {
                if let Some(octo) = parse_agent_config(&path) {
                    octos.push(octo);
                }
            }
        }
    }
}

/// Read a single agent config file and return an `OctoFile` if valid.
fn parse_agent_config(path: &Path) -> Option<OctoFile> {
    let content = fs::read_to_string(path).ok()?;
    let octo: serde_json::Value = serde_json::from_str(&content).ok()?;

    let name = octo.get("name").and_then(|v| v.as_str()).filter(|n| !n.is_empty())?;
    let role = sanitize_role(
        octo.get("role")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
    );
    let icon = octo
        .get("icon")
        .and_then(|v| v.as_str())
        .unwrap_or("🤖")
        .to_string();
    let color = octo
        .get("color")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let hidden = octo.get("hidden").and_then(|v| v.as_bool());
    let isolated = octo.get("isolated").and_then(|v| v.as_bool());
    let permissions = octo
        .get("permissions")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let mcp_servers = octo.get("mcpServers").cloned();

    Some(OctoFile {
        path: path.to_string_lossy().to_string(),
        name: name.to_string(),
        role,
        icon,
        color,
        hidden,
        isolated,
        permissions,
        mcp_servers,
    })
}

#[tauri::command]
pub fn list_octos(
    folder_path: String,
    state: State<'_, ManagedState>,
    app: AppHandle,
) -> Result<Vec<OctoFile>, String> {
    let dir = Path::new(&folder_path);
    if !dir.is_dir() {
        return Ok(vec![]);
    }

    // Auto-migrate legacy .octo files → .json + .md
    migrate_octo_files(&folder_path);

    // Start watching this folder for agent file changes (idempotent).
    ensure_folder_watcher(&folder_path, &state, &app);

    let mut octos = vec![];

    // Only scan octopal-agents/ subfolder — NOT the project root.
    // Previously we also scanned the root for legacy .json files, but that
    // caused package.json ({"name":"octopal",...}) to be mistakenly parsed
    // as an agent, creating a phantom "octopal" agent with full permissions.
    let agents_dir = dir.join(AGENTS_DIR);
    collect_octos_from_dir(&agents_dir, &mut octos);

    // If no agents found at all, create a default "assistant" agent
    if octos.is_empty() {
        let result = crate::commands::octo::create_octo(
            folder_path.clone(),
            "assistant".to_string(),
            "General assistant. Scans the project, answers questions, and helps with tasks.".to_string(),
            None,
            Some("🐙".to_string()),
            None,
            None,
            None,
        );
        if result.ok {
            if let Some(ref path) = result.path {
                let config_path = Path::new(path);
                if let Some(octo) = parse_agent_config(config_path) {
                    octos.push(octo);
                }
            }
        }
    }

    octos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(octos)
}

/// Legacy: loads `room-history.json` directly. Retained for backwards
/// compatibility with any caller that hasn't moved to conversation-aware
/// paging yet. New code should use `load_history_paged`.
#[tauri::command]
pub fn load_history(folder_path: String) -> Result<Vec<HistoryMessage>, String> {
    let history_file = Path::new(&folder_path)
        .join(".octopal")
        .join("room-history.json");
    if !history_file.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let messages: Vec<HistoryMessage> = serde_json::from_str(&content).unwrap_or_default();
    Ok(messages)
}

#[tauri::command]
pub fn load_history_paged(
    folder_path: String,
    conversation_id: String,
    limit: usize,
    before_ts: Option<f64>,
) -> Result<PagedHistory, String> {
    let history_file = conversation_messages_path(Path::new(&folder_path), &conversation_id);
    if !history_file.exists() {
        return Ok(PagedHistory {
            messages: vec![],
            has_more: false,
        });
    }
    let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let all: Vec<HistoryMessage> = serde_json::from_str(&content).unwrap_or_default();

    let filtered: Vec<_> = if let Some(ts) = before_ts {
        all.into_iter().filter(|m| m.ts < ts).collect()
    } else {
        all
    };

    let total = filtered.len();
    let start = if total > limit { total - limit } else { 0 };
    let messages = filtered[start..].to_vec();
    let has_more = start > 0;

    Ok(PagedHistory { messages, has_more })
}

/// Read the pending-handoff state blob for a folder. Returns an empty
/// object if the file doesn't exist or is malformed.
///
/// Pending handoffs are transient UI state — they hold the "waiting on user
/// approval" hook for a chain that was parked mid-flight. Persisting them
/// means a window reload or crash doesn't strand the approval buttons.
#[tauri::command]
pub fn read_pending_state(folder_path: String) -> Result<serde_json::Value, String> {
    let path = Path::new(&folder_path).join(".octopal").join("pending.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<serde_json::Value>(&content).unwrap_or_else(|_| serde_json::json!({})))
}

/// Write the pending-handoff state blob for a folder. Overwrites any
/// existing file. Pass an empty object `{}` to clear.
#[tauri::command]
pub fn write_pending_state(
    folder_path: String,
    state: serde_json::Value,
) -> Result<(), String> {
    let dir = Path::new(&folder_path).join(".octopal");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pending.json");
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn append_user_message(
    folder_path: String,
    conversation_id: String,
    id: String,
    ts: f64,
    text: String,
    attachments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let folder = Path::new(&folder_path);
    let conv_dir = conversations_dir(folder);
    fs::create_dir_all(&conv_dir).map_err(|e| e.to_string())?;
    let history_file = conversation_messages_path(folder, &conversation_id);

    maybe_rotate_history(&history_file);

    let mut messages: Vec<serde_json::Value> = if history_file.exists() {
        let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    let mut msg = serde_json::json!({
        "id": id,
        "agentName": "user",
        "text": text,
        "ts": ts,
    });
    if let Some(att) = attachments {
        msg["attachments"] = att;
    }
    messages.push(msg);

    let json = serde_json::to_string_pretty(&messages).map_err(|e| e.to_string())?;
    fs::write(&history_file, json).map_err(|e| e.to_string())?;

    update_conversation_meta(folder, &conversation_id, &text, ts).ok();

    Ok(serde_json::json!({ "ok": true }))
}

/// Archive a JSON history file when it gets too large.
///
/// When the file exceeds `MAX_SIZE_BYTES`, we split it: the oldest 80% of
/// messages move to `archive/<basename>-<ts>.json`, the newest 20% stay in
/// place. This keeps recent scrolling fast without losing anything — users
/// can still browse old archives manually.
///
/// Called opportunistically from append paths; failure is non-fatal.
pub fn maybe_rotate_history(history_file: &Path) {
    /// 10 MB — rotate when the file crosses this. A typical chat turn with
    /// no attachments is 1-3 KB, so this covers ~3000-10000 turns before
    /// rotation kicks in.
    const MAX_SIZE_BYTES: u64 = 10 * 1024 * 1024;

    let metadata = match fs::metadata(history_file) {
        Ok(m) => m,
        Err(_) => return,
    };
    if metadata.len() < MAX_SIZE_BYTES {
        return;
    }

    let content = match fs::read_to_string(history_file) {
        Ok(c) => c,
        Err(_) => return,
    };
    let messages: Vec<serde_json::Value> = match serde_json::from_str(&content) {
        Ok(m) => m,
        Err(_) => return,
    };
    if messages.len() < 100 {
        return; // Don't rotate tiny files even if they're heavy (big attachments)
    }

    let split = (messages.len() * 80) / 100;
    let archive: Vec<_> = messages[..split].to_vec();
    let keep: Vec<_> = messages[split..].to_vec();

    let parent = match history_file.parent() {
        Some(p) => p,
        None => return,
    };
    let archive_dir = parent.join("archive");
    if fs::create_dir_all(&archive_dir).is_err() {
        return;
    }

    let stem = history_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("history");

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let archive_path = archive_dir.join(format!("{}-{}.json", stem, ts));

    if let Ok(archive_json) = serde_json::to_string_pretty(&archive) {
        if fs::write(&archive_path, archive_json).is_ok() {
            if let Ok(keep_json) = serde_json::to_string_pretty(&keep) {
                let _ = fs::write(history_file, keep_json);
                eprintln!(
                    "[octopal] rotated history: {} msgs archived to {}",
                    archive.len(),
                    archive_path.display()
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Conversation primitives
// ─────────────────────────────────────────────────────────────────────

fn conversations_dir(folder: &Path) -> PathBuf {
    folder.join(".octopal").join("conversations")
}

fn conversations_index_path(folder: &Path) -> PathBuf {
    folder.join(".octopal").join("conversations.json")
}

fn conversation_messages_path(folder: &Path, id: &str) -> PathBuf {
    conversations_dir(folder).join(format!("{}.json", id))
}

fn migration_marker_path(folder: &Path) -> PathBuf {
    folder.join(".octopal").join(".migrated_v1")
}

fn read_conversations_index(folder: &Path) -> Vec<ConversationMeta> {
    let path = conversations_index_path(folder);
    if !path.exists() {
        return vec![];
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<ConversationMeta>>(&s).ok())
        .unwrap_or_default()
}

fn write_conversations_index(folder: &Path, list: &[ConversationMeta]) -> Result<(), String> {
    let octopal_dir = folder.join(".octopal");
    fs::create_dir_all(&octopal_dir).map_err(|e| e.to_string())?;
    let path = conversations_index_path(folder);
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Public wrapper used by `agent.rs` to refresh the conversation index entry
/// after persisting an assistant response. Never panics; failure is logged
/// upstream as a non-fatal event.
pub fn touch_conversation_meta(
    folder_path: &str,
    conversation_id: &str,
    last_text: &str,
    ts: f64,
) -> Result<(), String> {
    update_conversation_meta(Path::new(folder_path), conversation_id, last_text, ts)
}

/// Update an existing index entry with the latest message snippet, count, and
/// timestamp. No-op when the entry is missing (e.g. orphan write).
fn update_conversation_meta(
    folder: &Path,
    conversation_id: &str,
    last_text: &str,
    ts: f64,
) -> Result<(), String> {
    let mut list = read_conversations_index(folder);
    let messages_path = conversation_messages_path(folder, conversation_id);
    let count = fs::read_to_string(&messages_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .map(|v| v.len() as u32)
        .unwrap_or(0);

    let snippet: String = last_text.chars().take(120).collect();
    let mut updated = false;
    for meta in list.iter_mut() {
        if meta.id == conversation_id {
            meta.updated_at = ts;
            meta.last_snippet = if snippet.is_empty() { None } else { Some(snippet.clone()) };
            meta.message_count = count;
            updated = true;
            break;
        }
    }
    if updated {
        write_conversations_index(folder, &list)?;
    }
    Ok(())
}

/// Migrate legacy `room-history.json` into a freshly-minted "Default"
/// conversation. Idempotent: skips if `.migrated_v1` marker exists or if the
/// index already has entries.
///
/// Returns the new conversation id when migration ran, `None` otherwise.
fn migrate_legacy_room_history(folder: &Path) -> Option<String> {
    let octopal_dir = folder.join(".octopal");
    let marker = migration_marker_path(folder);
    if marker.exists() {
        return None;
    }

    let legacy = octopal_dir.join("room-history.json");

    // Marker is also written when there's nothing to migrate, so we don't
    // re-check forever on every list call.
    if !legacy.exists() {
        let _ = fs::create_dir_all(&octopal_dir);
        let _ = fs::write(&marker, b"v1");
        return None;
    }

    let existing = read_conversations_index(folder);
    if !existing.is_empty() {
        let _ = fs::create_dir_all(&octopal_dir);
        let _ = fs::write(&marker, b"v1");
        return None;
    }

    let messages: Vec<serde_json::Value> = fs::read_to_string(&legacy)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let id = Uuid::new_v4().to_string();
    let conv_dir = conversations_dir(folder);
    if fs::create_dir_all(&conv_dir).is_err() {
        return None;
    }

    let dest = conversation_messages_path(folder, &id);
    let messages_json =
        serde_json::to_string_pretty(&messages).unwrap_or_else(|_| "[]".to_string());
    if fs::write(&dest, messages_json).is_err() {
        return None;
    }

    let now = now_ms();
    let last_snippet = messages
        .last()
        .and_then(|m| m.get("text").and_then(|v| v.as_str()))
        .map(|s| s.chars().take(120).collect::<String>())
        .filter(|s| !s.is_empty());

    let meta = ConversationMeta {
        id: id.clone(),
        title: "Default".to_string(),
        created_at: now,
        updated_at: now,
        last_snippet,
        message_count: messages.len() as u32,
    };

    if write_conversations_index(folder, &[meta]).is_err() {
        return None;
    }

    let _ = fs::write(&marker, b"v1");
    Some(id)
}

#[tauri::command]
pub fn list_conversations(folder_path: String) -> Result<Vec<ConversationMeta>, String> {
    let folder = Path::new(&folder_path);
    fs::create_dir_all(folder.join(".octopal")).map_err(|e| e.to_string())?;
    fs::create_dir_all(conversations_dir(folder)).map_err(|e| e.to_string())?;

    migrate_legacy_room_history(folder);

    let mut list = read_conversations_index(folder);

    // Invariant: every folder must have at least one conversation. Seed an
    // empty one when the index is empty (e.g. brand-new folder).
    if list.is_empty() {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let meta = ConversationMeta {
            id: id.clone(),
            title: "New conversation".to_string(),
            created_at: now,
            updated_at: now,
            last_snippet: None,
            message_count: 0,
        };
        let messages_path = conversation_messages_path(folder, &id);
        fs::write(&messages_path, b"[]").map_err(|e| e.to_string())?;
        write_conversations_index(folder, &[meta.clone()])?;
        list = vec![meta];
    }

    list.sort_by(|a, b| {
        b.updated_at
            .partial_cmp(&a.updated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(list)
}

#[tauri::command]
pub fn create_conversation(
    folder_path: String,
    title: Option<String>,
) -> Result<ConversationMeta, String> {
    let folder = Path::new(&folder_path);
    fs::create_dir_all(conversations_dir(folder)).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let raw_title = title.unwrap_or_else(|| "New conversation".to_string());
    let mut clean = sanitize_prompt_field(&raw_title);
    if clean.is_empty() {
        clean = "New conversation".to_string();
    }

    let meta = ConversationMeta {
        id: id.clone(),
        title: clean,
        created_at: now,
        updated_at: now,
        last_snippet: None,
        message_count: 0,
    };

    let messages_path = conversation_messages_path(folder, &id);
    fs::write(&messages_path, b"[]").map_err(|e| e.to_string())?;

    let mut list = read_conversations_index(folder);
    list.push(meta.clone());
    write_conversations_index(folder, &list)?;

    Ok(meta)
}

#[tauri::command]
pub fn rename_conversation(
    folder_path: String,
    conversation_id: String,
    title: String,
) -> Result<ConversationMeta, String> {
    let folder = Path::new(&folder_path);
    let mut list = read_conversations_index(folder);

    let mut clean = sanitize_prompt_field(&title);
    if clean.is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    if clean.chars().count() > 200 {
        clean = clean.chars().take(200).collect();
    }

    let mut updated: Option<ConversationMeta> = None;
    for meta in list.iter_mut() {
        if meta.id == conversation_id {
            meta.title = clean.clone();
            meta.updated_at = now_ms();
            updated = Some(meta.clone());
            break;
        }
    }

    let meta = updated.ok_or_else(|| format!("Conversation {} not found", conversation_id))?;
    write_conversations_index(folder, &list)?;
    Ok(meta)
}

#[tauri::command]
pub fn delete_conversation(
    folder_path: String,
    conversation_id: String,
) -> Result<(), String> {
    let folder = Path::new(&folder_path);
    let mut list = read_conversations_index(folder);

    let before = list.len();
    list.retain(|m| m.id != conversation_id);
    if list.len() == before {
        return Err(format!("Conversation {} not found", conversation_id));
    }

    let messages_path = conversation_messages_path(folder, &conversation_id);
    if messages_path.exists() {
        let _ = fs::remove_file(&messages_path);
    }

    // Last-conversation invariant: never let the index become empty.
    if list.is_empty() {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let meta = ConversationMeta {
            id: id.clone(),
            title: "New conversation".to_string(),
            created_at: now,
            updated_at: now,
            last_snippet: None,
            message_count: 0,
        };
        let new_messages_path = conversation_messages_path(folder, &id);
        fs::write(&new_messages_path, b"[]").map_err(|e| e.to_string())?;
        list.push(meta);
    }

    write_conversations_index(folder, &list)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn folder_path(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    #[test]
    fn migrate_legacy_room_history_creates_default_conversation() {
        let dir = tempdir().unwrap();
        let octopal = dir.path().join(".octopal");
        fs::create_dir_all(&octopal).unwrap();

        let messages = serde_json::json!([
            { "id": "u-1", "agentName": "user", "text": "hello", "ts": 1.0 },
            { "id": "a-1", "agentName": "assistant", "text": "hi", "ts": 2.0 },
        ]);
        fs::write(
            octopal.join("room-history.json"),
            serde_json::to_string_pretty(&messages).unwrap(),
        )
        .unwrap();

        let id = migrate_legacy_room_history(dir.path()).expect("migration should run");

        let index = read_conversations_index(dir.path());
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].title, "Default");
        assert_eq!(index[0].id, id);
        assert_eq!(index[0].message_count, 2);

        let conv_file = conversation_messages_path(dir.path(), &id);
        let content = fs::read_to_string(&conv_file).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.len(), 2);

        assert!(migration_marker_path(dir.path()).exists());
    }

    #[test]
    fn migrate_is_idempotent() {
        let dir = tempdir().unwrap();
        let octopal = dir.path().join(".octopal");
        fs::create_dir_all(&octopal).unwrap();
        fs::write(
            octopal.join("room-history.json"),
            r#"[{"id":"u-1","agentName":"user","text":"x","ts":1.0}]"#,
        )
        .unwrap();

        let first = migrate_legacy_room_history(dir.path());
        let second = migrate_legacy_room_history(dir.path());
        assert!(first.is_some());
        assert!(second.is_none(), "second migration should be a no-op");

        // Index still has one entry
        assert_eq!(read_conversations_index(dir.path()).len(), 1);
    }

    #[test]
    fn create_conversation_appends_to_index_and_creates_file() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);

        // First call seeds an empty conversation via list_conversations
        list_conversations(fp.clone()).unwrap();
        let before = read_conversations_index(dir.path()).len();

        let conv = create_conversation(fp.clone(), Some("Bug fix".into())).unwrap();
        assert_eq!(conv.title, "Bug fix");
        assert_eq!(conv.message_count, 0);

        let after = read_conversations_index(dir.path());
        assert_eq!(after.len(), before + 1);
        assert!(after.iter().any(|c| c.id == conv.id && c.title == "Bug fix"));

        let path = conversation_messages_path(dir.path(), &conv.id);
        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
    }

    #[test]
    fn rename_conversation_updates_index() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let conv = create_conversation(fp.clone(), Some("Old".into())).unwrap();

        let updated =
            rename_conversation(fp.clone(), conv.id.clone(), "Renamed".into()).unwrap();
        assert_eq!(updated.title, "Renamed");

        let index = read_conversations_index(dir.path());
        let entry = index.iter().find(|c| c.id == conv.id).unwrap();
        assert_eq!(entry.title, "Renamed");
    }

    #[test]
    fn rename_rejects_empty_title() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let conv = create_conversation(fp.clone(), Some("X".into())).unwrap();

        let result = rename_conversation(fp.clone(), conv.id.clone(), "   ".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_conversation_removes_file_and_index() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let a = create_conversation(fp.clone(), Some("A".into())).unwrap();
        let b = create_conversation(fp.clone(), Some("B".into())).unwrap();

        delete_conversation(fp.clone(), a.id.clone()).unwrap();

        let index = read_conversations_index(dir.path());
        assert!(index.iter().all(|c| c.id != a.id));
        assert!(index.iter().any(|c| c.id == b.id));
        assert!(!conversation_messages_path(dir.path(), &a.id).exists());
    }

    #[test]
    fn delete_last_conversation_creates_replacement() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let only = create_conversation(fp.clone(), Some("Only".into())).unwrap();

        delete_conversation(fp.clone(), only.id.clone()).unwrap();

        // Last-conversation invariant: index must never become empty.
        let index = read_conversations_index(dir.path());
        assert_eq!(index.len(), 1);
        assert_ne!(index[0].id, only.id);
    }

    #[test]
    fn append_user_message_updates_last_snippet_and_message_count() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let conv = create_conversation(fp.clone(), Some("X".into())).unwrap();

        append_user_message(
            fp.clone(),
            conv.id.clone(),
            "u-1".into(),
            12345.0,
            "Hello there".into(),
            None,
        )
        .unwrap();

        let index = read_conversations_index(dir.path());
        let entry = index.iter().find(|c| c.id == conv.id).unwrap();
        assert_eq!(entry.message_count, 1);
        assert_eq!(entry.last_snippet.as_deref(), Some("Hello there"));
        assert_eq!(entry.updated_at, 12345.0);
    }

    #[test]
    fn list_conversations_seeds_one_for_empty_folder() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let list = list_conversations(fp).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message_count, 0);
    }

    #[test]
    fn list_conversations_sorts_by_updated_at_desc() {
        let dir = tempdir().unwrap();
        let fp = folder_path(&dir);
        let a = create_conversation(fp.clone(), Some("A".into())).unwrap();
        // Force a divergence in updated_at
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = create_conversation(fp.clone(), Some("B".into())).unwrap();

        let list = list_conversations(fp).unwrap();
        // Most recent first
        assert!(list.iter().any(|c| c.id == a.id));
        assert!(list.iter().any(|c| c.id == b.id));
        // Find the position of a vs b — b should not appear after a
        let pos_a = list.iter().position(|c| c.id == a.id).unwrap();
        let pos_b = list.iter().position(|c| c.id == b.id).unwrap();
        assert!(pos_b <= pos_a, "B (newer) should sort before or equal to A");
    }
}
