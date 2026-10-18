#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

run_ubuntu24_payload() {
  cd "$REPO_ROOT"
  . /etc/os-release
  if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
    echo "This test requires Ubuntu 24.04; detected ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi

  local node_major
  node_major="$(sed -nE 's/^[[:space:]]*node-version:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' .github/workflows/tests.yml | head -n 1)"
  if [[ ! "$node_major" =~ ^[0-9]+$ ]]; then
    echo "Could not read node-version from .github/workflows/tests.yml." >&2
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gcc-13 clang-18 xz-utils

  local compiler_bin_dir node_tmp_dir node_release_url node_archive node_sha256 node_bin_dir pnpm_version gcc_major clang_major
  compiler_bin_dir=/tmp/c-playground-ci-bin
  mkdir -p "$compiler_bin_dir"
  ln -sf /usr/bin/gcc-13 "$compiler_bin_dir/gcc"
  ln -sf /usr/bin/clang-18 "$compiler_bin_dir/clang"

  node_tmp_dir="$(mktemp -d)"
  node_release_url="https://nodejs.org/dist/latest-v${node_major}.x"
  curl -fsSL --retry 3 --retry-all-errors "$node_release_url/SHASUMS256.txt" -o "$node_tmp_dir/SHASUMS256.txt"
  node_archive="$(awk '$2 ~ /^node-v[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2; exit }' "$node_tmp_dir/SHASUMS256.txt")"
  case "$node_archive" in
    "node-v${node_major}."*-linux-x64.tar.xz) ;;
    *) echo "Could not find the Node ${node_major} x64 tarball in the official manifest." >&2; exit 1 ;;
  esac

  node_sha256="$(awk -v archive="$node_archive" '$2 == archive { print $1; exit }' "$node_tmp_dir/SHASUMS256.txt")"
  if [[ ! "$node_sha256" =~ ^[[:xdigit:]]{64}$ ]]; then
    echo "Could not find a valid SHA-256 for $node_archive." >&2
    exit 1
  fi
  curl -fsSL --retry 3 --retry-all-errors "$node_release_url/$node_archive" -o "$node_tmp_dir/$node_archive"
  printf '%s  %s\n' "$node_sha256" "$node_tmp_dir/$node_archive" | sha256sum --check --status
  mkdir -p /opt/c-playground-node
  tar --extract --xz --file="$node_tmp_dir/$node_archive" --directory=/opt/c-playground-node
  node_bin_dir="/opt/c-playground-node/${node_archive%.tar.xz}/bin"
  export PATH="$node_bin_dir:$compiler_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  pnpm_version="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const v = JSON.parse(readFileSync("package.json", "utf8")).packageManager; if (!/^pnpm@\d+\.\d+\.\d+$/.test(v ?? "")) process.exit(1); console.log(v.slice(5));')"
  npm install --global --no-audit --no-fund "pnpm@$pnpm_version"

  echo "Ubuntu: $PRETTY_NAME"
  echo "Node: $(node --version)"
  echo "pnpm: $(pnpm --version)"
  echo "GCC package: $(dpkg-query -W -f='${Version}' gcc-13)"
  gcc --version | head -n 1
  echo "Clang package: $(dpkg-query -W -f='${Version}' clang-18)"
  clang --version | head -n 1

  gcc_major="$(gcc -dumpversion)"
  clang_major="$(clang -dumpversion)"
  clang_major="${clang_major%%.*}"
  if [[ "$gcc_major" != 13 || "$clang_major" != 18 ]]; then
    echo "Expected GCC 13 and Clang 18; detected GCC $gcc_major and Clang $clang_major." >&2
    exit 1
  fi

  node --input-type=module -e 'import { spawnSync } from "node:child_process"; for (const compiler of ["gcc", "clang"]) { const result = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 5000 }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${compiler} --version exited ${result.status}: ${result.stderr}`); console.log(`Node child-process preflight: ${result.stdout.split(/\r?\n/, 1)[0]}`); }'

  pnpm install --frozen-lockfile
  pnpm test
}

if [[ "${1:-}" == --in-container ]]; then
  if [[ $# -ne 1 || ! -f /.dockerenv || "$(id -u)" -ne 0 ]]; then
    echo "The --in-container mode must run as root inside Docker." >&2
    exit 1
  fi
  run_ubuntu24_payload
  exit
fi

if [[ $# -ne 0 ]]; then
  echo "Usage: pnpm test:ci" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "pnpm test:ci requires Docker to use Ubuntu 24.04." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
ALL_FILES="$TMP_ROOT/files.all"
SNAPSHOT_FILES="$TMP_ROOT/files.snapshot"
SNAPSHOT_ARCHIVE="$TMP_ROOT/project.tar"

git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -z > "$ALL_FILES"
: > "$SNAPSHOT_FILES"

while IFS= read -r -d '' path; do
  case "$path" in
    .git|.git/*|*/.git|*/.git/*|\
    node_modules|node_modules/*|*/node_modules|*/node_modules/*|\
    dist|dist/*|*/dist|*/dist/*|\
    .env*|*/.env*|\
    .npmrc*|*/.npmrc*|npmrc|*/npmrc|\
    .yarnrc*|*/.yarnrc*|.pnpmrc*|*/.pnpmrc*|\
    .netrc|*/.netrc|.pypirc|*/.pypirc|\
    .aws|.aws/*|*/.aws|*/.aws/*|\
    .codex|.codex/*|*/.codex|*/.codex/*|\
    .agents|.agents/*|*/.agents|*/.agents/*|\
    .ssh|.ssh/*|*/.ssh|*/.ssh/*)
      continue
      ;;
  esac

  if [[ -e "$REPO_ROOT/$path" || -L "$REPO_ROOT/$path" ]]; then
    printf '%s\0' "$path" >> "$SNAPSHOT_FILES"
  fi
done < "$ALL_FILES"

tar --create --file="$SNAPSHOT_ARCHIVE" --directory="$REPO_ROOT" \
  --null --verbatim-files-from --files-from="$SNAPSHOT_FILES"

docker run --rm --platform=linux/amd64 \
  --mount "type=bind,src=$SNAPSHOT_ARCHIVE,dst=/tmp/c-playground-project.tar,readonly" \
  ubuntu:24.04 \
  bash -e -u -o pipefail -c 'mkdir -p /workspace && tar --extract --file=/tmp/c-playground-project.tar --directory=/workspace && cd /workspace && exec bash scripts/test-ci-ubuntu24.sh --in-container'
