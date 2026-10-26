#!/bin/sh
# Install the RabidAI rig on a fresh box.
#
#   ./rig/install.sh            install into $HOME (idempotent; existing files are backed up)
#   ./rig/install.sh --dry-run  print what would happen, write nothing
#
# What it sets up:
#   ~/.local/share/llama-v100/   manager, presets, proxy, tool filter (paths @HOME@-templated)
#   ~/.local/bin/                llama-manager, llama-server, llama-server-stock, llama-proxy, llama-toolfilter
#   ~/.rabid/agent/ config.yml + models.yml for the rabid profile (only if absent)
#   ~/models/                    created empty — weights are installed by hand (see rig/models.list)
#
# What it does NOT do: download weights, install llama.cpp, or start anything.
set -eu

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
rig="$repo_dir/rig"
app_dir="$HOME/.local/share/llama-v100"
bin_dir="$HOME/.local/bin"
# The `rabid` launcher sets PI_CONFIG_DIR=.rabid, which resolves to $HOME/.rabid — not
# $HOME/.omp/profiles/rabid. Install where the launcher actually reads.
profile_dir="$HOME/.rabid/agent"
models_dir="$HOME/models"

say() { printf '%b\n' "$*"; }
run() { if [ "$dry" = 1 ]; then say "  would: $*"; else "$@"; fi; }

# Copy one templated file, substituting @HOME@; keep a backup of anything replaced.
install_file() {
	src="$1"; dest="$2"; mode="$3"
	if [ "$dry" = 1 ]; then say "  would install $dest ($mode)"; return; fi
	mkdir -p "$(dirname "$dest")"
	tmp=$(mktemp)
	sed "s|@HOME@|$HOME|g" "$src" > "$tmp"
	if [ -f "$dest" ] && ! cmp -s "$dest" "$tmp"; then
		cp "$dest" "$dest.bak-install-$(date +%Y%m%d-%H%M%S)"
	fi
	mv "$tmp" "$dest"
	chmod "$mode" "$dest"
}

say "RabidAI rig installer"
say "  rig:     $rig"
say "  target:  $app_dir"
[ "$dry" = 1 ] && say "  (dry run — nothing is written)"

say "\n[0/5] prerequisites this installer cannot provide"
missing_prereqs=0
for cmd in bun python3 hf nvidia-smi; do
	if command -v "$cmd" >/dev/null 2>&1; then
		say "  ok:       $cmd"
	else
		missing_prereqs=$((missing_prereqs + 1))
		say "  missing:  $cmd"
	fi
done
for bin in "$HOME/.local/opt/llama.cpp/llama-server" "$HOME/.local/opt/llama-prism/llama-server"; do
	if [ -x "$bin" ]; then
		say "  ok:       $bin"
	else
		missing_prereqs=$((missing_prereqs + 1))
		say "  missing:  $bin   (llama.cpp build; the V100 needs the CUDA 12.8 prebuilt)"
	fi
done

say "\n[1/5] manager, router presets, gateway"
# The repo splits by role; the runtime directory stays flat because manager.py reads
# models.ini and index.html from its own directory.
install_file "$rig/manager/manager.py" "$app_dir/manager.py" 644
install_file "$rig/manager/index.html" "$app_dir/index.html" 644
for f in models.ini models-1cat.ini models-stock.ini; do
	install_file "$rig/router/$f" "$app_dir/$f" 644
done
install_file "$rig/gateway/proxy.py" "$app_dir/proxy.py" 644
install_file "$rig/gateway/toolfilter.py" "$app_dir/toolfilter.py" 644

say "\n[2/5] command wrappers"
for f in llama-manager llama-server llama-server-stock llama-proxy llama-toolfilter; do
	install_file "$rig/bin/$f" "$bin_dir/$f" 755
done

say "\n[3/5] rabid agent dir ($HOME/.rabid)"
if [ -f "$profile_dir/config.yml" ]; then
	say "  config.yml exists — left untouched; template available at rig/omp-profile/config.yml"
else
	install_file "$rig/omp-profile/config.yml" "$profile_dir/config.yml" 600
fi
if [ -f "$profile_dir/models.yml" ]; then
	say "  models.yml exists — left untouched; template available at rig/omp-profile/models.yml"
else
	install_file "$rig/omp-profile/models.yml" "$profile_dir/models.yml" 644
fi

say "\n[4/5] models"
run mkdir -p "$models_dir"
missing=0
if [ -f "$rig/models.list" ]; then
	while IFS='|' read -r file repo note; do
		case "$file" in ''|'#'*) continue;; esac
		if [ -f "$models_dir/$file" ]; then
			say "  present:  $file"
		else
			missing=$((missing + 1))
			say "  missing:  $file   →  hf download $repo $file --local-dir $models_dir"
			[ -n "$note" ] && say "            $note"
		fi
	done < "$rig/models.list"
fi

say ""
if [ "$missing_prereqs" != 0 ]; then
	say "Prerequisites still missing: $missing_prereqs (see [0/5] above)."
	say ""
fi
say "Done. Next:"
say "  1. install the missing weights above (any llama.cpp-compatible GGUF)",
say "  2. edit $app_dir/models.ini if your model ids/paths differ"
say "  3. llama-manager start   → http://localhost:8090"
say "  4. rabid   (the SLM worker auto-loads on the first turn)"
[ "$missing" = 0 ] && say "" || say "\n$missing model file(s) still missing."
