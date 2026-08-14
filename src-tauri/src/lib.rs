// dsh-plugin-manager Tauri backend: direct file access to DSH profiles.
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
    // prevent path traversal: profile names must be a single path segment
    let base = name.split(|c| c == '/' || c == '\\').last().unwrap_or(name).to_string();
    let safe = if base.contains("..") { base.replace("..", "_") } else { base };
    profiles_dir().join(safe)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    has_bundle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_client: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    insert_ids: Option<Vec<String>>,
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

fn bundle_insert_ids(profile: &str, name: &str) -> Vec<(String, String)> {
    let candidates = [
        profile_dir(profile).join("node_modules").join(name).join("cordis.patch.yml"),
        profiles_dir().join("node_modules").join(name).join("cordis.patch.yml"),
    ];
    for c in candidates {
        if let Ok(s) = fs::read_to_string(&c) {
            if let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&s) {
                if let Some(seq) = v.as_sequence() {
                    let mut rows = Vec::new();
                    for entry in seq {
                        if let Some(ins) = entry.get("insert").and_then(|x| x.as_sequence()) {
                            for item in ins {
                                if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                                    let nm = item.get("name").and_then(|x| x.as_str()).unwrap_or(id).to_string();
                                    rows.push((id.to_string(), nm));
                                }
                            }
                        }
                    }
                    if !rows.is_empty() { return rows; }
                }
            }
        }
    }
    vec![]
}

#[tauri::command]
fn list_plugins(profile: String) -> Vec<PluginInfo> {
    use std::collections::{BTreeMap, HashSet};
    let mut by_id: BTreeMap<String, PluginInfo> = BTreeMap::new();

    // real insert ids per bundle (short id -> set), for folding patch rows into bundles
    let bundles = bundles_of(&profile);
    let mut bundle_inserts: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut all_insert_ids: HashSet<String> = HashSet::new();
    for name in &bundles {
        let rows = bundle_insert_ids(&profile, name);
        if !rows.is_empty() {
            let short = name.rsplit('/').next().unwrap_or(name).to_string();
            bundle_inserts.insert(short, rows.clone());
            for (rid, _) in &rows { all_insert_ids.insert(rid.clone()); }
        }
    }
    // disabled/config carried by patch rows that belong to a bundle
    let mut row_disabled: BTreeMap<String, bool> = BTreeMap::new();
    let mut row_config: BTreeMap<String, Json> = BTreeMap::new();

    for entry in patch_entries(&profile) {
        if let Some(seq) = entry.get("insert").and_then(|v| v.as_sequence()) {
            for ins in seq {
                if let Some(id) = ins.get("id").and_then(|v| v.as_str()) {
                    if all_insert_ids.contains(id) { continue; }
                    let name = ins.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
                    by_id.insert(id.to_string(), PluginInfo {
                        id: id.to_string(), name, source: "patch".into(), kind: "insert".into(),
                        disabled: false, version: None, description: None, config: None, has_bundle: None, has_client: None, author: None, license: None, insert_ids: None,
                    });
                }
            }
            continue;
        }
        if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
            let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
            let disabled = entry.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let config = entry.get("config").cloned().and_then(|c| serde_json::from_value(serde_yaml_to_json(c)).ok());
            if all_insert_ids.contains(id) {
                row_disabled.insert(id.to_string(), disabled);
                if config.is_some() { row_config.insert(id.to_string(), config.unwrap()); }
                continue;
            }
            by_id.insert(id.to_string(), PluginInfo {
                id: id.to_string(), name, source: "patch".into(), kind: "row".into(),
                disabled, version: None, description: None, config, has_bundle: None, has_client: None, author: None, license: None, insert_ids: None,
            });
        }
    }

    for name in bundles {
        let id = name.rsplit('/').next().unwrap_or(&name).to_string();
        let pkg = bundle_package(&profile, &name);
        let dsh = pkg.as_ref().and_then(|p| p.get("dsh"));
        let insert_rows = bundle_inserts.get(&id).cloned().unwrap_or_default();
        let disabled = if !insert_rows.is_empty() {
            insert_rows.iter().all(|(rid, _)| row_disabled.get(rid).copied().unwrap_or(false))
        } else {
            by_id.get(&id).map(|e| e.disabled).unwrap_or(false)
        };
        let config = insert_rows.iter().find_map(|(rid, _)| row_config.get(rid).cloned())
            .or_else(|| by_id.get(&id).and_then(|e| e.config.clone()));
        let info = PluginInfo {
            id: id.clone(),
            name: name.clone(),
            source: "bundle".into(),
            kind: "bundle".into(),
            disabled,
            version: pkg.as_ref().and_then(|p| p.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())),
            description: pkg.as_ref().and_then(|p| p.get("description").and_then(|v| v.as_str()).map(|s| s.to_string())),
            config,
            has_bundle: dsh.and_then(|d| d.get("bundle")).map(|_| true),
            has_client: dsh.and_then(|d| d.get("client")).map(|_| true),
            author: pkg.as_ref().and_then(|p| p.get("author").and_then(|v| v.as_str()).map(|s| s.to_string())),
            license: pkg.as_ref().and_then(|p| p.get("license").and_then(|v| v.as_str()).map(|s| s.to_string())),
            insert_ids: if insert_rows.is_empty() { None } else { Some(insert_rows.iter().map(|(r, _)| r.clone()).collect()) },
        };
        by_id.insert(id, info);
    }

    by_id.into_values().collect()
}

fn serde_yaml_to_json(v: serde_yaml::Value) -> Json {
    match v {
        serde_yaml::Value::Null => Json::Null,
        serde_yaml::Value::Bool(b) => Json::Bool(b),
        serde_yaml::Value::Number(n) => Json::Number(n.as_i64().map(|i| serde_json::Number::from(i)).unwrap_or(serde_json::Number::from(0))),
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

fn patch_row_set_disabled(doc: &mut serde_yaml::Value, id: &str, name: &str, disabled: bool) {
    let seq = doc.as_sequence_mut().unwrap();
    let mut found = false;
    for entry in seq.iter_mut() {
        if entry.get("id").and_then(|v| v.as_str()) == Some(id) {
            let map = entry.as_mapping_mut().unwrap();
            if name != id {
                map.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(name.into()));
            }
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
        map.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(id.into()));
        map.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(name.into()));
        if disabled {
            map.insert(serde_yaml::Value::String("disabled".into()), serde_yaml::Value::Bool(true));
        }
        seq.push(serde_yaml::Value::Mapping(map));
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
    if doc.as_sequence().is_none() {
        doc = serde_yaml::Value::Sequence(vec![]);
    }
    // bundle id (package short name): expand to the package's real inserted rows (id + canonical name)
    let full = bundles_of(&profile).into_iter().find(|b| b.rsplit('/').next().unwrap_or(b) == id);
    let rows: Vec<(String, String)> = match full {
        Some(f) => {
            let r = bundle_insert_ids(&profile, &f);
            if r.is_empty() { vec![(id.clone(), id.clone())] } else { r }
        }
        None => vec![(id.clone(), id.clone())],
    };
    for (rid, rname) in &rows {
        patch_row_set_disabled(&mut doc, rid, rname, disabled);
    }
    atomic_write(&path, &serde_yaml::to_string(&doc).map_err(|e| e.to_string())?)?;
    Ok(serde_json::json!({ "id": id, "disabled": disabled }))
}

#[tauri::command]
fn set_bundle(profile: String, name: String, enabled: bool) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    let manifest_path = dir.join("package.json");
    let mut manifest = read_json(&manifest_path).unwrap_or(serde_json::json!({}));
    if manifest.get("dsh").is_none() { manifest["dsh"] = serde_json::json!({}); }
    let dsh = manifest.get_mut("dsh").unwrap();
    if dsh.get("profile").is_none() { dsh["profile"] = serde_json::json!({}); }
    let prof = dsh.get_mut("profile").unwrap();
    let mut bundles: Vec<String> = prof
        .get("bundles").and_then(|b| serde_json::from_value::<Vec<String>>(b.clone()).ok())
        .unwrap_or_default();
    if enabled {
        if !bundles.contains(&name) { bundles.push(name.clone()); }
    } else {
        bundles.retain(|b| b != &name);
    }
    prof["bundles"] = serde_json::json!(bundles);
    atomic_write(&manifest_path, &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)?;
    Ok(serde_json::json!({ "name": name, "enabled": enabled, "bundles": bundles }))
}

#[tauri::command]
fn set_bundle_order(profile: String, bundles: Vec<String>) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    let manifest_path = dir.join("package.json");
    let mut manifest = read_json(&manifest_path).unwrap_or(serde_json::json!({}));
    if manifest.get("dsh").is_none() { manifest["dsh"] = serde_json::json!({}); }
    let dsh = manifest.get_mut("dsh").unwrap();
    if dsh.get("profile").is_none() { dsh["profile"] = serde_json::json!({}); }
    let prof = dsh.get_mut("profile").unwrap();
    prof["bundles"] = serde_json::json!(bundles);
    atomic_write(&manifest_path, &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)?;
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


fn backup_file(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("cfg");
    let bak = path.with_extension(format!("{}.{}.bak", ext, stamp));
    fs::copy(path, &bak).map_err(|e| e.to_string())?;
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    backup_file(path)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn dsh_running(port: u16) -> bool {
    #[cfg(target_os = "windows")]
    {
        let ps = format!("Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue", port);
        let out = Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output();
        match out { Ok(o) => o.status.success() && !o.stdout.is_empty(), Err(_) => false }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let sh = format!("lsof -iTCP:{} -sTCP:LISTEN >/dev/null 2>&1", port);
        let out = Command::new("sh").args(["-c", &sh]).output();
        match out { Ok(o) => o.status.success(), Err(_) => false }
    }
}

#[tauri::command]
fn dsh_status(port: Option<u16>) -> Json {
    let p = port.unwrap_or(3080);
    serde_json::json!({ "running": dsh_running(p), "port": p })
}

#[tauri::command]
fn start_dsh(profile: String, port: Option<u16>) -> Json {
    // "dsh web" is correct (= dsh --profile web); putting --profile after web
    // fails because it is not a web option. Boot web (the default UI).
    let _ = profile;
    let mut cmd: Vec<String> = vec!["web".into()];
    if let Some(p) = port {
        cmd.push("--port".into());
        cmd.push(p.to_string());
    }
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .arg("/c").arg("start").arg("").arg("dsh")
        .args(&cmd)
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("sh")
        .args(["-c", &format!("nohup dsh {} >/dev/null 2>&1 &", cmd.join(" "))])
        .spawn();
    match result {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn stop_dsh(port: Option<u16>) -> Json {
    let p = port.unwrap_or(3080);
    #[cfg(target_os = "windows")]
    let result = Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("$c = Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($c) {{ Stop-Process -Id $c -Force -ErrorAction SilentlyContinue }}", p)])
        .output();
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("sh")
        .args(["-c", &format!("pid=$(lsof -tiTCP:{} -sTCP:LISTEN 2>/dev/null); if [ -n \"$pid\" ]; then kill $pid 2>/dev/null; fi", p)])
        .output();
    match result {
        Ok(o) => serde_json::json!({ "ok": o.status.success() }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn profile_info(profile: String) -> Json {
    let dir = profile_dir(&profile);
    serde_json::json!({
        "profile": profile,
        "dir": dir.to_string_lossy(),
        "bundles": bundles_of(&profile),
        "hasPatch": dir.join("cordis.patch.yml").exists(),
        "hasManifest": dir.join("package.json").exists(),
    })
}

fn json_to_serde_yaml(v: Json) -> serde_yaml::Value {
    match v {
        Json::Null => serde_yaml::Value::Null,
        Json::Bool(b) => serde_yaml::Value::Bool(b),
        Json::Number(n) => serde_yaml::Value::Number(n.as_i64().map(|i| i.into()).unwrap_or(serde_yaml::Number::from(0))),
        Json::String(s) => serde_yaml::Value::String(s),
        Json::Array(a) => serde_yaml::Value::Sequence(a.into_iter().map(json_to_serde_yaml).collect()),
        Json::Object(o) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, v) in o { m.insert(serde_yaml::Value::String(k), json_to_serde_yaml(v)); }
            serde_yaml::Value::Mapping(m)
        }
    }
}

fn patch_row_set_config(doc: &mut serde_yaml::Value, id: &str, name: &str, config: Option<&Json>) {
    let seq = doc.as_sequence_mut().unwrap();
    let mut found = false;
    for entry in seq.iter_mut() {
        if entry.get("id").and_then(|v| v.as_str()) == Some(id) {
            let map = entry.as_mapping_mut().unwrap();
            if name != id {
                map.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(name.into()));
            }
            match config {
                Some(c) => {
                    map.insert(serde_yaml::Value::String("config".into()), json_to_serde_yaml(c.clone()));
                }
                None => { map.remove(&serde_yaml::Value::String("config".into())); }
            }
            found = true;
            break;
        }
    }
    if !found {
        let mut map = serde_yaml::Mapping::new();
        map.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(id.into()));
        map.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(name.into()));
        if let Some(c) = config {
            map.insert(serde_yaml::Value::String("config".into()), json_to_serde_yaml(c.clone()));
        }
        seq.push(serde_yaml::Value::Mapping(map));
    }
}

#[tauri::command]
fn set_plugin_config(profile: String, id: String, config: Option<Json>) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("cordis.patch.yml");
    let content = fs::read_to_string(&path).unwrap_or_default();
    let mut doc: serde_yaml::Value = if content.trim().is_empty() {
        serde_yaml::Value::Sequence(vec![])
    } else {
        serde_yaml::from_str(&content).unwrap_or(serde_yaml::Value::Sequence(vec![]))
    };
    if doc.as_sequence().is_none() {
        doc = serde_yaml::Value::Sequence(vec![]);
    }
    // bundle id (package short name): expand to real insert rows
    let full = bundles_of(&profile).into_iter().find(|b| b.rsplit('/').next().unwrap_or(b) == id);
    let rows: Vec<(String, String)> = match full {
        Some(f) => {
            let r = bundle_insert_ids(&profile, &f);
            if r.is_empty() { vec![(id.clone(), id.clone())] } else { r }
        }
        None => vec![(id.clone(), id.clone())],
    };
    for (rid, rname) in &rows {
        patch_row_set_config(&mut doc, rid, rname, config.as_ref());
    }
    atomic_write(&path, &serde_yaml::to_string(&doc).map_err(|e| e.to_string())?)?;
    Ok(serde_json::json!({ "id": id, "config": config }))
}

#[tauri::command]
fn search_npm(query: String) -> Json {
    let out = Command::new("npm").args(["search", &query, "--json"]).output();
    match out {
        Ok(o) if o.status.success() => {
            if let Ok(list) = serde_json::from_slice::<Vec<Json>>(&o.stdout) {
                let results: Vec<Json> = list.into_iter().map(|p| serde_json::json!({
                    "name": p.get("name").cloned().unwrap_or(Json::Null),
                    "version": p.get("version").cloned().unwrap_or(Json::Null),
                    "description": p.get("description").cloned().unwrap_or(Json::Null),
                })).collect();
                return serde_json::json!(results);
            }
            serde_json::json!([])
        }
        Ok(_) => serde_json::json!({ "error": "npm search failed" }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

#[tauri::command]
fn import_profile(profile: String, bundles: Option<Vec<String>>, patch: Option<Json>) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(b) = bundles {
        let manifest_path = dir.join("package.json");
        let mut manifest = read_json(&manifest_path).unwrap_or(serde_json::json!({}));
        if manifest.get("dsh").is_none() { manifest["dsh"] = serde_json::json!({}); }
        let dsh = manifest.get_mut("dsh").unwrap();
        if dsh.get("profile").is_none() { dsh["profile"] = serde_json::json!({}); }
        dsh.get_mut("profile").unwrap()["bundles"] = serde_json::json!(b);
        atomic_write(&manifest_path, &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)?;
    }
    if let Some(p) = patch {
        let patch_path = dir.join("cordis.patch.yml");
        let doc = json_to_serde_yaml(p);
        atomic_write(&patch_path, &serde_yaml::to_string(&doc).map_err(|e| e.to_string())?)?;
    }
    Ok(serde_json::json!({ "profile": profile, "imported": true }))
}

#[tauri::command]
fn open_plugin_repo(app: tauri::AppHandle, profile: String, name: String) -> Json {
    let url = bundle_package(&profile, &name).and_then(|p| {
        p.get("repository").and_then(|r| {
            r.get("url").and_then(|u| u.as_str()).map(|s| s.to_string())
                .or_else(|| r.as_str().map(|s| s.to_string()))
        })
    });
    match url {
        Some(u) => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(u.clone(), None::<String>);
            serde_json::json!({ "ok": true, "url": u })
        }
        None => serde_json::json!({ "ok": false, "error": "no repository" }),
    }
}

#[tauri::command]
fn open_dshbase(app: tauri::AppHandle) -> Json {
    use tauri_plugin_opener::OpenerExt;
    let url = "https://dshbase.com";
    let result = app.opener().open_url(url.to_string(), None::<String>);
    match result {
        Ok(_) => serde_json::json!({ "ok": true, "url": url }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

// lightweight semver compare: returns true if a is a newer version than b.
fn version_newer(a: &str, b: &str) -> bool {
    fn parse(v: &str) -> (Vec<u64>, String) {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, p.to_string()),
            None => (v, String::new()),
        };
        let mut nums: Vec<u64> = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
        while nums.len() < 3 { nums.push(0); }
        (nums, pre)
    }
    let (na, prea) = parse(a);
    let (nb, preb) = parse(b);
    for i in 0..3 {
        if na[i] != nb[i] { return na[i] > nb[i]; }
    }
    match (prea.is_empty(), preb.is_empty()) {
        (true, true) => false,
        (true, false) => true,   // release > prerelease
        (false, true) => false,
        (false, false) => prea > preb,
    }
}

fn npm_latest(name: &str) -> Option<String> {
    let out = Command::new("npm").args(["view", name, "version"]).output().ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() { return Some(s); }
    }
    None
}

fn dsh_local_version() -> Option<String> {
    let out = Command::new("dsh").args(["-V"]).output().ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() { return Some(s); }
    }
    None
}

#[tauri::command]
fn check_dsh_update() -> Json {
    let local = dsh_local_version();
    let latest = npm_latest("@deepseek-ai/dsh");
    let has_update = match (&local, &latest) {
        (Some(l), Some(n)) => version_newer(n, l),
        (None, Some(_)) => true,
        _ => false,
    };
    serde_json::json!({ "local": local, "latest": latest, "hasUpdate": has_update })
}

#[tauri::command]
fn update_dsh() -> Json {
    let output = Command::new("npm")
        .args(["i", "-g", "@deepseek-ai/dsh"])
        .output();
    match output {
        Ok(o) => serde_json::json!({ "ok": o.status.success(), "status": o.status.code(), "output": String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
fn check_updates(profile: String) -> Json {
    let mut out = Vec::new();
    let mut handles = Vec::new();
    for p in list_plugins(profile.clone()) {
        if p.kind == "bundle" {
            if let Some(local) = p.version {
                let name = p.name.clone();
                handles.push(std::thread::spawn(move || {
                    let latest = npm_latest(&name);
                    (name, local, latest)
                }));
            }
        }
    }
    for h in handles {
        if let Ok((name, local, latest)) = h.join() {
            let has = latest.as_ref().is_some_and(|l| version_newer(l, &local));
            out.push(serde_json::json!({
                "id": name.split('/').next_back().unwrap_or(&name),
                "name": name, "local": local,
                "latest": latest, "hasUpdate": has,
            }));
        }
    }
    serde_json::json!(out)
}
#[tauri::command]
fn update_plugin(profile: String, name: String) -> Json {
    let output = Command::new("dsh")
        .args(["plugin", "--profile", &profile, "update", &name])
        .output();
    match output {
        Ok(o) => serde_json::json!({ "ok": o.status.success(), "status": o.status.code(), "output": String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

fn bundle_dir(profile: &str, name: &str) -> Option<PathBuf> {
    let candidates = [
        profile_dir(profile).join("node_modules").join(name),
        profiles_dir().join("node_modules").join(name),
    ];
    candidates.into_iter().find(|c| c.is_dir())
}

#[tauri::command]
fn read_plugin_readme(profile: String, name: String) -> Json {
    // find README.md in the bundle package dir (any case), cap at 8KB
    let dir = bundle_dir(&profile, &name);
    let readme = dir.and_then(|d| {
        let candidates = ["README.md", "readme.md", "Readme.md", "README.MD"];
        candidates.iter().find_map(|f| {
            let p = d.join(f);
            p.is_file().then(|| fs::read_to_string(&p).ok())
        }).flatten()
    });
    match readme {
        Some(text) => {
            let capped: String = text.chars().take(8000).collect();
            serde_json::json!({ "ok": true, "readme": capped, "truncated": text.len() > 8000 })
        }
        None => serde_json::json!({ "ok": false, "error": "no README" }),
    }
}

#[tauri::command]
fn write_profile_files(profile: String, manifest: Option<String>, patch: Option<String>) -> Result<Json, String> {
    let dir = profile_dir(&profile);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut saved = Vec::new();
    if let Some(m) = manifest {
        let p = dir.join("package.json");
        atomic_write(&p, &m)?;
        saved.push("package.json");
    }
    if let Some(patch) = patch {
        let p = dir.join("cordis.patch.yml");
        atomic_write(&p, &patch)?;
        saved.push("cordis.patch.yml");
    }
    Ok(serde_json::json!({ "ok": true, "saved": saved }))
}

#[tauri::command]
fn read_profile_files(profile: String) -> Json {
    let dir = profile_dir(&profile);
    let manifest = fs::read_to_string(dir.join("package.json")).unwrap_or_default();
    let patch = fs::read_to_string(dir.join("cordis.patch.yml")).unwrap_or_default();
    serde_json::json!({
        "manifest": manifest,
        "patch": patch,
        "manifestExists": !manifest.is_empty(),
        "patchExists": !patch.is_empty(),
    })
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    static LOCK: Mutex<()> = Mutex::new(());

    fn setup() -> (PathBuf, std::sync::MutexGuard<'static, ()>) {
        let _guard = LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("dpm-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let prof = tmp.join("profiles/web");
        fs::create_dir_all(prof.join("node_modules/@deepseek-ai/dsh-base")).unwrap();
        fs::write(prof.join("node_modules/@deepseek-ai/dsh-base/package.json"), r#"{"name":"@deepseek-ai/dsh-base","version":"0.1.0","description":"test base"}"#).unwrap();
        fs::write(prof.join("package.json"), r#"{"name":"dsh-profile-web","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#).unwrap();
        fs::write(prof.join("cordis.patch.yml"), "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n").unwrap();
        std::env::set_var("DSH_HOME", &tmp);
        (tmp, _guard)
    }

    #[test]
    fn lists_bundles_and_patch_rows() {
        let (tmp, _g) = setup();
        let plugins = list_plugins("web".to_string());
        let ids: Vec<&str> = plugins.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"tool-web"), "patch row listed: {:?}", ids);
        assert!(ids.contains(&"dsh-base"), "bundle listed: {:?}", ids);
        let base = plugins.iter().find(|p| p.id == "dsh-base").unwrap();
        assert_eq!(base.version.as_deref(), Some("0.1.0"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn toggles_disabled_flag_roundtrip() {
        let (tmp, _g) = setup();
        set_plugin_disabled("web".into(), "tool-web".into(), true).unwrap();
        let disabled = list_plugins("web".to_string()).iter().find(|p| p.id == "tool-web").unwrap().disabled;
        assert!(disabled);
        set_plugin_disabled("web".into(), "tool-web".into(), false).unwrap();
        let reenabled = list_plugins("web".to_string()).iter().find(|p| p.id == "tool-web").unwrap().disabled;
        assert!(!reenabled);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn adds_and_removes_bundle() {
        let (tmp, _g) = setup();
        set_bundle("web".into(), "@deepseek-ai/dsh-web-app".into(), true).unwrap();
        assert!(bundles_of("web").contains(&"@deepseek-ai/dsh-web-app".to_string()));
        set_bundle("web".into(), "@deepseek-ai/dsh-web-app".into(), false).unwrap();
        assert!(!bundles_of("web").contains(&"@deepseek-ai/dsh-web-app".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reorders_bundles() {
        let (tmp, _g) = setup();
        set_bundle("web".into(), "@deepseek-ai/dsh-web-app".into(), true).unwrap();
        let ordered = vec!["@deepseek-ai/dsh-web-app".to_string(), "@deepseek-ai/dsh-base".to_string()];
        set_bundle_order("web".into(), ordered).unwrap();
        assert_eq!(bundles_of("web"), vec!["@deepseek-ai/dsh-web-app".to_string(), "@deepseek-ai/dsh-base".to_string()]);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backup_file_created_on_mutation() {
        let (tmp, _g) = setup();
        let prof = profile_dir("web");
        set_plugin_disabled("web".into(), "tool-web".into(), true).unwrap();
        let backups = fs::read_dir(&prof).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".bak")).count();
        assert!(backups >= 1, "backup created");
        let _ = fs::remove_dir_all(&tmp);
    }
}

#[tauri::command]
fn purge_third_party(profile: String, purge: bool) -> Result<Json, String> {
    let mut affected = 0;
    for p in list_plugins(profile.clone()) {
        let official = p.name.starts_with("@deepseek-ai/");
        if official { continue; }
        set_plugin_disabled(profile.clone(), p.id.clone(), purge)?;
        affected += 1;
    }
    Ok(serde_json::json!({ "purged": purge, "affected": affected }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_profiles, list_plugins, set_plugin_disabled, set_bundle, set_bundle_order, export_profile, install_plugin,
            dsh_status, start_dsh, stop_dsh, profile_info, set_plugin_config, search_npm, import_profile, open_plugin_repo, check_updates, purge_third_party,
            read_plugin_readme, read_profile_files, write_profile_files, open_dshbase, update_plugin, check_dsh_update, update_dsh
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
