# Third-party notices

CoNest's original code is licensed under [MIT](LICENSE). Dependencies, imported assets and upstream code retain their own copyright and license terms; the root license does not replace them.

- **DSH / Cordis SDK:** the pinned development snapshot retains upstream package licenses, the DeepSeek root MIT license, original package manifests and SDK file hashes. See [dependency provenance](docs/dependencies.md) and `scripts/maintenance/sdk.lock.json`.
- **OpenClaw:** the pinned host and provider are separate upstream packages. OpenClaw's [MIT license](https://github.com/openclaw/openclaw/blob/main/LICENSE) and the notices in the installed packages remain applicable.
- **Other JavaScript and native dependencies:** review their installed license/notice files and the locked versions. Native libraries can have different terms from their JavaScript wrappers.
- **Vendored icons:** [Octicons](docs/assets/readme/LICENSE-octicons) retains its MIT notice; [Lucide/Feather](docs/assets/readme/LICENSE-lucide) retains its ISC/MIT notices. Origins are recorded beside the assets.

Release packaging retains dependency notices under `node_modules/`, bundled Studio notices under `dist/studio-licenses/`, and a generated `runtime-lock.json` with actual package versions and content hashes. The release's generated third-party notice supplements this source inventory. Preserve these files when redistributing an artifact; adding or updating a dependency requires reviewing its actual terms.
