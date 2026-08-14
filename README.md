# dsh-plugin-manager

A **desktop GUI** to manage DSH plugins across profiles — inspired by
[cc-switch](https://github.com/farion1231/cc-switch). Built with
**Tauri 2** (Rust backend + web frontend), exactly like cc-switch.

It is an **independent desktop app**, **not a DSH plugin**: it reads and edits
your DSH profile files (`~/.dsh/profiles/<name>/`) directly and never hooks
into DSH.

## Features

- List plugins per profile (merge of `dsh.profile.bundles` + `cordis.patch.yml`)
- Status badges: enabled / disabled, source (bundle / patch), version + description
- One-click **enable / disable** (patches `cordis.patch.yml` rows)
- **Add / remove / drag-and-drop reorder** of bundles (`dsh.profile.bundles`)
- **Install** packages via `dsh plugin add`
- **Export** the profile's plugin view as JSON
- Search filter, light/dark theme, profile switcher, live refresh

## Develop

```bash
npm install              # tauri cli
npx tauri dev            # run the desktop app (Rust backend + web frontend)
```

## Build

```bash
npx tauri build          # produces the desktop bundle (Windows / macOS / Linux)
```

## WebUI fallback

The same frontend also runs standalone in a browser for quick inspection:

```bash
node lib/cli.mjs         # http://127.0.0.1:5177 (fetch API mode)
```

## Backend (Tauri commands)

| Command | Description |
|---------|-------------|
| `list_profiles` | profiles under `~/.dsh/profiles` |
| `list_plugins` | merged plugin list for a profile |
| `set_plugin_disabled` | toggle a patch row's `disabled` flag |
| `set_bundle` | add/remove a `dsh.profile.bundles` entry |
| `set_bundle_order` | reorder bundles |
| `export_profile` | JSON export of the plugin view |
| `install_plugin` | `dsh plugin add` |

## Test

```bash
node test/api.mjs        # profiles logic against a throwaway profile (Node path)
```
