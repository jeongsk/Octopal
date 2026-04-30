use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Tiny YAML-frontmatter parser. We only need a flat string-valued subset
/// (`name`, `description`, `argument-hint`, `user-invocable`, `disable-model-invocation`),
/// so dragging in `serde_yaml` is overkill. Returns `None` if no frontmatter
/// block is present.
///
/// Handles inline scalars (`key: value`, with optional surrounding quotes)
/// and block scalars (`key: |` literal, `key: >` folded) with indented
/// continuation lines — the form most Claude Code skills use for their
/// long-form `description`.
fn parse_frontmatter(content: &str) -> Option<std::collections::HashMap<String, String>> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
