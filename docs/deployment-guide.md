# OFT Deployment Guide

Deploy and wire an OFT (Omnichain Fungible Token) across any combination of Arbitrum, Solana, Starknet, Sui, and TON using the orchestrator. Target: under 20 minutes, first-try success.

For the detailed per-chain manual reference, see [OFT_DEPLOYMENT_GUIDE.md](./OFT_DEPLOYMENT_GUIDE.md).

---

## Prerequisites

- **Node 18+** and **pnpm** installed
- **Solana CLI** + **Anchor CLI** installed (if deploying Solana)
- **Sui CLI** installed (if deploying Sui)
- Dependencies installed:
  ```bash
  pnpm install                              # Root project
  cd ton/lz-framework && pnpm install && cd ../..  # TON subproject (if deploying TON)
  ```
- `.env` configured (copy `.env.example` → `.env`):
  - `TOKEN_NAME` and `TOKEN_SYMBOL` — **required**, your token's name and symbol
  - Private keys and RPC URLs for each target chain
  - `EXTRA_PATH` — full paths to directories containing `solana`, `anchor`, `cargo-build-sbf` binaries
- For Solana: keypair must exist at `target/deploy/oft-keypair.json`:
  ```bash
  mkdir -p target/deploy
  solana-keygen new --no-passphrase -o target/deploy/oft-keypair.json
  ```
  The orchestrator auto-syncs `Anchor.toml` program ID with this keypair before building.
- For Sui: Move source is auto-generated from `TOKEN_NAME`/`TOKEN_SYMBOL` (no manual editing needed)
- For TON: build artifacts via `cd ton/lz-framework && pnpm build`
- For TON: optionally set `TOKEN_METADATA_URI` to your token's JSON metadata URL

### Wallet Funding

| Chain | Minimum Balance | Currency | Notes |
|-------|----------------|----------|-------|
| Arbitrum | 0.01 | ETH | Cheapest chain |
| Solana | 5 | SOL | Program deploy is expensive |
| Starknet | 0.5 | STRK | Account deploy + contract deploy + roles |
| Sui | 2 | SUI | Two package publishes + init |
| TON | 3 | TON | Jetton + adapter + config TXs at 0.3+ each |

### EXTRA_PATH

The `.env` `EXTRA_PATH` variable must include directories containing `solana`, `solana-keygen`, `anchor`, `cargo-build-sbf`, and `sui` binaries. The orchestrator auto-expands `~` to `$HOME`, but explicit full paths are safer:

```
EXTRA_PATH=/home/you/.cargo/bin:/home/you/.local/share/solana/install/active_release/bin:/home/you/.avm/bin
```

---

## Quick Start

```bash
# 0. Configure environment and build prerequisites (one-time setup)
cp .env.example .env
# Fill in: TOKEN_NAME, TOKEN_SYMBOL, private keys, RPC URLs, EXTRA_PATH

pnpm install
cd ton/lz-framework && pnpm install && pnpm build && cd ../..
mkdir -p target/deploy
solana-keygen new --no-passphrase -o target/deploy/oft-keypair.json  # skip if exists

# Deploy + wire + test all 5 chains
npx tsx toolkit/oft.ts full --reset

# Or step by step:
npx tsx toolkit/oft.ts deploy               # Deploy all chains in parallel
npx tsx toolkit/oft.ts wire                  # Wire all pathways
npx tsx toolkit/oft.ts test --amount=1      # Test cross-chain transfers
```

### Deploy a Subset of Chains

```bash
# Only Arbitrum + Solana
npx tsx toolkit/oft.ts full --chains=arb,sol --reset

# Add Starknet later (Arb + Sol already deployed, will be skipped)
npx tsx toolkit/oft.ts full --chains=arb,sol,stk
```

Chain aliases: `arb`, `sol`, `stk`, `sui`, `ton`.

### Preview Without Executing

```bash
npx tsx toolkit/oft.ts deploy --dry-run
```

Shows exactly what will happen (which chains need deploy, which are already done) without any on-chain transactions.

---

## Architecture

```
toolkit/
├── oft.ts                      # CLI entry point (commands: deploy, wire, test, full, status)
├── state.json                  # Persisted state — deploy/wire/test status per chain
├── constants.ts                # Chain registry, DVN addresses, gas table, endpoint addresses
└── orchestrator/
    ├── deploy.ts               # Parallel deploy across selected chains
    ├── wire.ts                 # Parallel wire — one lane per source chain
    ├── test.ts                 # Cross-chain transfer tests
    ├── preflight.ts            # Deep preflight (class hashes, toolchain, balances)
    ├── runner.ts               # Subprocess spawner — tees output, parses [OFT_RESULT] tags
    ├── env.ts                  # .env read/write/update (atomic writes)
    └── state.ts                # JSON state persistence (toolkit/state.json)
```

### How It Works

1. **Preflight** (~3s): Validates env vars, CLI tools, wallet balances, Starknet class hashes, Anchor.toml program ID, stale Sui artifacts. All checks run in parallel via `Promise.allSettled()`. Aborts with clear messages if anything is wrong. Zero on-chain cost.

2. **Deploy** (~4 min): Runs selected chain deploy scripts in parallel. Each script emits `[OFT_RESULT] KEY=VALUE` tags in stdout which the orchestrator captures and writes to `.env`. Bottleneck is Solana (`anchor build` ~3 min).

3. **Wire** (~3 min): Groups wiring by source chain into parallel lanes (from-EVM, from-Solana, etc.). Within each lane, TXs are sequential to avoid nonce collisions. Each pathway sets peer, enforced options, and DVN config.

4. **Test** (~5 min): Sends a small amount from Arbitrum to each destination and back. Verifies end-to-end message delivery.

### Resume & State

State is persisted in `toolkit/state.json`:
- Re-running `deploy` skips already-completed chains
- Re-running `wire` skips already-wired pathways
- `--reset` flag deletes `state.json` for a fresh start
- Check current state: `npx tsx toolkit/oft.ts status`

---

## Pre-Deploy Checklist

The orchestrator's preflight system validates all of these automatically before spending any gas:

- [ ] `TOKEN_NAME` and `TOKEN_SYMBOL` set in `.env`
- [ ] All required env vars set (private keys, RPCs, deployer addresses)
- [ ] CLI tools callable (`solana`, `anchor`, `solana-keygen`, `cargo-build-sbf`, `sui` on PATH)
- [ ] Wallet balances sufficient on all target chains
- [ ] Starknet class hashes declared on mainnet (prevents lost funds)
- [ ] Anchor.toml `[programs.mainnet]` program ID matches `target/deploy/oft-keypair.json`
- [ ] No stale Sui `Published.toml` files blocking re-publish
- [ ] TON build artifacts exist (or will be built)

If any check fails, the orchestrator prints a clear error and aborts before any on-chain transaction.

---

## Chain-Specific Notes

### Arbitrum (EVM)
- Uses `hardhat deploy --tags MyOFT`, NOT `lz:deploy` (which is interactive and cannot be automated)
- Cheapest and fastest to deploy (~30s)
- Endpoint: `0x1a44076050125825900e736c501f859c50fE728c`

### Solana
- `anchor build` needs `cargo-build-sbf` on PATH (via `EXTRA_PATH` in .env)
- Anchor.toml program ID is **auto-synced** with `target/deploy/oft-keypair.json` before build
- `solana program deploy` uses `--program-id` flag to deploy to deterministic address
- Longest deploy step (~3 min for anchor build)
- DVN config requires **DvnConfig PDA addresses**, NOT DVN program IDs

### Starknet
- Class hashes must be **pre-declared on mainnet** — the preflight verifies all 3 (Account, ERC20, Adapter)
- Deploying with an undeclared class hash creates an unreachable address and **loses funds permanently**
- Account deployment is counterfactual (address derived from class hash + salt)
- starknet.js v9 uses object constructors: `new Account({ provider, address, signer })`
- ERC20 roles use **shortstring** encoding, NOT `getSelectorFromName`
- RPC env var: accepts either `STARKNET_RPC_URL` or `RPC_STARKNET`

### Sui
- **Package ID = peer address** (NOT Object ID) — the #1 gotcha
- Two-package pattern: Token Package (OTW coin) + OFT Package (LZ integration)
- **Coin type** (`SUI_COIN_TYPE`) is auto-detected from the token publish TX and saved to `.env`; all scripts read it from there
- Stale `Published.toml` files are **auto-deleted** before publish
- 5-second delay between `initOft` and `registerOApp` for RPC indexing
- Guard: if OFT Object or AdminCap can't be parsed from TX output, throws with diagnostic dump instead of proceeding with invalid IDs
- `@mysten/sui` must be v1.x (v2 has breaking changes; LZ SDK needs ^1.33.0)

### TON
- Build artifacts required before deploy (`pnpm build` in `ton/lz-framework/`)
- TX value must be >= 0.3 TON per operation (0.1 causes action phase failure)
- Peer address = raw 256-bit hash (NOT bounceable address format)
- Some pathways (Stk↔TON, Sui↔TON) are blocked — LZ has not deployed endpoints on TON for these

---

## Safety Checks Built Into the Orchestrator

These were all discovered by losing time or money in previous deployments. They are now handled automatically — listed here so you understand what's protected:

| # | What Could Go Wrong | Cost of Failure | How It's Prevented |
|---|---------------------|----------------|-------------------|
| 1 | Starknet class hash not declared on mainnet | **Lost funds** (unreachable address) | `preflight.ts` + `deploy-starknet.ts` call `getClass()` for all 3 hashes before any TX |
| 2 | `~` in EXTRA_PATH not expanded by Node.js | Builds fail (`anchor: not found`) | `runner.ts` expands `~` → `$HOME` before prepending to PATH |
| 3 | Anchor.toml has stale program ID | Build produces wrong binary | `deploy.ts` auto-syncs with `oft-keypair.json` before `anchor build` |
| 4 | `solana program deploy` without `--program-id` | Deploys to random address | `deploy.ts` always passes `--program-id target/deploy/oft-keypair.json` |
| 5 | Sui `Published.toml` from prior deployment | `sui client publish` refuses | `deploy.ts` auto-deletes before publish (only when no existing package ID in .env) |
| 6 | Sui RPC hasn't indexed objects between TXs | `registerOApp` fails (object not found) | `deploy-sui.ts` adds 5s delay between `initOft` and `registerOApp` |
| 7 | Sui `initOft` creates objects but parser misses them | `registerOApp` called with garbage IDs | `deploy-sui.ts` throws with full diagnostic dump instead of proceeding |

---

## Customizing for a New Token

### Step 1: Set env vars (required)

Add to your `.env`:
```
TOKEN_NAME=MyToken
TOKEN_SYMBOL=MTK
```

These are read by all deploy scripts (EVM, Solana, Starknet, Sui, TON). The preflight validates they are set before any on-chain transaction.

### Sui Move source — auto-generated

The orchestrator **automatically generates** the Sui Move source from `TOKEN_SYMBOL` and `TOKEN_NAME`. No manual editing needed.

When you run `deploy` (or `full`), the orchestrator:
1. Derives the Move module name from `TOKEN_SYMBOL` (lowercased: `MTK` → `mtk`)
2. Generates `sui/token/sources/mtk.move` with the correct module, OTW struct, symbol, and display name
3. Generates `sui/token/Move.toml` with the matching package name
4. Removes any old `.move` files and stale `build/` artifacts
5. Auto-detects `SUI_COIN_TYPE` from the publish TX output and saves it to `.env`

The generation is idempotent — if the source already matches your token, it's skipped. If you change `TOKEN_SYMBOL`, the old source is replaced automatically.

**Requirement:** `TOKEN_SYMBOL` must be a valid Move identifier (starts with a letter, alphanumeric + underscore only). Symbols like `MTK`, `GOLD`, `OFT_V2` work. Symbols like `123TOKEN` or `MY-TOKEN` will fail with a clear error.

### Step 2: Optional — TON metadata URI

Set `TOKEN_METADATA_URI` in `.env` to point to your token's JSON metadata (used by TON Jetton):
```
TOKEN_METADATA_URI=https://example.com/metadata/mytoken.json
```

### Step 3: Optional — EVM contract name

The Solidity contract is `contracts/MyOFT.sol`. To change the contract name itself (not just the token name/symbol), also update `deploy/MyOFT.ts` and `hardhat.config.ts` references.

### What you do NOT need to change

- The orchestrator itself (`toolkit/oft.ts`, `toolkit/orchestrator/*.ts`) — fully parameterized
- Sui Move source (`sui/token/`) — auto-generated from TOKEN_NAME/TOKEN_SYMBOL
- Wire/send templates (`toolkit/templates/*.ts`) — read from env vars
- TON FunC source code — the Jetton code is generic; only the metadata changes
- Constants (`toolkit/constants.ts`) — chain/DVN/gas config is token-independent

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing TOKEN_NAME or TOKEN_SYMBOL` | Not set in .env | Add `TOKEN_NAME=YourToken` and `TOKEN_SYMBOL=TKN` to .env |
| `Set SUI_COIN_TYPE in .env` | Coin type not auto-detected | Run deploy first (orchestrator sets it), or set manually: `SUI_COIN_TYPE=0xPKG::module::STRUCT` |
| `anchor: command not found` | Missing from PATH | Add full path to `EXTRA_PATH` in .env |
| `class hash not declared` | Wrong class hash or wrong network | Verify on starkscan.co; check env var overrides |
| `already been published` | Stale `Published.toml` | Auto-fixed by orchestrator; manually: delete `sui/*/Published.toml` |
| `nonce too low` | Parallel EVM TXs | Orchestrator serializes per lane; don't run EVM scripts manually in parallel |
| `No gas config for destination: sol` | Short name not resolved | Fixed; `getGasConfig` resolves short names |
| Anchor.toml program ID mismatch | Old ID from prior deploy | Auto-fixed by orchestrator before `anchor build` |
| Sui `registerOApp` fails after `initOft` | RPC indexing lag | 5s delay added between steps (auto-handled) |
| Starknet deploy loses funds | Undeclared class hash | Preflight validates all class hashes before any TX |
| `solana-keygen: not found` | Missing from EXTRA_PATH | Add Solana install bin to EXTRA_PATH |
| Preflight says "Could not check balance" | RPC timeout or wrong URL | Non-fatal warning; check RPC URL in .env |

---

## Expected Timeline

| Phase | Duration | What Happens |
|-------|----------|-------------|
| Preflight | ~3s | All checks run in parallel (RPC reads, tool checks, balance checks) |
| Deploy (parallel) | ~4 min | Arb (30s), Sol (3m anchor build), Stk (2m), Sui (1.5m), TON (2m) |
| Wire (parallel lanes) | ~3 min | All pathways, grouped by source chain |
| Test | ~5 min | Send + receive across each pathway |
| **Total** | **~8 min** | First-try success |

With network variance and rate limits, this fits comfortably under 20 minutes.

---

## Key References

- `toolkit/constants.ts` — DVN addresses (per-chain), gas table, endpoint addresses, pathway status
- `toolkit/orchestrator/preflight.ts` — All preflight check implementations
- `docs/OFT_DEPLOYMENT_GUIDE.md` — Detailed manual per-chain deployment reference
- `docs/chains/*.md` — Per-chain deployment journals with issue logs
