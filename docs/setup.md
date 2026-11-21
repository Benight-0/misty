# Setup

## Requirements

- Node.js 22.19 or later for the Archival application and its SQLite-backed tests
- Python 3.12 for the agent runtime and Python tools
- A configured agent CLI for model-backed work
- Optional Docker, Go, Cloudflare and connected-account applications for the corresponding integrations
- Windows and the .NET SDK for the desktop overlay

## Archival

```sh
npm ci
```

Copy `.env.example` to `.env` and configure your own installation. On PowerShell use `Copy-Item .env.example .env`; on Linux/macOS use `cp .env.example .env`.

`npm start` serves the local interface at `http://127.0.0.1:8787`. An empty checkout has no conversations. Configure a collector or Matrix source before expecting imported messages. Bridge configuration, registrations and linked-device sessions must be generated for the new installation; they are intentionally not distributed.

Owner identities use `MISTY_OWNER_DISCORD_ID`, `MISTY_OWNER_WHATSAPP_PHONE`, `MISTY_OWNER_WHATSAPP_LID` and optional `MISTY_OWNER_MATRIX_ID`. An unset connected-account identity grants no owner authority. Test identities are supplied only by the test preload.

The optional VM entry point is `app/vm-server.mjs`. External hosting requires `ARCHIVAL_PUBLIC_ORIGIN`, `ARCHIVAL_ACCESS_EMAIL`, `CF_ACCESS_ISSUER` and `CF_ACCESS_AUD`, plus separately provisioned credential files. Review the service paths and permissions before installation.

## Misty runtime

```sh
python -m venv .venv
```

Activate the environment, install `prominence/requirements.txt`, then copy `prominence/config.example.json` to `prominence/config.json`. Set your bot token, verified owner ID, enabled channels, agent CLI and private data directory. This configuration is separate from the Node service's environment.

Use `python prominence/supervise.py` only after reviewing and completing the configuration. See [runtime documentation](misty-prominence.md) for the bridge and service architecture.

## Optional components

- Build collectors from `collector/` and `collector/cmd/misty-bot-gateway/` with Go.
- Build the Windows overlay from `desktop/Misty.Overlay/` with the .NET SDK.
- Install the browser extension from `chrome/misty-activity/` only for the intended profile.
- Build the attributed laptop-tool bundle with the instructions in `tooling/cline/NOTICE.md` and `docs/cline-tools-and-dependencies.md`.

Review scripts before using them. No installer is run automatically by this repository.

## Checks

```sh
npm test
python scripts/run-python-tests.py
python -m unittest discover -s metrics -p "test_*.py"
```

Python tests may require the packages in `prominence/requirements.txt`. Go and Windows rendering tests have separate toolchain requirements.

See [validation](validation.md) for known failures and verified checks.