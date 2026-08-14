// dsh-plugin-manager Tauri backend: direct file access to DSH profiles.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value as Json;

fn dsh_home() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")).join(".dsh")
}

fn profiles_dir() -> PathBuf {
    dsh_home().join("profiles")
}

fn profile_dir(name: &str) -> PathBuf {
    profiles_dir().join(name)
}

#[derive(Serialize)]
struct PluginInfo {
    id: String,
    name: String,
    source: String,
    kind: String,
    disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<Json>,
}

#[tauri::command]
fn list_profiles() -> Vec<String> {
    let dir = profiles_dir();
    let mut out: Vec<String> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| e.file_name() != "node_modules")
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => vec![],
    };
    out.sort();
    out
}

fn read_json(path: &Path) -> Option<Json> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn bundles_of(profile: &str) -> Vec<String> {
    let manifest = read_json(&profile_dir(profile).join("package.json"));
    manifest
        .and_then(|m| m.get("dsh")?.get("profile")?.get("bundles").cloned())
        .and_then(|b| serde_json::from_value::<Vec<String>>(b).ok())
        .unwrap_or_default()
}

fn patch_entries(profile: &str) -> Vec<serde_yaml::Value> {
    let path = profile_dir(profile).join("cordis.patch.yml");
    match fs::read_to_string(&path) {
        Ok(s) => serde_yaml::from_str(&s).unwrap_or(serde_yaml::Value::Sequence(vec![])),
        Err(_) => serde_yaml::Value::Sequence(vec![]),
    }
    .as_sequence()
    .cloned()
    .unwrap_or_default()
}

fn bundle_package(profile: &str, name: &str) -> Option<Json> {
    let dir = profile_dir(profile);
    for cand in [
        dir.join("node_modules").join(name).join("package.json"),
        profiles_dir().join("node_modules").join(name).join("package.json"),
    ] {
        if let Some(p) = read_json(&cand) {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
fn list_plugins(profile: String) -> Vec<PluginInfo> {
    use std::collections::BTreeMap;
    let mut by_id: BTreeMap<String, PluginInfo> = BTreeMap::new();

    for entry in patch_entries(&profile) {
        if let Some(seq) = entry.get("insert").and_then(|v| v.as_sequence()) {
            for ins in seq {
                if let Some(id) = ins.get("id").and_then(|v| v.as_str()) {
                    let name = ins.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
                    by_id.insert(id.to_string(), PluginInfo {
                        id: id.to_string(), name, source: "patch".into(), kind: "insert".into(),
                        disabled: false, version: None, description: None, config: None,
                    });
                }
            }
            continue;
        }
        if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
            let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
            let disabled = entry.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let config = entry.get("config").cloned().and_then(|c| serde_json::from_value(serde_yaml_to_json(c)).ok());
            by_id.insert(id.to_string(), PluginInfo {
                id: id.to_string(), name, source: "patch".into(), kind: "row".into(),
                disabled, version: None, description: None, config,
            });
        }
    }

    for name in bundles_of(&profile) {
        let id = name.rsplit('/').next().unwrap_or(&name).to_string();
        let pkg = bundle_package(&profile, &name);
        let existing = by_id.get(&id);
        let info = PluginInfo {
            id: id.clone(),
            name: name.clone(),
            source: "bundle".into(),
            kind: "bundle".into(),
            disabled: existing.map(|e| e.disabled).unwrap_or(false),
            version: pkg.as_ref().and_then(|p| p.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())),
            description: pkg.as_ref().and_then(|p| p.get("description").and_then(|v| v.as_str()).map(|s| s.to_string())),
            config: existing.and_then(|e| e.config.clone()),
        };
        by_id.insert(id, info);
    }

    by_id.into_values().collect()
}

fn serde_yaml_to_json(v: serde_yaml::Value) -> Json {
    match v {
        serde_yaml::Value::Null => Json::Null,
        serde_yaml::Value::Bool(b) => Json::Bool(b),
        serde_yaml::Value::Number(n) => Json::Number(n.as_i64().map(|i| i.into()).unwrap_or(Json::Null)),
        serde_yaml::Value::String(s) => Json::String(s),
        serde_yaml::Value::Sequence(seq) => Json::Array(seq.into_iter().map(serde_yaml_to_json).collect()),
        serde_yaml::Value::Mapping(m) => {
            let mut o = serde_json::Map::new();
            for (k, v) in m {
                if let Some(k) = k.as_str() {
                    o.insert(k.to_string(), serde_yaml_to_json(v));
                }
            }
            Json::Object(o)
        }
        _ => Json::Null,
    }
}

#[tauri::command]
fn set_plugin_disabled(profile: String, id: String, disabled: bool) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("cordis.patch.yml");
    let content = fs::read_to_string(&path).unwrap_or_default();
    let mut doc: serde_yaml::Value = if content.trim().is_empty() {
        serde_yaml::Value::Sequence(vec![])
    } else {
        serde_yaml::from_str(&content).unwrap_or(serde_yaml::Value::Sequence(vec![]))
    };
    let seq = doc.as_sequence_mut().ok_or("patch root is not a list")?;
    let mut found = false;
    for entry in seq.iter_mut() {
        if entry.get("id").and_then(|v| v.as_str()) == Some(id.as_str()) {
            let map = entry.as_mapping_mut().ok_or("entry is not a mapping")?;
            if disabled {
                map.insert(serde_yaml::Value::String("disabled".into()), serde_yaml::Value::Bool(true));
            } else {
                map.remove(&serde_yaml::Value::String("disabled".into()));
            }
            found = true;
            break;
        }
    }
    if !found {
        let mut map = serde_yaml::Mapping::new();
        map.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(id.clone()));
        map.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(id));
        map.insert(serde_yaml::Value::String("disabled".into()), serde_yaml::Value::Bool(disabled));
        seq.push(serde_yaml::Value::Mapping(map));
    }
    fs::write(&path, serde_yaml::to_string(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "id": id, "disabled": disabled }))
}

#[tauri::command]
fn set_bundle(profile: String, name: String, enabled: bool) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    let manifest_path = dir.join("package.json");
    let mut manifest = read_json(&manifest_path).unwrap_or(serde_json::json!({}));
    let dsh = manifest.get_mut("dsh").or_insert(serde_json::json!({}));
    let prof = dsh.get_mut("profile").or_insert(serde_json::json!({}));
    let mut bundles: Vec<String> = prof
        .get("bundles").and_then(|b| serde_json::from_value(b.clone()).ok())
        .unwrap_or_default();
    if enabled {
        if !bundles.contains(&name) { bundles.push(name); }
    } else {
        bundles.retain(|b| b != &name);
    }
    prof["bundles"] = serde_json::json!(bundles);
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "name": name, "enabled": enabled, "bundles": bundles }))
}

#[tauri::command]
fn set_bundle_order(profile: String, bundles: Vec<String>) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    let manifest_path = dir.join("package.json");
    let mut manifest = read_json(&manifest_path).unwrap_or(serde_json::json!({}));
    let dsh = manifest.get_mut("dsh").or_insert(serde_json::json!({}));
    let prof = dsh.get_mut("profile").or_insert(serde_json::json!({}));
    prof["bundles"] = serde_json::json!(bundles);
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "bundles": bundles }))
}

#[tauri::command]
fn export_profile(profile: String) -> Json {
    serde_json::json!({
        "profile": profile,
        "bundles": bundles_of(&profile),
        "plugins": list_plugins(profile),
    })
}

#[tauri::command]
fn install_plugin(profile: String, package: String) -> Json {
    let output = Command::new("dsh")
        .args(["plugin", "--profile", &profile, "add", &package])
        .output();
    match output {
        Ok(o) => serde_json::json!({ "ok": o.status.success(), "status": o.status.code(), "output": String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr) }),
        Err(e) => serde_json::json!({ "ok": false, "output": e.to_string() }),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_profiles, list_plugins, set_plugin_disabled, set_bundle, set_bundle_order, export_profile, install_plugin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
