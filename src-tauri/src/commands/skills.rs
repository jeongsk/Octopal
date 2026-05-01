use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::octo::CreateResult;

#[derive(Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// `"workspace"`, `"agent:<dirname>"`, or `"user"`.
    pub source: String,
    #[serde(rename = "argumentHint", skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Absolute path to the SKILL.md file (for debugging / opening in editor).
    pub path: String,
}

/// Settings-side skill entry: same shape as `SkillEntry` but always includes
/// the disabled-state flag (so the Skills tab can render `user-invocable: false`
/// rows without re-parsing) and the raw `SKILL.md` source (so the edit modal
/// can split the body without an extra round-trip).
///
/// `parse_failed` flags rows where the YAML frontmatter could not be parsed.
/// The renderer surfaces these as non-editable so an inadvertent toggle can't
/// clobber the user's file with empty defaults.
#[derive(Serialize, Clone)]
pub struct SkillForSettings {
    pub name: String,
    pub description: String,
    pub source: String,
    #[serde(rename = "argumentHint", skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    pub path: String,
    pub enabled: bool,
    pub raw: String,
    #[serde(rename = "parseFailed")]
    pub parse_failed: bool,
}

/// Tiny YAML-frontmatter parser. We only need a flat string-valued subset
/// (`name`, `description`, `argument-hint`, `user-invocable`, `disable-model-invocation`),
/// so dragging in `serde_yaml` is overkill. Returns `None` if no frontmatter
/// block is present.
///
/// Handles inline scalars (`key: value`, with optional surrounding quotes)
/// and block scalars (`key: |` literal, `key: >` folded) with indented
/// continuation lines — the form most Claude Code skills use for their
/// long-form `description`.
pub(crate) fn parse_frontmatter(content: &str) -> Option<std::collections::HashMap<String, String>> {
    let trimmed = content.trim_start_matches('\u{feff}');
    let rest = trimmed.strip_prefix("---")?;
    let after_opener = rest.trim_start_matches(|c: char| c != '\n').trim_start_matches('\n');
    let end = after_opener.find("\n---")?;
    let block = &after_opener[..end];

    let lines: Vec<&str> = block.lines().collect();
    let mut map = std::collections::HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let trimmed_line = raw.trim_end();
        if trimmed_line.is_empty() || trimmed_line.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        // Only top-level keys (no leading whitespace) start a new entry —
        // indented lines are continuations handled inside the block branch.
        if raw.starts_with(' ') || raw.starts_with('\t') {
            i += 1;
            continue;
        }
        let Some((k, v)) = trimmed_line.split_once(':') else {
            i += 1;
            continue;
        };
        let key = k.trim().to_lowercase();
        let val_part = v.trim();

        if val_part == "|" || val_part == ">" {
            let folded = val_part == ">";
            let mut parts: Vec<String> = Vec::new();
            i += 1;
            while i < lines.len() {
                let next = lines[i];
                if next.trim().is_empty() {
                    if folded {
                        // YAML "folded" semantics: a blank line becomes a
                        // paragraph break. We approximate with a single \n
                        // since callers display this as plain text.
                        parts.push(String::new());
                    } else {
                        parts.push(String::new());
                    }
                    i += 1;
                    continue;
                }
                if !(next.starts_with(' ') || next.starts_with('\t')) {
                    break;
                }
                parts.push(next.trim_start().to_string());
                i += 1;
            }
            let joined = if folded {
                // Collapse runs of (non-empty) lines with single spaces;
                // empty entries become paragraph breaks.
                let mut out = String::new();
                let mut last_blank = true;
                for p in &parts {
                    if p.is_empty() {
                        if !out.is_empty() && !out.ends_with('\n') {
                            out.push('\n');
                        }
                        last_blank = true;
                    } else {
                        if !out.is_empty() && !last_blank {
                            out.push(' ');
                        }
                        out.push_str(p);
                        last_blank = false;
                    }
                }
                out
            } else {
                parts.join("\n")
            };
            map.insert(key, joined.trim().to_string());
            continue;
        }

        // Inline scalar, possibly quoted.
        let mut val = val_part.to_string();
        if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
            || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
        {
            val = val[1..val.len() - 1].to_string();
        }
        map.insert(key, val);
        i += 1;
    }
    Some(map)
}

/// Emit a frontmatter block that round-trips through `parse_frontmatter`.
///
/// `description` is always written as a `|` literal block scalar so users can
/// paste multi-line descriptions without escaping. `name` and `argument_hint`
/// are written as inline scalars, double-quoted only when they contain
/// characters that would be ambiguous in plain YAML (`:`, `#`, leading
/// whitespace).
fn serialize_frontmatter(
    name: &str,
    description: &str,
    argument_hint: Option<&str>,
    enabled: bool,
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", quote_inline_if_needed(name)));
    out.push_str("description: |\n");
    if description.is_empty() {
        // Block scalar with no body line — parser yields empty string after trim.
    } else {
        for line in description.lines() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    if let Some(hint) = argument_hint {
        let trimmed = hint.trim();
        if !trimmed.is_empty() {
            out.push_str(&format!(
                "argument-hint: {}\n",
                quote_inline_if_needed(trimmed)
            ));
        }
    }
    out.push_str(&format!("user-invocable: {}\n", if enabled { "true" } else { "false" }));
    out.push_str("---\n");
    out
}

fn quote_inline_if_needed(value: &str) -> String {
    let needs_quoting = value.is_empty()
        || value.starts_with(' ')
        || value.starts_with('\t')
        || value.ends_with(' ')
        || value.ends_with('\t')
        || value.contains(':')
        || value.contains('#')
        || value.contains('\n')
        || value.starts_with('"')
        || value.starts_with('\'');
    if needs_quoting {
        // Strip any embedded double quotes — the parser does not honor escapes,
        // so a stray `"` would prematurely close the value. Skill names are
        // sanitized upstream; this guard only matters for `argument-hint`.
        let safe = value.replace('"', "");
        format!("\"{}\"", safe)
    } else {
        value.to_string()
    }
}

/// Resolve the on-disk skills root for a scope:
/// - `"user"`   → `~/.claude/skills`
/// - `"workspace"` → `<folder_path>/.claude/skills` (errors if `folder_path` missing)
fn skill_root_for_scope(scope: &str, folder_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => {
            let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
            Ok(home.join(".claude").join("skills"))
        }
        "workspace" => {
            let folder = folder_path
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Workspace folder path required".to_string())?;
            Ok(PathBuf::from(folder).join(".claude").join("skills"))
        }
        other => Err(format!("Unsupported skill scope: {}", other)),
    }
}

fn read_skill(skill_dir: &Path, source: String) -> Option<SkillEntry> {
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }
    let content = fs::read_to_string(&skill_md).ok()?;
    let dir_name = skill_dir.file_name()?.to_string_lossy().to_string();

    let (description, argument_hint, name_override, hidden) = match parse_frontmatter(&content) {
        Some(fm) => {
            let user_invocable = fm
                .get("user-invocable")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(true);
            (
                fm.get("description").cloned().unwrap_or_default(),
                fm.get("argument-hint").cloned(),
                fm.get("name").cloned(),
                !user_invocable,
            )
        }
        None => (String::new(), None, None, false),
    };
    if hidden {
        return None;
    }
    Some(SkillEntry {
        name: name_override.unwrap_or(dir_name),
        description,
        source,
        argument_hint,
        path: skill_md.to_string_lossy().to_string(),
    })
}

/// Settings-side variant of `read_skill`: returns the entry even when
/// `user-invocable: false`, and includes the raw markdown source so the edit
/// modal can split the body off without an extra fs read.
fn read_skill_for_settings(skill_dir: &Path, source: String) -> Option<SkillForSettings> {
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }
    let content = fs::read_to_string(&skill_md).ok()?;
    let dir_name = skill_dir.file_name()?.to_string_lossy().to_string();

    let (description, argument_hint, name_override, enabled, parse_failed) =
        match parse_frontmatter(&content) {
            Some(fm) => {
                let user_invocable = fm
                    .get("user-invocable")
                    .map(|v| v.eq_ignore_ascii_case("true"))
                    .unwrap_or(true);
                (
                    fm.get("description").cloned().unwrap_or_default(),
                    fm.get("argument-hint").cloned(),
                    fm.get("name").cloned(),
                    user_invocable,
                    false,
                )
            }
            // Surface parse failures so the renderer can disable edit/toggle
            // for the row instead of silently treating the file as
            // `enabled: true` with empty fields.
            None => (String::new(), None, None, false, true),
        };
    Some(SkillForSettings {
        name: name_override.unwrap_or(dir_name),
        description,
        source,
        argument_hint,
        path: skill_md.to_string_lossy().to_string(),
        enabled,
        raw: content,
        parse_failed,
    })
}

fn scan_skills_dir(skills_dir: &Path, source: impl Fn(&str) -> String, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if let Some(skill) = read_skill(&path, source(&dir_name)) {
            out.push(skill);
        }
    }
}

fn scan_skills_dir_for_settings(
    skills_dir: &Path,
    source: impl Fn(&str) -> String,
    out: &mut Vec<SkillForSettings>,
) {
    let Ok(entries) = fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if let Some(skill) = read_skill_for_settings(&path, source(&dir_name)) {
            out.push(skill);
        }
    }
}

/// List slash-invocable skills for the given workspace folder.
///
/// Sources scanned, in precedence order (later entries with the same `name`
/// are dropped — matches Claude Code's enterprise > personal > project rule
/// in spirit, with workspace > agent > user for our local layout):
///
/// 1. `<folder_path>/.claude/skills/<name>/SKILL.md` — workspace
/// 2. `<folder_path>/octopal-agents/<agent>/.claude/skills/<name>/SKILL.md` — per-agent
/// 3. `~/.claude/skills/<name>/SKILL.md` — user-global
#[tauri::command]
pub fn list_skills(folder_path: String) -> Result<Vec<SkillEntry>, String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<SkillEntry> = vec![];

    // Workspace skills.
    scan_skills_dir(
        &folder.join(".claude").join("skills"),
        |_| "workspace".to_string(),
        &mut out,
    );

    // Per-agent skills.
    let agents_root = folder.join("octopal-agents");
    if let Ok(agents) = fs::read_dir(&agents_root) {
        for agent_entry in agents.flatten() {
            let agent_path = agent_entry.path();
            if !agent_path.is_dir() {
                continue;
            }
            let agent_dir_name = agent_entry.file_name().to_string_lossy().to_string();
            // Skip hidden / non-agent folders.
            if agent_dir_name.starts_with('.') {
                continue;
            }
            let label = format!("agent:{}", agent_dir_name);
            scan_skills_dir(
                &agent_path.join(".claude").join("skills"),
                |_| label.clone(),
                &mut out,
            );
        }
    }

    // User-global skills.
    if let Some(home) = dirs::home_dir() {
        scan_skills_dir(
            &home.join(".claude").join("skills"),
            |_| "user".to_string(),
            &mut out,
        );
    }

    // Dedup by name keeping the first occurrence (workspace beats agent beats user).
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.name.clone()));
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Settings-side counterpart of `list_skills`. Returns every skill
/// (including `user-invocable: false`) along with its enabled flag and the
/// raw `SKILL.md` source. Per-agent skills are returned for read-only display;
/// the renderer disables edit/delete for those rows.
#[tauri::command]
pub fn list_skills_for_settings(folder_path: String) -> Result<Vec<SkillForSettings>, String> {
    let mut out: Vec<SkillForSettings> = vec![];

    let folder = if folder_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(&folder_path))
    };

    if let Some(folder) = folder.as_ref() {
        if folder.is_dir() {
            scan_skills_dir_for_settings(
                &folder.join(".claude").join("skills"),
                |_| "workspace".to_string(),
                &mut out,
            );

            let agents_root = folder.join("octopal-agents");
            if let Ok(agents) = fs::read_dir(&agents_root) {
                for agent_entry in agents.flatten() {
                    let agent_path = agent_entry.path();
                    if !agent_path.is_dir() {
                        continue;
                    }
                    let agent_dir_name = agent_entry.file_name().to_string_lossy().to_string();
                    if agent_dir_name.starts_with('.') {
                        continue;
                    }
                    let label = format!("agent:{}", agent_dir_name);
                    scan_skills_dir_for_settings(
                        &agent_path.join(".claude").join("skills"),
                        |_| label.clone(),
                        &mut out,
                    );
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        scan_skills_dir_for_settings(
            &home.join(".claude").join("skills"),
            |_| "user".to_string(),
            &mut out,
        );
    }

    // Dedup by (source, name) so the same skill appears once per scope.
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    out.retain(|s| seen.insert((s.source.clone(), s.name.clone())));
    out.sort_by(|a, b| a.source.cmp(&b.source).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Read the raw SKILL.md source at `path`. Defense-in-depth path validation:
/// the canonicalized path must match the structural skill layout
/// `.../.claude/skills/<dirname>/SKILL.md`. This is a shape check, not a
/// containment check against the active workspace's skill roots — a true
/// containment validator (canonicalize-then-`starts_with(root)`) would need
/// the active folder threaded through and is tracked as a follow-up.
#[tauri::command]
pub fn read_skill_source(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let canonical = fs::canonicalize(&p).map_err(|e| format!("Cannot resolve path: {}", e))?;
    if !looks_like_skill_path(&canonical) {
        return Err("Path is not under a known skills directory".to_string());
    }
    fs::read_to_string(&canonical).map_err(|e| e.to_string())
}

/// True if the path ends in `.../.claude/skills/<dirname>/SKILL.md`.
fn looks_like_skill_path(canonical: &Path) -> bool {
    if canonical.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return false;
    }
    let Some(skill_dir) = canonical.parent() else {
        return false;
    };
    let Some(skills_dir) = skill_dir.parent() else {
        return false;
    };
    if skills_dir.file_name().and_then(|n| n.to_str()) != Some("skills") {
        return false;
    }
    let Some(claude_dir) = skills_dir.parent() else {
        return false;
    };
    if claude_dir.file_name().and_then(|n| n.to_str()) != Some(".claude") {
        return false;
    }
    true
}

/// True if the path lies under an `octopal-agents/<agent>/.claude/skills/...`
/// layout — per-agent skills are not editable from the Settings panel in
/// Phase 1.
///
/// Matches structurally rather than lexically so a user-global skill named
/// `octopal-agents` (path `~/.claude/skills/octopal-agents/SKILL.md`) is NOT
/// classified as per-agent. The on-disk per-agent layout is exactly:
///   <...>/octopal-agents/<agent>/.claude/skills/<name>/SKILL.md
/// — six segments deep, with `octopal-agents` at index `[-6]`.
fn is_per_agent_skill_path(canonical: &Path) -> bool {
    let comps: Vec<&std::ffi::OsStr> = canonical
        .components()
        .map(|c| c.as_os_str())
        .collect();
    comps
        .iter()
        .rev()
        .nth(5)
        .map(|s| *s == "octopal-agents")
        .unwrap_or(false)
}

#[tauri::command]
pub fn create_skill(
    scope: String,
    folder_path: Option<String>,
    name: String,
    description: String,
    argument_hint: Option<String>,
    body: String,
    enabled: bool,
) -> CreateResult {
    let sanitized_name = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized_name.is_empty() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Invalid skill name".to_string()),
        };
    }
    if description.trim().is_empty() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Description is required".to_string()),
        };
    }
    let dirname = sanitized_name.to_lowercase().replace(' ', "-");
    let root = match skill_root_for_scope(&scope, folder_path.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(e),
            }
        }
    };
    if let Err(e) = fs::create_dir_all(&root) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Failed to create skills root: {}", e)),
        };
    }
    let skill_dir = root.join(&dirname);
    if skill_dir.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("A skill named \"{}\" already exists", sanitized_name)),
        };
    }
    if let Err(e) = fs::create_dir_all(&skill_dir) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Failed to create skill folder: {}", e)),
        };
    }

    let frontmatter = serialize_frontmatter(
        &dirname,
        description.trim(),
        argument_hint.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
        enabled,
    );
    let trimmed_body = body.trim_start_matches('\n');
    let contents = if trimmed_body.is_empty() {
        frontmatter
    } else {
        format!("{}\n{}", frontmatter, trimmed_body)
    };
    let skill_md = skill_dir.join("SKILL.md");
    match fs::write(&skill_md, contents) {
        Ok(_) => CreateResult {
            ok: true,
            path: Some(skill_md.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => {
            // Best-effort unwind so a retry with the same name isn't blocked
            // by the orphaned empty directory.
            let _ = fs::remove_dir(&skill_dir);
            CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    }
}

#[tauri::command]
pub fn update_skill(
    path: String,
    name: Option<String>,
    description: Option<String>,
    argument_hint: Option<String>,
    body: Option<String>,
    enabled: Option<bool>,
) -> CreateResult {
    let p = PathBuf::from(&path);
    let canonical = match fs::canonicalize(&p) {
        Ok(c) => c,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(format!("Cannot resolve path: {}", e)),
            }
        }
    };
    if !looks_like_skill_path(&canonical) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Path is not a managed skill".to_string()),
        };
    }
    if is_per_agent_skill_path(&canonical) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Per-agent skills cannot be edited from settings".to_string()),
        };
    }

    let existing = match fs::read_to_string(&canonical) {
        Ok(c) => c,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    };

    // Refuse to write when the existing frontmatter cannot be parsed —
    // unwrap_or_default() would silently coerce hand-edited metadata
    // (name, description, argument-hint) to empty defaults and clobber
    // the user's file on the next save.
    let fm = match parse_frontmatter(&existing) {
        Some(fm) => fm,
        None => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(
                    "Existing SKILL.md frontmatter is invalid; edit the file directly to fix"
                        .to_string(),
                ),
            }
        }
    };
    let existing_body = strip_frontmatter(&existing);

    let final_name = name
        .as_ref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| {
            fm.get("name")
                .cloned()
                .or_else(|| {
                    canonical
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                })
                .unwrap_or_default()
        });

    let sanitized_name = final_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized_name.is_empty() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Invalid skill name".to_string()),
        };
    }
    let new_dirname = sanitized_name.to_lowercase().replace(' ', "-");

    let final_description = description
        .map(|d| d.trim().to_string())
        .unwrap_or_else(|| fm.get("description").cloned().unwrap_or_default());
    if final_description.is_empty() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Description is required".to_string()),
        };
    }

    let final_argument_hint = match argument_hint {
        Some(h) => {
            let t = h.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        }
        None => fm.get("argument-hint").cloned(),
    };

    let final_enabled = enabled.unwrap_or_else(|| {
        fm.get("user-invocable")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(true)
    });

    let final_body = body.unwrap_or(existing_body);
    let trimmed_body = final_body.trim_start_matches('\n');

    let frontmatter = serialize_frontmatter(
        &new_dirname,
        &final_description,
        final_argument_hint.as_deref(),
        final_enabled,
    );
    let contents = if trimmed_body.is_empty() {
        frontmatter
    } else {
        format!("{}\n{}", frontmatter, trimmed_body)
    };

    let current_dir = match canonical.parent() {
        Some(d) => d.to_path_buf(),
        None => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some("Skill has no parent directory".to_string()),
            }
        }
    };
    let current_dirname = current_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    if new_dirname != current_dirname {
        let parent_root = match current_dir.parent() {
            Some(p) => p.to_path_buf(),
            None => {
                return CreateResult {
                    ok: false,
                    path: None,
                    error: Some("Skills root not found".to_string()),
                }
            }
        };
        let new_dir = parent_root.join(&new_dirname);
        if new_dir.exists() {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(format!(
                    "A skill named \"{}\" already exists",
                    sanitized_name
                )),
            };
        }
        if let Err(e) = fs::rename(&current_dir, &new_dir) {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(format!("Failed to rename skill folder: {}", e)),
            };
        }
        let new_skill_md = new_dir.join("SKILL.md");
        return match fs::write(&new_skill_md, contents) {
            Ok(_) => CreateResult {
                ok: true,
                path: Some(new_skill_md.to_string_lossy().to_string()),
                error: None,
            },
            Err(e) => CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            },
        };
    }

    match fs::write(&canonical, contents) {
        Ok(_) => CreateResult {
            ok: true,
            path: Some(canonical.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => CreateResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn delete_skill(path: String) -> CreateResult {
    let p = PathBuf::from(&path);
    let canonical = match fs::canonicalize(&p) {
        Ok(c) => c,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(format!("Cannot resolve path: {}", e)),
            }
        }
    };
    if !looks_like_skill_path(&canonical) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Path is not a managed skill".to_string()),
        };
    }
    if is_per_agent_skill_path(&canonical) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Per-agent skills cannot be deleted from settings".to_string()),
        };
    }
    let target = match canonical.parent() {
        Some(p) => p.to_path_buf(),
        None => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some("Skill has no parent directory".to_string()),
            }
        }
    };
    match trash::delete(&target) {
        Ok(_) => CreateResult {
            ok: true,
            path: None,
            error: None,
        },
        Err(e) => {
            let result = if target.is_dir() {
                fs::remove_dir_all(&target)
            } else {
                fs::remove_file(&target)
            };
            match result {
                Ok(_) => CreateResult {
                    ok: true,
                    path: None,
                    error: None,
                },
                Err(fs_err) => CreateResult {
                    ok: false,
                    path: None,
                    error: Some(format!("trash: {}, fs: {}", e, fs_err)),
                },
            }
        }
    }
}

/// Strip the leading frontmatter block from a SKILL.md source, returning the
/// body. If no frontmatter is present, returns the original string.
fn strip_frontmatter(source: &str) -> String {
    let trimmed = source.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return source.to_string();
    };
    let after_opener = rest.trim_start_matches(|c: char| c != '\n').trim_start_matches('\n');
    let Some(end) = after_opener.find("\n---") else {
        return source.to_string();
    };
    let after_close = &after_opener[end + 4..];
    after_close.trim_start_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parses_minimal_frontmatter() {
        let src = "---\ndescription: hello world\n---\nbody";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm.get("description").map(String::as_str), Some("hello world"));
    }

    #[test]
    fn handles_quoted_values_and_user_invocable() {
        let src = "---\nname: \"my-skill\"\nuser-invocable: false\n---\n";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm.get("name").map(String::as_str), Some("my-skill"));
        assert_eq!(fm.get("user-invocable").map(String::as_str), Some("false"));
    }

    #[test]
    fn no_frontmatter_returns_none() {
        assert!(parse_frontmatter("just a body, no fences").is_none());
    }

    #[test]
    fn folds_block_scalar_indicator() {
        let src = "---\nname: ClawTeam\ndescription: >\n  This skill should be used\n  when the user asks something.\nversion: 0.3\n---\nbody";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm.get("name").map(String::as_str), Some("ClawTeam"));
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("This skill should be used when the user asks something."),
        );
        assert_eq!(fm.get("version").map(String::as_str), Some("0.3"));
    }

    #[test]
    fn literal_block_scalar_preserves_newlines() {
        let src = "---\ndescription: |\n  line one\n  line two\n---\n";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("line one\nline two"),
        );
    }

    #[test]
    fn serialize_frontmatter_roundtrips_through_parse_frontmatter() {
        let out = serialize_frontmatter("demo", "Hello world", Some("<file>"), true);
        let fm = parse_frontmatter(&out).unwrap();
        assert_eq!(fm.get("name").map(String::as_str), Some("demo"));
        assert_eq!(fm.get("description").map(String::as_str), Some("Hello world"));
        assert_eq!(fm.get("argument-hint").map(String::as_str), Some("<file>"));
        assert_eq!(fm.get("user-invocable").map(String::as_str), Some("true"));
    }

    #[test]
    fn serialize_frontmatter_emits_block_scalar_for_multiline_description() {
        let out = serialize_frontmatter("demo", "line one\nline two", None, true);
        assert!(out.contains("description: |\n"));
        let fm = parse_frontmatter(&out).unwrap();
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("line one\nline two"),
        );
    }

    #[test]
    fn serialize_frontmatter_omits_argument_hint_when_none() {
        let out = serialize_frontmatter("demo", "x", None, false);
        assert!(!out.contains("argument-hint"));
        let fm = parse_frontmatter(&out).unwrap();
        assert_eq!(fm.get("user-invocable").map(String::as_str), Some("false"));
    }

    #[test]
    fn create_skill_writes_skill_md_with_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let res = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "Demo Skill".to_string(),
            "A demo".to_string(),
            None,
            "# Hi".to_string(),
            true,
        );
        assert!(res.ok, "create failed: {:?}", res.error);
        let path = res.path.expect("path returned");
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("name: demo-skill"));
        assert!(contents.contains("description: |"));
        assert!(contents.contains("user-invocable: true"));
        assert!(contents.contains("# Hi"));
    }

    #[test]
    fn create_skill_rejects_duplicate_name() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let first = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "twin".to_string(),
            "first".to_string(),
            None,
            String::new(),
            true,
        );
        assert!(first.ok);
        let second = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "twin".to_string(),
            "second".to_string(),
            None,
            String::new(),
            true,
        );
        assert!(!second.ok);
        assert!(second.error.unwrap().contains("already exists"));
    }

    #[test]
    fn create_skill_rejects_empty_description() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let res = create_skill(
            "workspace".to_string(),
            Some(folder),
            "test".to_string(),
            "   ".to_string(),
            None,
            String::new(),
            true,
        );
        assert!(!res.ok);
        assert!(res.error.unwrap().to_lowercase().contains("description"));
    }

    #[test]
    fn update_skill_with_disabled_flag_writes_user_invocable_false() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let created = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "togglable".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let path = created.path.unwrap();
        let res = update_skill(
            path.clone(),
            None,
            None,
            None,
            None,
            Some(false),
        );
        assert!(res.ok, "update failed: {:?}", res.error);
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("user-invocable: false"));
    }

    #[test]
    fn update_skill_renames_directory_when_name_changes() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let created = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "oldname".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let old_path = created.path.unwrap();
        let res = update_skill(
            old_path.clone(),
            Some("newname".to_string()),
            None,
            None,
            None,
            None,
        );
        assert!(res.ok, "rename failed: {:?}", res.error);
        let new_path = res.path.unwrap();
        assert!(new_path.contains("newname"));
        assert!(std::path::Path::new(&new_path).is_file());
        assert!(!std::path::Path::new(&old_path).exists());
    }

    #[test]
    fn update_skill_rejects_rename_collision() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let _a = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "alpha".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let b = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "beta".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let res = update_skill(
            b.path.unwrap(),
            Some("alpha".to_string()),
            None,
            None,
            None,
            None,
        );
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("already exists"));
    }

    #[test]
    fn delete_skill_removes_directory() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let created = create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "trashable".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let path = created.path.unwrap();
        let res = delete_skill(path.clone());
        assert!(res.ok, "delete failed: {:?}", res.error);
        assert!(!std::path::Path::new(&path).exists());
    }

    #[test]
    fn skill_root_for_scope_user_uses_home() {
        let root = skill_root_for_scope("user", None).unwrap();
        assert!(root.ends_with(".claude/skills"));
    }

    #[test]
    fn skill_root_for_scope_workspace_requires_folder() {
        let err = skill_root_for_scope("workspace", None).unwrap_err();
        assert!(err.to_lowercase().contains("folder"));
    }

    #[test]
    fn skill_root_for_scope_rejects_unknown() {
        let err = skill_root_for_scope("agent", None).unwrap_err();
        assert!(err.to_lowercase().contains("scope"));
    }

    #[test]
    fn looks_like_skill_path_accepts_valid_layout() {
        let p = Path::new("/tmp/proj/.claude/skills/demo/SKILL.md");
        assert!(looks_like_skill_path(p));
    }

    #[test]
    fn looks_like_skill_path_rejects_wrong_filename() {
        let p = Path::new("/tmp/proj/.claude/skills/demo/README.md");
        assert!(!looks_like_skill_path(p));
    }

    #[test]
    fn looks_like_skill_path_rejects_missing_skills_segment() {
        let p = Path::new("/tmp/proj/.claude/other/demo/SKILL.md");
        assert!(!looks_like_skill_path(p));
    }

    #[test]
    fn looks_like_skill_path_rejects_missing_claude_segment() {
        let p = Path::new("/tmp/proj/notclaude/skills/demo/SKILL.md");
        assert!(!looks_like_skill_path(p));
    }

    #[test]
    fn looks_like_skill_path_rejects_too_short() {
        assert!(!looks_like_skill_path(Path::new("SKILL.md")));
        assert!(!looks_like_skill_path(Path::new("/SKILL.md")));
        assert!(!looks_like_skill_path(Path::new("/skills/SKILL.md")));
    }

    #[test]
    fn read_skill_source_rejects_path_outside_skill_dir() {
        let tmp = TempDir::new().unwrap();
        let bad = tmp.path().join("evil.txt");
        fs::write(&bad, "secret").unwrap();
        let res = read_skill_source(bad.to_string_lossy().to_string());
        assert!(res.is_err());
        assert!(res.unwrap_err().to_lowercase().contains("not under"));
    }

    #[test]
    fn read_skill_source_accepts_valid_skill_md() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let created = create_skill(
            "workspace".to_string(),
            Some(folder),
            "readme".to_string(),
            "desc".to_string(),
            None,
            "# body".to_string(),
            true,
        );
        let path = created.path.unwrap();
        let raw = read_skill_source(path).unwrap();
        assert!(raw.contains("name: readme"));
        assert!(raw.contains("# body"));
    }

    #[test]
    fn is_per_agent_skill_path_detects_octopal_agents_layout() {
        assert!(is_per_agent_skill_path(Path::new(
            "/proj/octopal-agents/dev/.claude/skills/demo/SKILL.md"
        )));
        assert!(!is_per_agent_skill_path(Path::new(
            "/proj/.claude/skills/demo/SKILL.md"
        )));
    }

    #[test]
    fn is_per_agent_skill_path_does_not_false_positive_on_user_skill_named_octopal_agents() {
        // A user-global skill literally named `octopal-agents` lives at
        // `~/.claude/skills/octopal-agents/SKILL.md` — that should be editable.
        assert!(!is_per_agent_skill_path(Path::new(
            "/home/u/.claude/skills/octopal-agents/SKILL.md"
        )));
    }

    #[test]
    fn update_skill_rejects_per_agent_path() {
        let tmp = TempDir::new().unwrap();
        let agent_skill = tmp
            .path()
            .join("octopal-agents")
            .join("dev")
            .join(".claude")
            .join("skills")
            .join("agent-only");
        fs::create_dir_all(&agent_skill).unwrap();
        let skill_md = agent_skill.join("SKILL.md");
        fs::write(&skill_md, "---\nname: agent-only\ndescription: x\n---\n").unwrap();

        let res = update_skill(
            skill_md.to_string_lossy().to_string(),
            Some("renamed".to_string()),
            None,
            None,
            None,
            None,
        );
        assert!(!res.ok);
        assert!(res.error.unwrap().to_lowercase().contains("per-agent"));
        let after = fs::read_to_string(&skill_md).unwrap();
        assert!(after.contains("name: agent-only"));
    }

    #[test]
    fn delete_skill_rejects_per_agent_path() {
        let tmp = TempDir::new().unwrap();
        let agent_skill = tmp
            .path()
            .join("octopal-agents")
            .join("dev")
            .join(".claude")
            .join("skills")
            .join("untouchable");
        fs::create_dir_all(&agent_skill).unwrap();
        let skill_md = agent_skill.join("SKILL.md");
        fs::write(&skill_md, "---\nname: untouchable\ndescription: x\n---\n").unwrap();

        let res = delete_skill(skill_md.to_string_lossy().to_string());
        assert!(!res.ok);
        assert!(res.error.unwrap().to_lowercase().contains("per-agent"));
        assert!(skill_md.exists(), "per-agent skill should not be deleted");
    }

    #[test]
    fn update_skill_refuses_corrupt_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let created = create_skill(
            "workspace".to_string(),
            Some(folder),
            "broken".to_string(),
            "desc".to_string(),
            None,
            String::new(),
            true,
        );
        let path = created.path.unwrap();
        // Corrupt the frontmatter (missing closing fence).
        fs::write(&path, "---\nname: broken\ndescription: not closed\n").unwrap();

        let res = update_skill(path.clone(), None, None, None, None, Some(false));
        assert!(!res.ok);
        let err = res.error.unwrap().to_lowercase();
        assert!(err.contains("frontmatter") && err.contains("invalid"));
        // File should be unchanged.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, "---\nname: broken\ndescription: not closed\n");
    }

    #[test]
    fn list_skills_for_settings_marks_corrupt_frontmatter_as_parse_failed() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        let skills_root = tmp.path().join(".claude").join("skills").join("broken");
        fs::create_dir_all(&skills_root).unwrap();
        // No closing fence — parse_frontmatter returns None.
        fs::write(skills_root.join("SKILL.md"), "---\nname: broken\n").unwrap();

        let list = list_skills_for_settings(folder).unwrap();
        let broken = list.iter().find(|s| s.name == "broken").unwrap();
        assert!(broken.parse_failed);
        // Disabled by default so the renderer doesn't show it as "active".
        assert!(!broken.enabled);
    }

    #[test]
    fn list_skills_for_settings_includes_disabled_entries() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().to_string_lossy().to_string();
        // Create one enabled, one disabled skill.
        create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "alpha".to_string(),
            "first".to_string(),
            None,
            String::new(),
            true,
        );
        create_skill(
            "workspace".to_string(),
            Some(folder.clone()),
            "beta".to_string(),
            "second".to_string(),
            None,
            String::new(),
            false,
        );
        let list = list_skills_for_settings(folder).unwrap();
        let workspace_entries: Vec<&SkillForSettings> = list
            .iter()
            .filter(|s| s.source == "workspace")
            .collect();
        assert_eq!(workspace_entries.len(), 2);
        let beta = workspace_entries.iter().find(|s| s.name == "beta").unwrap();
        assert!(!beta.enabled);
        assert!(beta.raw.contains("user-invocable: false"));
    }
}
