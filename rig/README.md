# RabidLLM rig

The local serving stack this fork runs against: one V100 for inference, one display
GPU, the manager web page, the router, and the SLM handoff worker. Clone, run the
installer, install the weights by hand, start the manager.

```
rig/
  install.sh          idempotent installer (templates @HOME@, backs up what it replaces)
  models.list         every GGUF the presets expect, with its hf repo
  manager/            manager.py (HTTP server :8090) + index.html (model cards, VRAM,
                      SLM worker panel, CPU/GPU load)
  router/             models.ini, models-1cat.ini, models-stock.ini — one section = one model id
  gateway/            proxy.py (tailnet front door) and toolfilter.py (:8101, strips tools)
  bin/                llama-manager, llama-server, llama-server-stock, llama-proxy, llama-toolfilter
  omp-profile/        config.yml + models.yml for `rabid`
```

The repo splits by role; `install.sh` flattens it on purpose: `manager.py` reads
`models.ini` and serves `index.html` from its own directory, so all five Python/HTML files
land side by side in `~/.local/share/llama-v100/`.

The harness itself is this repository (`rabid/packages/coding-agent`); `rig/` only carries the
serving stack around it.

## Install

Prerequisites, by hand (they are large binaries, not repo content):

- llama.cpp **stock** build at `~/.local/opt/llama.cpp` (CUDA 12.8 prebuilt; the V100 is
  Volta, so 13.x builds enumerate the card and die at kernel launch).
- llama.cpp **PrismML fork** at `~/.local/opt/llama-prism` (router build; required for
  ternary-weight models, superset otherwise).
- `bun`, `python3`, `hf` (`pip install -U huggingface_hub`).

Then:

```sh
git clone https://github.com/jaruizramon/RabidLLM.git && cd RabidLLM
./rig/install.sh            # --dry-run first if you want to see it
hf download ggml-org/SmolLM3-3B-GGUF SmolLM3-Q4_K_M.gguf --local-dir ~/models
llama-manager start         # http://localhost:8090
rabid
```

`install.sh` starts by reporting the prerequisites it cannot install — `bun`, `python3`, `hf`, `nvidia-smi`, the stock and PrismML `llama-server` binaries — then writes `~/.local/share/llama-v100/*`, the five `~/.local/bin` wrappers, and
`~/.rabid/agent/{config,models}.yml` **if absent** — that is where the `rabid` launcher reads (`PI_CONFIG_DIR=.rabid`), not `~/.omp/profiles/rabid`. It never overwrites a
config you already have; it leaves a timestamped `.bak-install-*` beside anything it does
replace. It creates `~/models` and prints the exact `hf download` line for every weight
`rig/models.list` is still missing from it.

## Ports

| Port | Owner | Notes |
|---|---|---|
| 8080 | router (`llama-server --models-preset`) | one resident model; hardware-reserved, never take it |
| 8090 | manager UI + `/api/*` | starts and stops the router |
| 8101 | tool filter | relays to 8080 without the stripped tools (`task`) |
| ephemeral | SLM worker | chosen by the harness or the manager; never a fixed port |

## The pieces

- **Router** (`llama-manager` → `manager.py` → `llama-server --models-preset models.ini`).
  Nothing autoloads: `load-on-startup = false`, `--no-models-autoload`, and the manager
  never calls `/models/load` by itself. Drag a card on the page to put weights in VRAM.
- **Manager page.** Model cards with measured VRAM, the target GPU with its VRAM bar,
  context parking, logs, plus two panels added for the handoff work:
  **SLM handoff worker** (load/stop a worker on `cuda:N` or CPU, with ctx, VRAM headroom,
  live worker CPU%/RSS) and **Load — CPU / GPU** (system CPU busy + load average, and one
  row per GPU with utilisation and memory).
- **SLM handoff worker.** A plain `llama-server` (not a router child — the router admits
  one model and loading a 4B through it would evict the session's model) that the omp fork
  drives, one stateless run per completed turn, to maintain a rolling handoff document.
  Compaction reads that document instead of re-summarising a saturated context. The
  harness spawns and owns its own worker; the manager panel is for loading one by hand —
  do not run both at once on the same GPU budget.

## Verification after install

```sh
llama-manager status                 # manager up, router up, nothing loaded
curl -s localhost:8090/api/state | jq '{slm:.slm.running, cpu:.cpu.busy_pct, gpus:[.gpu.devices[]|{index,util,used_mib}]}'
curl -s -X POST localhost:8090/api/slm/load -H 'content-type: application/json' \
     -d '{"model":"Spark-X2.5-4B-Q4_0","device":"cuda:1","ctx":8192,"gpuFreeMiB":2048}'
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader
curl -s -X POST localhost:8090/api/slm/unload -H 'content-type: application/json' -d '{}'
```

A 4B Q4 worker at 8K context needs ≈2.7 GB resident. Measured on an otherwise idle 8 GB
gaming card: `gpuFreeMiB: 2048` leaves room and runs at **95.9 tok/s**; `4096` spills part
of the model and drops to 21; `5120` leaves ~1 GB and collapses to **11.6 tok/s**. The
reservation must be ≤ card − 3.2 GB. A resident 2.8 GB service (a desktop/3D app) costs
~34 % even when both fit (63.2 tok/s), and if it leaves too little room the same 2048
reservation starves the worker — the historic 11.6 row in the README came from exactly that.
The inference card must stay untouched.

## Gotchas worth keeping

- `--load-mode none` replaced `--no-mmap` in llama.cpp b11026+.
- `llama-server` ignores SIGTERM; stop with INT first, then TERM/KILL.
- The router reads `models.ini` once at startup — restart it to pick up edits.
- `-fa on` is required for a quantized V cache.
- Volta has no bf16/fp8/INT4 tensor cores: quantized GGUF is the only path.
