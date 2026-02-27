# OFT Deployment Toolkit

Deploy an Omnichain Fungible Token (OFT) across **Arbitrum, Solana, Starknet, Sui, and TON** using LayerZero V2. One command, under 20 minutes, first-try success.

## Quick Start

```bash
# 1. Install dependencies
pnpm install
cd ton/lz-framework && pnpm install && cd ../..

# 2. Configure environment
cp .env.example .env
# Fill in: TOKEN_NAME, TOKEN_SYMBOL, private keys, RPC URLs, EXTRA_PATH
# See .env.example for all variables and descriptions

# 3. Generate Solana keypair (one-time)
mkdir -p target/deploy
solana-keygen new --no-passphrase -o target/deploy/oft-keypair.json

# 4. Build TON contracts
cd ton/lz-framework && pnpm build && cd ../..

# 5. Preview what will happen (no gas spent)
npx tsx toolkit/oft.ts deploy --dry-run

# 6. Deploy + wire + test all chains
npx tsx toolkit/oft.ts full --reset
```

## What You Need

- **Node 18+**, **pnpm**
- **Solana CLI** + **Anchor CLI** (if deploying Solana)
- **Sui CLI** (if deploying Sui)
- Funded wallets (minimums):

| Chain | Min Balance | Currency |
|-------|-----------|----------|
| Arbitrum | 0.01 | ETH |
| Solana | 5 | SOL |
| Starknet | 0.5 | STRK |
| Sui | 2 | SUI |
| TON | 3 | TON |

You can deploy a subset of chains with `--chains=arb,sol` (aliases: `arb`, `sol`, `stk`, `sui`, `ton`).

## Commands

```
npx tsx toolkit/oft.ts deploy  [--chains=arb,sol] [--dry-run]   Deploy contracts
npx tsx toolkit/oft.ts wire    [--chains=arb,sol] [--dry-run]   Wire all pathways
npx tsx toolkit/oft.ts test    [--chains=arb,sol] [--dry-run]   Test transfers
npx tsx toolkit/oft.ts full    [--chains=arb,sol] [--reset]     Deploy + wire + test
npx tsx toolkit/oft.ts status                                   Show progress
```

## How It Works

1. **Preflight** (~3s) -- Validates env vars, CLI tools, wallet balances, Starknet class hashes, Anchor.toml program ID. Zero gas spent. Aborts with clear errors if anything is wrong.
2. **Deploy** (~4 min) -- All chains in parallel. Contract addresses auto-captured to `.env`.
3. **Wire** (~3 min) -- 20 directional pathways wired in parallel lanes.
4. **Test** (~5 min) -- Cross-chain transfers to verify end-to-end delivery.

State is saved to `toolkit/state.json`. Re-running skips completed steps. Use `--reset` for a fresh start.

## Customizing for Your Token

Set two env vars in `.env`:
```
TOKEN_NAME=MyToken
TOKEN_SYMBOL=MTK
```

Everything else is automatic -- Sui Move source is generated from your symbol, EVM/Solana/Starknet/TON contracts read name/symbol from env. No source code editing needed.

## If Something Goes Wrong

The orchestrator catches common failures before spending gas. If a step fails:

```bash
npx tsx toolkit/oft.ts status          # See what succeeded/failed
npx tsx toolkit/oft.ts full            # Retry (skips completed steps)
npx tsx toolkit/oft.ts full --reset    # Start completely fresh
```

See the **[Troubleshooting](docs/deployment-guide.md#troubleshooting)** section for specific error messages and fixes.

## Documentation

| Doc | What it covers |
|-----|---------------|
| **[docs/deployment-guide.md](docs/deployment-guide.md)** | Full setup, prerequisites, chain-specific notes, safety checks, troubleshooting |
| **[docs/OFT_DEPLOYMENT_GUIDE.md](docs/OFT_DEPLOYMENT_GUIDE.md)** | Detailed per-chain manual deployment reference |
| **[docs/chains/](docs/chains/)** | Per-chain deployment journals with issue logs |
| **[.env.example](.env.example)** | All environment variables with descriptions |
