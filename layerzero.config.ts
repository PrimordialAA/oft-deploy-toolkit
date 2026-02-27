import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { TwoWayConfig, generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption } from '@layerzerolabs/toolbox-hardhat'

import type { OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

// ============ CONTRACT DEFINITIONS ============
// Each chain deployment gets an entry here. We build up incrementally as we deploy.

const arbitrumContract: OmniPointHardhat = {
    eid: EndpointId.ARBITRUM_V2_MAINNET,
    contractName: 'MyOFT',
}

const solanaContract: OmniPointHardhat = {
    eid: EndpointId.SOLANA_V2_MAINNET,
    address: process.env.SOLANA_OFT_STORE || '', // OFT Store PDA — set after deployment
}

// Starknet uses OFTMintBurnAdapter — wired via custom scripts (not lz:oapp:wire).
// NOTE: lz:oapp:wire does NOT work for Starknet. All wiring done via scripts/*.ts.
const starknetContract: OmniPointHardhat = {
    eid: EndpointId.STARKNET_V2_MAINNET, // 30500
    address: process.env.STARKNET_ADAPTER_ADDRESS || '', // OFTMintBurnAdapter — set after deployment
}

// Sui uses Move OFT package — wired via custom scripts (not lz:oapp:wire).
// NOTE: Peer address = Package ID (NOT Object ID). This is the #1 Sui gotcha.
const suiContract: OmniPointHardhat = {
    eid: EndpointId.SUI_V2_MAINNET, // 30378
    address: process.env.SUI_OFT_PACKAGE || '', // OFT Package ID = peer address
}

// TON uses FunC++ OApp adapter — wired via custom scripts (not lz:oapp:wire).
// NOTE: Peer address = raw 256-bit address hash of the OFT Adapter contract.
const tonContract: OmniPointHardhat = {
    eid: EndpointId.TON_V2_MAINNET, // 30343
    address: process.env.TON_OFT_ADAPTER || '', // OFT Adapter address
}

// ============ ENFORCED OPTIONS ============
// Gas settings for destination chain execution. Profile _lzReceive() gas usage per chain.

const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1, // SEND
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 80000,
        value: 0,
    },
]

// Solana needs compute units + rent for ATA (Associated Token Account) creation
const SOLANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1, // SEND
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 200000, // 200k compute units
        value: 2039280, // lamports for SPL token account rent
    },
]

// Starknet — conservative starting gas, tune after first delivery
const STARKNET_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1, // SEND
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 200000,
        value: 0,
    },
]

// Sui — lzReceive is very cheap (~2,000-5,000 gas units)
const SUI_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1, // SEND
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 5000,
        value: 0,
    },
]

// TON — conservative starting gas, tune after first delivery
const TON_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1, // SEND
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 50000,
        value: 0,
    },
]

// ============ PATHWAYS ============
// Each TwoWayConfig creates a bidirectional pathway between two chains.
// Format: [contractA, contractB, [requiredDVNs, optionalDVNs], [confirmationsAtoB, confirmationsBtoA], [enforcedOptionsB, enforcedOptionsA]]
//
// With 5 chains, we need 10 pathways total (5 choose 2).
// We wire incrementally — each new chain gets wired to all previously deployed chains.

const pathways: TwoWayConfig[] = [
    // Arbitrum <-> Solana
    [
        arbitrumContract,
        solanaContract,
        [['LayerZero Labs'], []], // required DVNs, optional DVNs
        [15, 32], // confirmations: Arb->Sol 15, Sol->Arb 32
        [SOLANA_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // enforced options: [for Solana dest, for Arb dest]
    ],
    // Arbitrum <-> Starknet
    // NOTE: lz:oapp:wire doesn't work for Starknet — wired via custom scripts.
    [
        arbitrumContract,
        starknetContract,
        [['LayerZero Labs', 'Nethermind'], []],
        [20, 5], // confirmations: Arb->Starknet 20, Starknet->Arb 5
        [STARKNET_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
    // Solana <-> Starknet
    [
        solanaContract,
        starknetContract,
        [['LayerZero Labs'], []],
        [20, 5], // confirmations: Sol->Starknet 20, Starknet->Sol 5
        [STARKNET_ENFORCED_OPTIONS, SOLANA_ENFORCED_OPTIONS],
    ],
    // Arbitrum <-> Sui
    // NOTE: lz:oapp:wire doesn't work for Sui — wired via custom scripts.
    // Sui lzReceive is very cheap (~5,000 gas). 15 confirmations Arb→Sui.
    [
        arbitrumContract,
        suiContract,
        [['LayerZero Labs'], []],
        [15, 15], // confirmations: Arb->Sui 15, Sui->Arb 15
        [SUI_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
    // Solana <-> Sui
    [
        solanaContract,
        suiContract,
        [['LayerZero Labs'], []],
        [32, 15], // confirmations: Sol->Sui 32, Sui->Sol 15
        [SUI_ENFORCED_OPTIONS, SOLANA_ENFORCED_OPTIONS],
    ],
    // Starknet <-> Sui
    [
        starknetContract,
        suiContract,
        [['LayerZero Labs', 'Nethermind'], []],
        [5, 1], // confirmations: Stk->Sui 5, Sui->Stk 1 (Sui fast finality)
        [SUI_ENFORCED_OPTIONS, STARKNET_ENFORCED_OPTIONS],
    ],
    // ===== TON pathways (Phase 5) =====
    // NOTE: lz:oapp:wire doesn't work for TON — all wired via custom scripts.
    // Arbitrum <-> TON
    [
        arbitrumContract,
        tonContract,
        [['LayerZero Labs'], []],
        [15, 1], // confirmations: Arb->TON 15, TON->Arb 1 (TON fast finality)
        [TON_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
    // Solana <-> TON
    [
        solanaContract,
        tonContract,
        [['LayerZero Labs'], []],
        [32, 1], // confirmations: Sol->TON 32, TON->Sol 1
        [TON_ENFORCED_OPTIONS, SOLANA_ENFORCED_OPTIONS],
    ],
    // Starknet <-> TON
    [
        starknetContract,
        tonContract,
        [['LayerZero Labs', 'Nethermind'], []],
        [5, 1], // confirmations: Stk->TON 5, TON->Stk 1
        [TON_ENFORCED_OPTIONS, STARKNET_ENFORCED_OPTIONS],
    ],
    // Sui <-> TON
    [
        suiContract,
        tonContract,
        [['LayerZero Labs'], []],
        [15, 1], // confirmations: Sui->TON 15, TON->Sui 1
        [TON_ENFORCED_OPTIONS, SUI_ENFORCED_OPTIONS],
    ],
]

export default async function () {
    const connections = await generateConnectionsConfig(pathways)
    return {
        contracts: [
            { contract: arbitrumContract },
            { contract: solanaContract },
            { contract: starknetContract },
            { contract: suiContract },
            { contract: tonContract },
        ],
        connections,
    }
}
