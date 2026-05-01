use crate::commands::mcp_config::GlobalMcp;
use crate::state::{AppSettings, ManagedState};
use tauri::State;

/// Pure diff helper for the global MCP block. Compares server names + bodies
/// independently of `serde_json`'s map ordering (which is BTreeMap-backed
/// today, but a future swap to `HashMap` would otherwise produce false
/// positives that SIGKILL every live sidecar after a 200ms grace).
pub fn mcp_block_changed(prev: &GlobalMcp, next: &GlobalMcp) -> bool {
    if prev.servers.len() != next.servers.len() {
        return true;
    }
    for (name, prev_cfg) in &prev.servers {
        match next.servers.get(name) {
            Some(next_cfg) if next_cfg == prev_cfg => continue,
            _ => return true,
        }
    }
    false
}

#[tauri::command]
pub fn load_settings(state: State<'_, ManagedState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

/// Persist settings and invalidate pool entries for any provider whose
/// `configured_providers` flag changed.
///
/// Pool invalidation is driven by *flag deltas*, not by out-of-band key
/// rotation: the rotation path is `save_api_key_cmd` / `delete_api_key_cmd`
/// in `commands::api_keys`, which flip the flag as part of their own
/// transaction. That lands here via the settings persist → delta detection
/// below → `invalidate_pool_for_provider`. The helper closure is shared
/// logic (scope §4.4).
///
/// Other `ProvidersSettings` changes (e.g. `default_provider` edits in UI,
/// `useLegacyClaudeCli` toggle) do not invalidate the pool — they take
/// effect on the next `send_message` via a fresh settings read. Only key
/// presence changes warrant killing live sidecars.
#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    // Snapshot BEFORE the write so we can diff configured_providers flags
    // and the global MCP block.
    // Scope §4.4: keyring rotation (save_api_key_cmd / delete_api_key_cmd)
    // lands here via `settings.providers.configured_providers[provider]`
    // flip; this diff is what catches it.
    let (prev_configured, prev_mcp) = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        (s.providers.configured_providers.clone(), s.mcp.clone())
    };

    let next_configured = settings.providers.configured_providers.clone();
    let next_mcp = settings.mcp.clone();

    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        *s = settings;
    }
    state.save_settings()?;

    // Collect providers whose flag crossed true↔false (or from absent → any).
    // Flag staying the same → no-op. We do NOT invalidate on flag-stays-true
    // because that would churn the pool on every unrelated settings save
    // (theme change, shortcut edit, etc).
    let changed: Vec<String> = next_configured
        .iter()
        .filter_map(|(provider, &new_val)| {
            let prev_val = prev_configured.get(provider).copied();
            if prev_val != Some(new_val) {
                Some(provider.clone())
            } else {
                None
            }
        })
        .chain(prev_configured.keys().filter_map(|p| {
            if !next_configured.contains_key(p) {
                // Provider row removed entirely (shouldn't happen through
                // Tauri commands, but guard against hand-edited settings).
                Some(p.clone())
            } else {
                None
            }
        }))
        .collect();

    // #[must_use] on invalidate_* forces us to shutdown returned entries.
    // The lock is already released (block above); await shutdowns here.
    for provider in &changed {
        let evicted = state.goose_acp_pool.invalidate_pool_for_provider(provider);
        let n = evicted.len();
        for entry in evicted {
            entry.client.shutdown().await;
        }
        if n > 0 {
            eprintln!(
                "[settings] configured_providers[{provider}] changed → {n} sidecars evicted"
            );
        }
    }

    // Conservative: any global MCP change invalidates ALL pool entries,
    // since we don't track per-agent → per-server reverse indices. The
    // legacy ProcessPool is invalidated separately via the per-spawn
    // `config_hash` in `agent.rs` (which now includes the resolved MCP
    // shape), so a stale Claude CLI process is evicted on the next
    // message. Here we only drain the goose ACP pool, since its sidecars
    // are long-lived.
    let mcp_changed = mcp_block_changed(&prev_mcp, &next_mcp);
    if mcp_changed {
        let killed = state.goose_acp_pool.shutdown_all(200).await;
        eprintln!(
            "[settings] global MCP changed → goose pool drained ({killed} sigkilled)"
        );
    }

    Ok(serde_json::json!({
        "ok": true,
        "invalidated": changed,
        "mcpChanged": mcp_changed,
    }))
}

#[tauri::command]
pub fn get_version() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": "2.x",
        "rust": "1.84+"
    })
}

#[cfg(test)]
mod mcp_diff_tests {
    use super::*;
    use serde_json::json;

    fn server(cmd: &str) -> serde_json::Value {
        json!({ "command": cmd, "args": [], "env": {} })
    }

    #[test]
    fn identical_blocks_are_not_changed() {
        let mut a = GlobalMcp::default();
        a.servers.insert("figma".into(), server("npx"));
        let b = a.clone();
        assert!(!mcp_block_changed(&a, &b));
    }

    #[test]
    fn empty_blocks_are_not_changed() {
        assert!(!mcp_block_changed(
            &GlobalMcp::default(),
            &GlobalMcp::default()
        ));
    }

    #[test]
    fn added_server_is_changed() {
        let prev = GlobalMcp::default();
        let mut next = GlobalMcp::default();
        next.servers.insert("figma".into(), server("npx"));
        assert!(mcp_block_changed(&prev, &next));
    }

    #[test]
    fn removed_server_is_changed() {
        let mut prev = GlobalMcp::default();
        prev.servers.insert("figma".into(), server("npx"));
        let next = GlobalMcp::default();
        assert!(mcp_block_changed(&prev, &next));
    }

    #[test]
    fn changed_server_body_is_changed() {
        let mut prev = GlobalMcp::default();
        prev.servers.insert("figma".into(), server("npx"));
        let mut next = GlobalMcp::default();
        next.servers.insert("figma".into(), server("bunx"));
        assert!(mcp_block_changed(&prev, &next));
    }

    #[test]
    fn renamed_server_is_changed() {
        let mut prev = GlobalMcp::default();
        prev.servers.insert("figma".into(), server("npx"));
        let mut next = GlobalMcp::default();
        next.servers.insert("stripe".into(), server("npx"));
        assert!(mcp_block_changed(&prev, &next));
    }
}
