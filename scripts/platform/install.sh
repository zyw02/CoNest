#!/usr/bin/env bash
set -euo pipefail
conest_bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
conest_install_root="${CONEST_INSTALL_ROOT:-$HOME/conest-demo-0.6.4}"
conest_node_version="24.16.0"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) conest_target=linux-x64 ;;
  Darwin-x86_64) conest_target=darwin-x64 ;;
  Darwin-arm64) conest_target=darwin-arm64 ;;
  *) echo 'CoNest requires Linux x64 or macOS x64/arm64.' >&2; exit 1 ;;
esac
conest_node_directory="node-v$conest_node_version-$conest_target"
conest_archive="$conest_node_directory.tar.gz"
for conest_command in curl tar; do
  command -v "$conest_command" >/dev/null || { echo "Missing $conest_command" >&2; exit 1; }
done
if command -v sha256sum >/dev/null; then
  conest_hash_command=(sha256sum)
elif command -v shasum >/dev/null; then
  conest_hash_command=(shasum -a 256)
else
  echo 'Install sha256sum or shasum to verify Node.js.' >&2; exit 1
fi
mkdir -p "$conest_install_root/node-downloads" "$conest_install_root/node"
cd "$conest_install_root/node-downloads"
curl -fLO "https://nodejs.org/dist/v$conest_node_version/$conest_archive"
curl -fLO "https://nodejs.org/dist/v$conest_node_version/SHASUMS256.txt"
# Require the exact archive entry; checking all available files can pass without it.
conest_expected="$(awk -v file="$conest_archive" '$2 == file { print $1 }' SHASUMS256.txt)"
[[ "$conest_expected" =~ ^[0-9a-f]{64}$ ]] || { echo 'Node.js checksum entry missing or invalid.' >&2; exit 1; }
conest_actual="$("${conest_hash_command[@]}" "$conest_archive")"
[[ "${conest_actual%% *}" == "$conest_expected" ]] || { echo 'Node.js checksum mismatch.' >&2; exit 1; }
tar -xzf "$conest_archive" -C "$conest_install_root/node"
conest_node="$conest_install_root/node/$conest_node_directory/bin/node"
"$conest_node" "$conest_bundle_dir/setup.mjs" "$conest_install_root"
cat > "$conest_install_root/start.sh" <<START
#!/usr/bin/env bash
set -euo pipefail
conest_launch_root="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
exec "\$conest_launch_root/node/$conest_node_directory/bin/node" "\$conest_launch_root/launch.mjs" "\$@"
START
chmod 755 "$conest_install_root/start.sh"
printf '\nInstallation complete. Verify with: bash "%s/start.sh" --verify\n' "$conest_install_root"
