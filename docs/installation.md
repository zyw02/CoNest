# Package installation and verification

This guide is for developers validating a built artifact. For source setup, use the [project startup guide](../README.md).
Use Node.js 24.16.0, pnpm 11.7.0 and an OpenClaw release in the declared compatibility range. Reproducible release packaging retains the 2026.9.2 build pin.

## Build an artifact

Run from the checkout root after installing dependencies:

```sh
pnpm run build
node scripts/prepare-native.mjs --target linux-x64 --out /absolute/native-linux --pty-build /absolute/rhel8-build/pty.node
node scripts/pack-release.mjs --target linux-x64 --native-dir /absolute/native-linux --out /absolute/packages
```

For Linux, supply `pty.node` built against the RHEL 8 / glibc 2.28 baseline; the native-asset preparer validates its required GLIBC symbols.

The builder stages a relocatable runtime dependency closure with licenses and a `runtime-lock.json`.
Documentation is explicitly enumerated; customer materials and local reports are excluded.
Use a new output directory for each candidate; existing archives are not overwritten.

## Check an isolated installation

```sh
node scripts/test-installation.mjs /absolute/packages/local-conest-connector-0.6.4.tgz --host-enhancements
```

The runner checks the companion SHA-256, installs outside the checkout, and verifies the
runtime, local profile and host integration using a deterministic model fixture.
It downloads the pinned host/provider but performs no paid inference without `--live`.

For manual plugin inspection in an isolated OpenClaw profile:

```sh
openclaw plugins install --force --accept-capabilities /absolute/packages/local-conest-connector-0.6.4.tgz
```

These flags explicitly trust the local artifact and its declared capabilities. Verify its checksum first.
Retain the plugin ID `dsh-bridge`; configure it using [host integration](host-integration.md#plugin-configuration).
Component upgrades do not replace Connector code; restart the Gateway when updating the package.

## Windows integration

Build with `--target win32-x64` and a matching `--native-dir`, then use
`python3 scripts/pack-windows.py --archive /absolute/package.tgz --out /absolute/windows`.
The archive must have a companion `.sha256` file. The wrapper includes the developer
installation guide and scripts from `scripts/platform/`.

In the resulting bundle, run `./install.ps1 -InstallRoot C:\conest-dev`, then
`./verify-windows.ps1 -InstallRoot C:\conest-dev` in PowerShell. `start.ps1 -Components`
checks the component graph; `start.ps1 -Verify -Core` checks the OpenClaw-only path.

The [Windows workflow](../.github/workflows/windows.yml) builds from source and runs
native Windows integration checks. Its result applies to the recorded commit and runner;
packaging alone does not establish Windows desktop compatibility.

## macOS integration

Both Intel (`darwin-x64`) and Apple Silicon (`darwin-arm64`) are admitted by the runtime, source installer and release builder. Use the pinned Node/pnpm versions above; source builds require Xcode Command Line Tools and Python 3. The Linux Landlock binary is optional and is excluded from macOS artifacts. DSH supplies its own macOS process and Seatbelt backends; existing component permissions still apply.

To build an Apple Silicon archive after `pnpm run build`:

```sh
node scripts/prepare-native.mjs --target darwin-arm64 --out /absolute/native-macos
node scripts/pack-release.mjs --target darwin-arm64 --native-dir /absolute/native-macos --out /absolute/packages
node scripts/pack-unix.mjs --target darwin-arm64 --archive /absolute/packages/local-conest-connector-0.6.4.tgz --out /absolute/bundles
```

Use `darwin-x64` for Intel. Native preparation verifies registry integrity and includes matching sharp/libvips, koffi, ripgrep, system/flock and node-pty assets. The pinned node-pty 1.1.0 prebuild requires its `spawn-helper` to be executable; both the source-install patch and archive preparation set that permission. macOS control sockets use a short private directory under `/tmp` to fit the Unix socket path limit even with a long system `TMPDIR`.

In the resulting `conest-0.6.4-darwin-arm64` (or `darwin-x64`) directory:

```sh
CONEST_INSTALL_ROOT="$HOME/conest-dev" bash install.sh
"$HOME/conest-dev/start.sh" --components
"$HOME/conest-dev/start.sh" --verify
"$HOME/conest-dev/start.sh" --verify --core
```

The installer selects the host architecture, downloads the pinned Node.js `.tar.gz`, verifies its exact SHA-256 entry with `sha256sum` or macOS `shasum`, and verifies the plugin checksum before installing. A bundle for the other architecture is rejected. The model fixture needs no API key and incurs no inference charges.

The [macOS workflow](../.github/workflows/macos.yml) runs source tests, native PTY/flock/image/FFI/ripgrep checks, isolated archive installation, service restart checks and deterministic Gateway acceptance on separate Intel and ARM runners. The `/proc` environment inspection is Linux-only; portable environment filtering remains covered by behavior tests. Cross-packaging on Linux validates archive contents and hashes; macOS execution requires a passing native runner result for the same revision.
