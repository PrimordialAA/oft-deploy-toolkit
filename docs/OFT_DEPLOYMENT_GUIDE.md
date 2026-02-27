# OFT Deployment Guide — LayerZero V2

A modular guide for deploying Omnichain Fungible Tokens (OFTs) using LayerZero V2 across 5 chains (Arbitrum, Solana, Starknet, Sui, TON) with every issue documented.

**Pick your chains, follow their sections, skip the rest.**

---

## Table of Contents

- [Part 1: How This Works](#part-1-how-this-works)
- [Part 2: Deploy Your Token](#part-2-deploy-your-token)
  - [2A: Arbitrum (EVM)](#2a-arbitrum-evm)
  - [2B: Solana](#2b-solana)
  - [2C: Starknet](#2c-starknet)
  - [2D: Sui](#2d-sui)
  - [2E: TON](#2e-ton)
- [Part 3: Wire Your Pathways](#part-3-wire-your-pathways)
  - [3.0: Wiring Overview](#30-wiring-overview)
  - [3A: Wire FROM EVM](#3a-wire-from-evm)
  - [3B: Wire FROM Solana](#3b-wire-from-solana)
  - [3C: Wire FROM Starknet](#3c-wire-from-starknet)
  - [3D: Wire FROM Sui](#3d-wire-from-sui)
  - [3E: Wire FROM TON](#3e-wire-from-ton)
  - [3F: DVN Configuration Deep Dive](#3f-dvn-configuration-deep-dive)
- [Part 4: Test & Debug](#part-4-test--debug)
- [Part 5: Reference Tables](#part-5-reference-tables)

---

## Part 1: How This Works

### LayerZero V2 OFT Architecture

An OFT is a token that exists on multiple chains simultaneously. When you send tokens cross-chain:

1. **Source chain**: Tokens are burned (or locked in an adapter)
2. **LayerZero Endpoint**: Creates a message with `[recipient, amount]`
3. **DVNs (Decentralized Verifier Networks)**: Independently verify the message
4. **Executor**: Delivers the verified message to the destination
5. **Destination chain**: Tokens are minted (or released from an adapter)

The full flow: `burn → lzSend → DVN verify → Executor deliver → lzReceive → mint`

### What "Wiring" Means

Before any cross-chain transfer, both sides must be configured:

| Step | What it does | Why it matters |
|------|-------------|----------------|
| **Set Peer** | Tell chain A that chain B's contract address is its trusted counterpart | Without this, messages are rejected |
| **Set Enforced Options** | Configure gas/compute for lzReceive on the destination | Wrong gas = silent failure or stuck message |
| **Set DVN Config** | Tell the endpoint which DVNs to use for verification | Mismatched DVNs = message stuck INFLIGHT forever |

**Wiring is bidirectional.** For Arb ↔ Sol, you must wire Arb→Sol AND Sol→Arb.

### How to Pick Your Chains

With N chains, you need N*(N-1)/2 bidirectional pathways:
- 2 chains = 1 pathway
- 3 chains = 3 pathways
- 5 chains = 10 pathways

**Recommendation**: Start with 2 EVM-compatible chains (cheapest, fastest). Add non-EVM chains one at a time, testing each pathway before adding the next.

### Cost Overview

| Chain | Deploy Cost | Wire Cost (per pathway) | Send Cost (avg) |
|-------|------------|------------------------|-----------------|
| Arbitrum (EVM) | ~$0.17 | ~$0.05 | ~$0.02 |
| Solana | ~$2-5 SOL | ~$0.01 | ~$0.005 |
| Starknet | ~0.01 ETH | ~0.001 ETH | ~0.0005 ETH |
| Sui | ~0.3 SUI | ~0.05 SUI | ~0.07-0.5 SUI |
| TON | ~0.5-1 TON | ~0.3 TON per step | ~1.5 TON |

---

## Part 2: Deploy Your Token

### 2A: Arbitrum (EVM)

**Prerequisites**: Hardhat + Foundry project from `create-lz-oapp`

```bash
# 1. Compile
pnpm compile

# 2. Deploy
npx hardhat lz:deploy

# Select: arbitrum network, MyOFT contract
# Constructor args: token name, symbol, endpoint address, deployer address
```

**Endpoint address (all EVM)**: `0x1a44076050125825900e736c501f859c50fE728c`

**Verify on Arbiscan**:
```bash
npx hardhat verify --network arbitrum <CONTRACT_ADDRESS> "TokenName" "SYMBOL" "0x1a44076050125825900e736c501f859c50fE728c" "<DEPLOYER>"
```

**Save to .env**:
```
ARBITRUM_CONTRACT_ADDRESS=0x...
```

### 2B: Solana

**Prerequisites**: Anchor CLI, Solana CLI, `@layerzerolabs/oft-v2-solana-sdk`

```bash
# 1. Pin blake3 to 1.5.4 (higher versions break macOS)
cargo update -p blake3@1.6.0 --precise 1.5.4

# 2. Build
anchor build -- --features mainnet

# 3. Deploy program
solana program deploy target/deploy/oft.so

# 4. Create SPL token + OFT Store
npx tsx scripts/create-oft-solana.ts
```

**Critical**: Save the OFT Store PDA address — this is your Solana "peer address" for wiring.

**Save to .env**:
```
SOLANA_OFT_PROGRAM_ID=<program-id>
SOLANA_OFT_STORE=<oft-store-pda>
```

### 2C: Starknet

**Prerequisites**: `starknet.js` v9, class hash compiled

```bash
# 1. Deploy ERC20 token
npx ts-node scripts/deploy-starknet.ts
# This deploys both ERC20 and OFT Adapter

# 2. Grant MINTER + BURNER roles to adapter
# CRITICAL: Use shortstring encoding, NOT getSelectorFromName
# MINTER_ROLE = 0x4d494e5445525f524f4c45
# BURNER_ROLE = 0x4255524e45525f524f4c45
```

**Gotchas**:
- starknet.js v9 uses object constructors: `new Account({ provider, address, signer })`
- Bytes32 type: `{ value: uint256.bnToUint256(bigint) }`
- ByteArray fields: use `'0x'` string (not `[]`)
- `lzReceive` needs ~17M L2 gas steps

**Save to .env**:
```
STARKNET_ERC20_ADDRESS=0x...
STARKNET_ADAPTER_ADDRESS=0x...
```

### 2D: Sui

**Prerequisites**: Sui CLI, `@layerzerolabs/lz-sui-sdk-v2`, `@layerzerolabs/lz-sui-oft-sdk-v2`

Two-package pattern:
1. **Token Package**: Defines the coin type (OTW pattern)
2. **OFT Package**: LayerZero integration

```bash
# 1. Publish Token Package
sui client publish

# 2. Publish OFT Package (MUST be from within LZ repo — Move.lock dependency)
# Clone LZ monorepo, copy your Move.toml, publish from there

# 3. Register OApp
npx tsx scripts/register-sui-oapp.ts
```

**Critical**: The **Package ID** is your Sui peer address, NOT the Object ID.

**Gotchas**:
- `@mysten/sui` must be v1.x (v2 has breaking changes)
- Use `pnpm tsx` not `ts-node` (subpath exports issue)
- After `sendMoveCall`, MUST call `tx.transferObjects([coin], sender)`

**Save to .env**:
```
SUI_TOKEN_PACKAGE=0x...
SUI_OFT_PACKAGE=0x...
SUI_OFT_OBJECT=0x...
SUI_OAPP_OBJECT=0x...
```

### 2E: TON

**Prerequisites**: Blueprint, `@ston-fi/funcbox` compiler, FunC++ classlib

Architecture: Separate Jetton Master (TEP-74) + OFT Adapter (FunC++ OApp)

```bash
# 1. Deploy Jetton Master
cd ton/lz-framework && npx tsx ../../scripts/deploy-ton-jetton.ts

# 2. Deploy OFT Adapter
npx tsx ../../scripts/deploy-ton-adapter.ts

# 3. Transfer Jetton admin to adapter
# (Required for adapter to mint tokens on receive)

# 4. Initialize connections for each remote chain
npx tsx ../../scripts/init-ton-connections.ts
```

**Gotchas**:
- TX value: use 0.3+ TON per transaction (0.1 TON causes action phase failure)
- Peer address = raw 256-bit hash (NOT bounceable address format)
- Rate limiting: TON RPC needs retry with exponential backoff

**Save to .env**:
```
TON_OFT_ADAPTER=EQ...
TON_OFT_ADAPTER_HASH=0x...
TON_JETTON_MASTER=EQ...
```

---

## Part 3: Wire Your Pathways

### 3.0: Wiring Overview

For each chain pair (A ↔ B), you need:

1. **Wire A → B** (on chain A):
   - Set peer: "I trust contract X on chain B"
   - Set enforced options: "When sending to B, use Y gas"
   - (Optional) Set DVN config: "Use these DVNs for the A→B pathway"

2. **Wire B → A** (on chain B):
   - Same three steps, reversed

**Order matters for some chains**:
- Starknet: `set_delegate` → `set_enforced_options` → `set_peer`
- Sui: `setConfig (DVN)` → `setEnforcedOptions` → `setPeer`
- Others: order doesn't matter

**Using the toolkit templates**:
```bash
# Wire Arbitrum → Solana
DST=sol npx tsx toolkit/templates/wire-from-evm.ts

# Wire Solana → Arbitrum
DST=arb npx tsx toolkit/templates/wire-from-solana.ts
```

### 3A: Wire FROM EVM

Applies to: Arbitrum → any destination

Steps:
1. **setPeer(dstEid, peerBytes32)** — Set the destination contract as trusted peer
2. **setEnforcedOptions([{eid, msgType: 1, options}])** — Set lzReceive gas for destination
3. **(If non-default DVN)** Set DVN config via `endpoint.setConfig(oapp, lib, [{eid, configType: 2, config}])`

Gas per destination:
| Destination | lzReceiveGas | lzReceiveValue |
|-------------|-------------|----------------|
| Arbitrum | 80,000 | 0 |
| Solana | 200,000 | 2,039,280 (ATA rent) |
| Starknet | 200,000 | 0 |
| Sui | 5,000 | 0 |
| TON | 1,000,000 | 0 |

**Template**: `DST=sol npx tsx toolkit/templates/wire-from-evm.ts`

### 3B: Wire FROM Solana

Applies to: Solana → any destination

Steps (4-step init required):
1. **initSendLibrary** — Initialize send library PDA for this EID
2. **initReceiveLibrary** — Initialize receive library PDA
3. **initOAppNonce** — Initialize nonce tracking PDA
4. **initConfig** — Initialize ULN config PDA
5. **setPeerConfig({ __kind: 'PeerAddress', peer, remote })** — Set peer
6. **setPeerConfig({ __kind: 'EnforcedOptions', send, sendAndCall, remote })** — Set options
7. **(Optional) setConfig** — DVN/executor config (uses PDA addresses, NOT program IDs!)

**Critical**: Steps 1-4 are idempotent (skip if already initialized). But they MUST run before peer/options.

**Critical**: For DVN config, use the **DvnConfig PDA** address, not the DVN program ID:
- LZ Labs DVN Program: `HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW`
- LZ Labs DvnConfig PDA: `4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb`

**Template**: `DST=arb npx tsx toolkit/templates/wire-from-solana.ts`

### 3C: Wire FROM Starknet

Applies to: Starknet → any destination

Steps (order critical):
1. **set_delegate(deployer_address)** — Set delegate for config management
2. **set_enforced_options([{eid, msg_type: 1, options: hexString}])** — Options as hex ByteArray
3. **set_peer(eid, {value: uint256})** — Peer as Bytes32 struct

**Starknet encoding**:
- Options: hex string with `0x` prefix (e.g., `'0x00030100...'`)
- Peer: `{ value: uint256.bnToUint256(bigint) }`
- ByteArray: `'0x'` for empty

**Template**: `DST=arb npx tsx toolkit/templates/wire-from-starknet.ts`

### 3D: Wire FROM Sui

Applies to: Sui → any destination

Steps (per destination chain):
1. **setConfig (configType 2, ULN send config)** — DVN + confirmations for sending
2. **setConfig (configType 3, ULN recv config)** — DVN + confirmations for receiving
3. **setEnforcedOptions(eid, msgType=1, optionsBytes)** — Gas config
4. **setPeer(eid, peerBytes32)** — Peer as Uint8Array

**Add 3-second delays between transactions** — Sui RPC needs time to sync gas object versions.

**Critical**: Sui peer address is the **Package ID**, not the Object ID.

**Template**: `DST=arb npx tsx toolkit/templates/wire-from-sui.ts`

### 3E: Wire FROM TON

Applies to: TON → any destination

Steps (most complex):
1. **Deploy Channel + Connection** for each remote EID (if not already deployed by LZ)
2. **Set EP Config** — Assign ULN Manager as send/receive library
3. **Set Peer** — classlib md encoding: `md::SetPeer {eid, peer}`
4. **Set Enforced Options** — classlib: `md::OptionsExtended {eid, msgType, options}`
5. **Set Receive ULN Config** — DVN verification config for inbound messages

**Critical**:
- TX value: 0.3 TON for peer/options, 0.5 TON for EP config
- Peer = raw 256-bit hash, NOT bounceable address
- Wait for seqno change between TXs
- Rate limiting: use exponential backoff retry

**Template**: `DST=arb npx tsx toolkit/templates/wire-from-ton.ts`

### 3F: DVN Configuration Deep Dive

**The #1 cause of stuck messages is DVN misconfiguration.**

Rules:
1. The **source chain's send config** specifies which DVNs will verify outbound messages
2. The **destination chain's receive config** specifies which DVNs are trusted for verification
3. These MUST match: if source sends with [LZ Labs, Nethermind], destination must expect [LZ Labs, Nethermind]
4. DVN addresses are **per-chain** — the same provider (e.g., "LZ Labs") has different contract addresses on each chain

Common mistakes:
- Using Arbitrum's LZ Labs DVN address when configuring Sui's DVN config
- Using DVN program ID instead of DvnConfig PDA on Solana
- Source sends with 2 DVNs but destination only expects 1 (or vice versa)
- Not all DVN providers exist on all chains (e.g., Nethermind is NOT on Solana)

**Safe default**: Use LZ Labs DVN only (1 required, 0 optional) on all chains. LZ Labs has DVNs on every chain.

See Part 5 for the full DVN address matrix.

---

## Part 4: Test & Debug

### Sending a Test Transfer

From each chain type:
```bash
# EVM → Solana
DST=sol AMOUNT=1 npx tsx toolkit/templates/send-from-evm.ts

# Solana → EVM
DST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-solana.ts

# Starknet → EVM
DST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-starknet.ts

# Sui → EVM
DST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-sui.ts

# TON → EVM
DEST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-ton.ts
```

### Pre-Send Preflight Checklist

Before sending, verify:
- [ ] Peer is set on BOTH source and destination
- [ ] Enforced options are set on source for this destination
- [ ] DVN config matches (send count = receive count)
- [ ] Sufficient native gas on source chain
- [ ] Token balance sufficient on source chain
- [ ] Pathway is active (check PATHWAY_STATUS in constants.ts)

Run programmatically:
```bash
SRC=arb DST=sol npx tsx toolkit/preflight.ts
```

### Stuck Message Decision Tree

```
Message stuck?
├── Check LZ Scan: https://layerzeroscan.com/tx/<hash>
│   ├── INFLIGHT + DVN_WAITING
│   │   → DVN config mismatch (Section 3F)
│   │   → Check: source send DVN count matches dest receive DVN count
│   │   → Check: DVN addresses are for the correct chain
│   │
│   ├── INFLIGHT + 0 DVNs
│   │   → No DVN supports this pathway
│   │   → Check: LZ endpoint contracts exist for both chains
│   │   → Check: pathway status in constants.ts
│   │
│   ├── BLOCKED
│   │   → Nonce ordering issue — earlier nonce must resolve first
│   │   → Check nonces: outbound vs inbound
│   │
│   ├── FAILED
│   │   → lzReceive reverted on destination
│   │   → Check: gas was sufficient
│   │   → Check: contract not paused
│   │
│   └── Not found
│       → TX didn't reach LZ Endpoint
│       → Verify TX was confirmed on source chain
│       → For TON: check that Channel contract exists
│
├── Check destination chain specifically:
│   ├── EVM: Check enforced options gas (was it enough?)
│   ├── Solana: Check all 4 PDAs exist for this EID
│   ├── Starknet: May need manual lzReceive execution
│   ├── Sui: Check ULN302 config
│   └── TON: Check Channel exists (tonapi.io)
│
└── Run diagnostics:
    npx tsx toolkit/diagnose.ts <tx-hash>
```

---

## Part 5: Reference Tables

### Chain Registry

| Chain | EID | Type | Endpoint Address |
|-------|-----|------|------------------|
| Arbitrum | 30110 | EVM | `0x1a44076050125825900e736c501f859c50fE728c` |
| Solana | 30168 | SVM | `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| Starknet | 30500 | Cairo | `0x524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68` |
| Sui | 30378 | Move | `0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac` |
| TON | 30343 | FunC++ | Per-pathway (see TON section) |

### DVN Address Matrix

**DVN addresses are PER-CHAIN. Never reuse across chains.**

| Provider | Arbitrum | Solana (PDA) | Starknet | Sui | TON |
|----------|----------|-------------|----------|-----|-----|
| LZ Labs | `0x2f55c492...` | `4VDjp6XQ...` | `0x067ba9b8...` | `0x52aa1290...` | `0x0d122dec...` |
| Nethermind | `0xa7b5189b...` | N/A | `0x005fe707...` | `0x0c12321e...` | N/A |
| Horizen | N/A | N/A | N/A | N/A | `0x049e0eca...` |

Full addresses in `toolkit/constants.ts` → `DVNS` registry.

### Gas / Value per Destination

| Destination | lzReceiveGas | lzReceiveValue | Notes |
|-------------|-------------|----------------|-------|
| Arbitrum | 80,000 | 0 | Standard EVM |
| Solana | 200,000 | 2,039,280 | CU + ATA rent (lamports) |
| Starknet | 200,000 | 0 | Conservative for 17M L2 steps |
| Sui | 5,000 | 0 | Very cheap |
| TON | 1,000,000 | 0 | 5-hop delivery flow |

### Peer Encoding Cheat Sheet

| Source Chain | Encoding | Format |
|-------------|----------|--------|
| EVM | `addressToBytes32Hex(addr)` | `0x` + left-pad to 64 hex chars |
| Solana | `addressToBytes32Uint8(base58)` | Decode base58 → Uint8Array (32 bytes) |
| Starknet | `toStarknetBytes32(addr)` | `{ value: uint256.bnToUint256(bigint) }` |
| Sui | `addressToBytes32Uint8(addr)` | Uint8Array (32 bytes). **Use Package ID, not Object ID** |
| TON | `addressToBytes32BigInt(addr)` | BigInt (raw 256-bit hash, not bounceable) |

### Per-Chain Gotchas (1 bullet each)

- **Arbitrum**: Standard EVM — no surprises. Cheapest to deploy and wire.
- **Solana**: Must initialize 4 PDAs before wiring. DVN config uses PDA addresses, NOT program IDs. Address lookup tables mandatory for sends.
- **Starknet**: Role encoding uses shortstring (`0x4d494e5445525f524f4c45`), NOT `getSelectorFromName`. starknet.js v9 API changed to object constructors.
- **Sui**: Package ID is the peer address, NOT Object ID. Must publish OFT from within LZ repo. Add 3s delays between TXs. `transferObjects` required after send.
- **TON**: Most complex. Classlib encoding for everything. 0.3+ TON per TX value. Peer = raw hash. Some pathways (Stk↔TON, Sui↔TON) blocked by missing LZ infrastructure.

### LZ Infrastructure Status

| Pathway | Status | Notes |
|---------|--------|-------|
| Arb ↔ Sol | Active | Fully operational |
| Arb ↔ Stk | Active | May need manual lzReceive |
| Arb ↔ Sui | Active | Fully operational |
| Arb ↔ TON | Active | Working, tested both directions |
| Sol ↔ Stk | Active | Fully operational |
| Sol ↔ Sui | Active | Fully operational |
| Sol ↔ TON | Active | Sol→TON confirmed, TON→Sol needs retry |
| Stk ↔ Sui | Active | Fully operational |
| Stk ↔ TON | **BLOCKED** | LZ has not deployed TON endpoint for Starknet |
| Sui ↔ TON | **BLOCKED** | LZ has not deployed TON endpoint for Sui |
