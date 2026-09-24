#!/usr/bin/env bash
set -euo pipefail
conest_bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
conest_install_root="${CONEST_INSTALL_ROOT:-$HOME/conest-demo-0.6.3}"
[[ "$(uname -m)" == x86_64 ]] || { echo '此包要求 x86_64。' >&2; exit 1; }
for conest_command in curl tar xz; do command -v "$conest_command" >/dev/null || { echo "缺少 $conest_command，请先按教程安装系统依赖。" >&2; exit 1; }; done
mkdir -p "$conest_install_root/node-downloads" "$conest_install_root/node"
cd "$conest_install_root/node-downloads"
curl -fLO https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz
curl -fLO https://nodejs.org/dist/v24.16.0/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
tar -xJf node-v24.16.0-linux-x64.tar.xz -C "$conest_install_root/node"
conest_node="$conest_install_root/node/node-v24.16.0-linux-x64/bin/node"
"$conest_node" "$conest_bundle_dir/setup.mjs" "$conest_install_root"
cat > "$conest_install_root/start.sh" <<'START'
#!/usr/bin/env bash
set -euo pipefail
conest_launch_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$conest_launch_root/node/node-v24.16.0-linux-x64/bin/node" "$conest_launch_root/launch.mjs" "$@"
START
printf '\n安装完成。先自检：bash "%s/start.sh" --verify\n' "$conest_install_root"
