# dsh-plugin-manager

A lightweight, standalone GUI to **manage DSH plugins across profiles** — inspired by
[cc-switch](https://github.com/farion1231/cc-switch)'s provider manager. It is an
**independent tool** (plain Node + browser), **not a DSH plugin**: it reads and edits
your DSH profile files (`~/.dsh/profiles/<name>/`) directly and never hooks into DSH.

## Features

- List plugins per profile (merge of `dsh.profile.bundles` + `cordis.patch.yml` entries)
- Status badges: enabled / disabled, source (bundle / patch), version + description
- One-click **enable / disable** (patches `cordis.patch.yml` rows; bundle plugins stay in the list)
- **Add / remove bundles** (`dsh.profile.bundles`)
- **Install** a package via the official `dsh plugin --profile <p> add <pkg>`
- Profile switcher, live refresh, detail panel with config

## Usage

```bash
npx dsh-plugin-manager          # or: node lib/cli.mjs
# opens http://127.0.0.1:5177
```

```bash
PORT=8080 npx dsh-plugin-manager
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/profiles` | GET | list profiles |
| `/api/plugins?profile=<name>` | GET | merged plugin list |
| `/api/toggle` | POST | `{profile, id, disabled}` — set a plugin's disabled flag in `cordis.patch.yml` |
| `/api/bundle` | POST | `{profile, name, enabled}` — add/remove a `dsh.profile.bundles` entry |
| `/api/install` | POST | `{profile, package}` — `dsh plugin add` |

## Design notes

- **Reads DSH config files directly** (`$DSH_HOME` or `~/.dsh`); no DSH runtime dependency.
- Mutations are minimal and targeted: toggling only adds/removes `disabled: true` on the
  matching patch row; bundle ops edit `package.json` (preserving structure).
- Changes require restarting `dsh web` to take effect (loader reads config at boot).
- Cross-platform (Windows / macOS / Linux) — plain Node, no native deps beyond `yaml`.

## Test

```bash
node test/api.mjs   # runs against a throwaway profile, never touches real profiles
```
