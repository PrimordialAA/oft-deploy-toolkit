# OFT Deploy Toolkit - Project Instructions

## What This Is
An automated toolkit to deploy OFTs (Omnichain Fungible Tokens) using LayerZero V2 across 5 chains. Set two env vars (`TOKEN_NAME`, `TOKEN_SYMBOL`), run one command, get a fully deployed + wired cross-chain token.

## Project Structure
```
oft-deploy-toolkit/
├── contracts/              # Solidity OFT contract (EVM)
│   └── MyOFT.sol
├── deploy/                 # Hardhat deployment script
│   └── MyOFT.ts
├── programs/               # Solana Anchor program (Rust)
│   └── oft/
├── sui/
│   ├── token/              # Auto-generated from TOKEN_SYMBOL
│   └── oft/                # OFT Move package (LayerZero integration)
├── ton/
│   └── lz-framework/       # TON FunC++ contracts + build system
├── scripts/                # Chain deploy scripts (called by orchestrator)
│   ├── create-oft-solana.ts
│   ├── deploy-starknet.ts
│   ├── deploy-sui.ts
│   ├── deploy-ton-jetton.ts
│   └── deploy-ton-adapter.ts
├── toolkit/                # Orchestrator + deployment toolkit
│   ├── oft.ts              # CLI entry point
│   ├── constants.ts        # Chain registry, DVN addresses, gas table
│   ├── encoding.ts         # Address/peer encoding, options builder
│   ├── balances.ts         # Cross-chain balance checker
│   ├── test-parameterization.ts  # Unit tests (77 tests)
│   ├── orchestrator/       # Deployment pipeline
│   │   ├── deploy.ts       # Parallel deploy across chains
│   │   ├── wire.ts         # Parallel wire by source chain
│   │   ├── test.ts         # Cross-chain transfer tests
│   │   ├── preflight.ts    # Deep preflight validation
│   │   ├── runner.ts       # Subprocess spawner
│   │   ├── env.ts          # .env read/write
│   │   └── state.ts        # JSON state persistence
│   └── templates/          # Parameterized wire/send scripts
│       ├── wire-from-{evm,solana,starknet,sui,ton}.ts
│       └── send-from-{evm,solana,starknet,sui,ton}.ts
├── docs/
│   └── deployment-guide.md # Full setup, troubleshooting, architecture
├── .env.example            # All env vars documented
├── README.md               # Quick start guide
└── CLAUDE.md               # This file
```

## Development Conventions
- TypeScript for all scripts and config
- Solidity ^0.8.22 for contracts
- pnpm as package manager
- Hardhat + Foundry dual setup (from create-lz-oapp)

## Key Commands
```bash
# Full pipeline
npx tsx toolkit/oft.ts full --reset             # Deploy + wire + test all chains
npx tsx toolkit/oft.ts full --chains=arb,sol    # Only specific chains

# Step by step
npx tsx toolkit/oft.ts deploy [--chains=...] [--dry-run]
npx tsx toolkit/oft.ts wire   [--chains=...] [--dry-run]
npx tsx toolkit/oft.ts test   [--chains=...] [--amount=1]

# Utilities
npx tsx toolkit/oft.ts status                   # Check progress
npx tsx toolkit/oft.ts deploy --dry-run         # Preview without executing
npx tsx toolkit/balances.ts                     # Check cross-chain balances
npx tsx toolkit/test-parameterization.ts        # Run unit tests
```

## Target Chains (Mainnet)
| # | Chain | EID | Runtime | Difficulty |
|---|-------|-----|---------|------------|
| 1 | Arbitrum | 30110 | EVM | Easy |
| 2 | Solana | 30168 | SVM/Rust | Hard |
| 3 | Starknet | 30500 | Cairo | Hard |
| 4 | Sui | 30378 | Move | Very Hard |
| 5 | TON | 30343 | FunC++ | Very Hard |

## Environment Variables
See `.env.example` for all required variables. Key ones:
- `TOKEN_NAME` / `TOKEN_SYMBOL` — your token's name and ticker (required)
- `PRIVATE_KEY` — EVM deployer wallet private key
- `SOLANA_PRIVATE_KEY` — Solana deployer
- `STARKNET_PRIVATE_KEY` / `STARKNET_ACCOUNT_ADDRESS` — Starknet deployer
- `SUI_PRIVATE_KEY` — Sui deployer
- `TON_MNEMONIC` — TON deployer
- `EXTRA_PATH` — paths to solana/anchor/sui CLI binaries

## Cross-Chain Wiring
With 5 chains, there are 20 directional pathways (10 bidirectional pairs). The orchestrator wires all active pathways automatically. Stk↔TON and Sui↔TON are auto-skipped (LZ hasn't deployed endpoints).

Full reference: **`docs/deployment-guide.md`**
