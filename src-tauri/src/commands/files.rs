use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Serialize)]
pub struct Attachment {
    pub id: String,
    #[serde(rename = "type")]
    pub att_type: String,
    pub filename: String,
    pub path: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ReadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Check if a path is sensitive (should never be accessed)
fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let sensitive_patterns = [
        ".env",
        "credentials",
        ".ssh",
        ".gnupg",
        ".aws/credentials",
        "keychain",
        ".npmrc",
        ".pypirc",
    ];
    sensitive_patterns.iter().any(|p| lower.contains(p))
}

/// Validate path containment (prevent traversal)
fn validate_containment(base: &str, target: &str) -> bool {
    let base_canon = match fs::canonicalize(base) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let target_path = Path::new(base).join(target);
    let target_canon = match fs::canonicalize(&target_path) {
        Ok(p) => p,
        Err(_) => {
            // File might not exist yet — check parent
            if let Some(parent) = target_path.parent() {
                match fs::canonicalize(parent) {
                    Ok(p) => p,
                    Err(_) => return false,
                }
            } else {
                return false;
            }
        }
    };
    target_canon.starts_with(&base_canon)
}

#[tauri::command]
pub fn save_file(
    folder_path: String,
    file_name: String,
    data: String,
    mime_type: String,
) -> SaveResult {
    let uploads_dir = Path::new(&folder_path).join(".octopal").join("uploads");
    if fs::create_dir_all(&uploads_dir).is_err() {
        return SaveResult {
            ok: false,
            attachment: None,
            error: Some("Failed to create uploads directory".to_string()),
        };
    }

    let id = Uuid::new_v4().to_string();
    let ext = mime_type
        .split('/')
        .last()
        .unwrap_or("bin")
        .replace("jpeg", "jpg")
        .replace("plain", "txt");
    let safe_name = format!("{}_{}.{}", id.chars().take(8).collect::<String>(),
        file_name.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect::<String>(),
        ext);
    let file_path = uploads_dir.join(&safe_name);

    // data is base64 encoded
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&data) {
        Ok(d) => d,
        Err(_) => {
            // Try as raw text
            data.as_bytes().to_vec()
        }
    };

    match fs::write(&file_path, &decoded) {
        Ok(_) => {
            let att_type = if mime_type.starts_with("image/") {
                "image"
            } else {
                "file"
            };
            let relative = format!(
                ".octopal/uploads/{}",
                safe_name
            );
            SaveResult {
                ok: true,
                attachment: Some(Attachment {
                    id,
                    att_type: att_type.to_string(),
                    filename: file_name,
                    path: relative,
                    mime_type,
                    size: decoded.len() as u64,
                }),
                error: None,
            }
        }
        Err(e) => SaveResult {
            ok: false,
            attachment: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn read_file_base64(folder_path: String, relative_path: String) -> ReadResult {
    if is_sensitive_path(&relative_path) {
        return ReadResult {
            ok: false,
            data: None,
            error: Some("Access denied: sensitive path".to_string()),
        };
    }

    if !validate_containment(&folder_path, &relative_path) {
        return ReadResult {
            ok: false,
            data: None,
            error: Some("Path traversal denied".to_string()),
        };
    }

    let file_path = Path::new(&folder_path).join(&relative_path);
    match fs::read(&file_path) {
        Ok(bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ReadResult {
                ok: true,
                data: Some(encoded),
                error: None,
            }
        }
        Err(e) => ReadResult {
            ok: false,
            data: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn get_absolute_path(folder_path: String, relative_path: String) -> Result<String, String> {
    let abs = Path::new(&folder_path).join(&relative_path);
    let resolved = abs
        .canonicalize()
        .unwrap_or(abs.clone());
    Ok(resolved.to_string_lossy().to_string())
}
