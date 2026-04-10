/// Observer commands — stub implementations for Phase 0-1
/// Full observer logic (RuleRouter, SmartObserver) will be ported in Phase 3+
/// For now, these return basic structures to keep the frontend working.

#[tauri::command]
pub fn observer_update(
    _folder_path: String,
    _agent_name: String,
    _text: String,
    _ts: f64,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn observer_get_context(_folder_path: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "context": {
            "currentTopic": null,
            "recentTopics": [],
            "agentActivity": {},
            "pendingMentions": [],
            "conversationPhase": "idle",
            "messageCount": 0,
            "lastRespondent": null,
            "lastActivityTs": 0
        }
    }))
}

#[tauri::command]
pub fn observer_reset(_folder_path: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn smart_observer_get_context(_folder_path: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "context": {
            "rule": {
                "currentTopic": null,
                "recentTopics": [],
                "agentActivity": {},
                "pendingMentions": [],
                "conversationPhase": "idle",
                "messageCount": 0,
                "lastRespondent": null,
                "lastActivityTs": 0
            },
            "llm": null
        }
    }))
}

#[tauri::command]
pub fn smart_observer_force_refresh(_folder_path: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": false, "error": "Not yet implemented in Tauri backend" }))
}

#[tauri::command]
pub fn smart_observer_set_enabled(_enabled: bool) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn smart_observer_set_model(model: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "model": model }))
}

#[tauri::command]
pub fn smart_observer_get_model() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "model": "haiku" }))
}

#[tauri::command]
pub fn smart_observer_get_metrics() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "metrics": {
            "totalCalls": 0,
            "successes": 0,
            "parseFailures": 0,
            "validationFailures": 0,
            "timeouts": 0,
            "errors": 0,
            "avgLatencyMs": 0,
            "lastSuccessAt": null,
            "lastFailureReason": null
        }
    }))
}

#[tauri::command]
pub fn dispatcher_route(
    message: String,
    agents: Vec<serde_json::Value>,
    _recent_history: Vec<serde_json::Value>,
    _folder_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let msg_lower = message.to_lowercase();

    for agent in &agents {
        let name = agent.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if msg_lower.contains(&format!("@{}", name.to_lowercase())) {
            return Ok(serde_json::json!({
                "ok": true,
                "leader": name,
                "collaborators": []
            }));
        }
    }

    let leader = agents
        .first()
        .and_then(|a| a.get("name").and_then(|v| v.as_str()))
        .unwrap_or("assistant");

    Ok(serde_json::json!({
        "ok": true,
        "leader": leader,
        "collaborators": []
    }))
}

#[tauri::command]
pub fn classify_mention(
    _speaker_name: String,
    speaker_text: String,
    _mentioned_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    let text_lower = speaker_text.to_lowercase();
    let action_words = ["please", "해줘", "부탁", "해주", "check", "review", "handle", "do"];
    let is_handoff = action_words.iter().any(|w| text_lower.contains(w));

    Ok(serde_json::json!({
        "ok": true,
        "decision": if is_handoff { "handoff" } else { "ignore" }
    }))
}

#[tauri::command]
pub fn dispatcher_check_context(
    _original_prompt: String,
    _new_message: String,
    _agent_name: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "same_context": true
    }))
}
