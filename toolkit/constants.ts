/**
 * OFT Deployment Toolkit — Constants
 *
 * Single source of truth for chain configs, DVN addresses, gas tables,
 * executor addresses, and endpoint addresses.
 *
 * CRITICAL: DVN addresses differ per chain. Never reuse across chains.
 */

// ============ Chain Types ============

export type ChainType = 'evm' | 'solana' | 'starknet' | 'sui' | 'ton'

export interface ChainConfig {
    name: string
    shortName: string // Used in CLI: DST=sol, DST=arb, etc.
    eid: number
    chainType: ChainType
    endpointAddress: string
    rpcEnvVar: string // .env key for RPC URL
    defaultRpc?: string
    explorerTxUrl: string // Template: replace {tx} with hash
    tokenDecimals: number // Local token decimals
    sharedDecimals: number // OFT shared decimals (for cross-chain)
}

export interface DvnEntry {
    name: string
    address: string // Per-chain address (hex or base58)
}

export interface GasConfig {
    lzReceiveGas: number
    lzReceiveValue: number // In destination native units (lamports for Sol, 0 for most)
    confirmations: number
}

export interface ExecutorConfig {
    address: string
    maxMessageSize: number
}

// ============ Chain Registry ============

export const CHAINS: Record<string, ChainConfig> = {
    arbitrum: {
        name: 'Arbitrum',
        shortName: 'arb',
        eid: 30110,
        chainType: 'evm',
        endpointAddress: '0x1a44076050125825900e736c501f859c50fE728c',
        rpcEnvVar: 'RPC_URL_ARBITRUM',
        explorerTxUrl: 'https://arbiscan.io/tx/{tx}',
        tokenDecimals: 18,
        sharedDecimals: 6,
    },
    solana: {
        name: 'Solana',
        shortName: 'sol',
        eid: 30168,
        chainType: 'solana',
        endpointAddress: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
        rpcEnvVar: 'SOLANA_RPC_URL',
        explorerTxUrl: 'https://solscan.io/tx/{tx}?cluster=mainnet-beta',
        tokenDecimals: 6,
        sharedDecimals: 6,
    },
    starknet: {
        name: 'Starknet',
        shortName: 'stk',
        eid: 30500,
        chainType: 'starknet',
        endpointAddress: '0x524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68',
        rpcEnvVar: 'STARKNET_RPC_URL',
        explorerTxUrl: 'https://starkscan.co/tx/{tx}',
        tokenDecimals: 6,
        sharedDecimals: 6,
    },
    sui: {
        name: 'Sui',
        shortName: 'sui',
        eid: 30378,
        chainType: 'sui',
        endpointAddress: '0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac',
        rpcEnvVar: 'SUI_RPC_URL',
        defaultRpc: 'https://fullnode.mainnet.sui.io:443',
        explorerTxUrl: 'https://suiscan.xyz/mainnet/tx/{tx}',
        tokenDecimals: 6,
        sharedDecimals: 6,
    },
    ton: {
        name: 'TON',
        shortName: 'ton',
        eid: 30343,
        chainType: 'ton',
        endpointAddress: '', // TON endpoints are per-pathway, not global
        rpcEnvVar: 'TON_RPC_URL',
        defaultRpc: 'https://toncenter.com/api/v2/jsonRPC',
        explorerTxUrl: 'https://tonviewer.com/transaction/{tx}',
        tokenDecimals: 6,
        sharedDecimals: 6,
    },
} as const

// Lookup by short name or EID
export function getChain(nameOrEid: string | number): ChainConfig {
    if (typeof nameOrEid === 'number') {
        const found = Object.values(CHAINS).find((c) => c.eid === nameOrEid)
        if (!found) throw new Error(`Unknown EID: ${nameOrEid}`)
        return found
    }
    const key = nameOrEid.toLowerCase()
    // Try full name first, then short name
    if (CHAINS[key]) return CHAINS[key]
    const found = Object.values(CHAINS).find((c) => c.shortName === key)
    if (!found) throw new Error(`Unknown chain: ${nameOrEid}`)
    return found
}

// ============ DVN Registry ============
// CRITICAL: DVN addresses are PER-CHAIN. The same DVN provider has different
// contract addresses on each chain. This was our #1 debugging time sink.

export const DVNS: Record<string, Record<string, DvnEntry>> = {
    arbitrum: {
        lzLabs: { name: 'LZ Labs', address: '0x2f55c492897526677c5b68fb199ea31e2c126416' },
        nethermind: { name: 'Nethermind', address: '0xa7b5189bcA84Cd304D8553977c7C614329750d99' },
        googleCloud: { name: 'Google Cloud', address: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc' },
    },
    solana: {
        // IMPORTANT: These are DvnConfig PDA addresses, NOT program IDs!
        // LZ Labs DVN program: HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW
        // DvnConfig PDA: PDA([b"DvnConfig"], program) = 4VDjp6XQ...
        lzLabs: { name: 'LZ Labs (PDA)', address: '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb' },
        // Nethermind does NOT have a DVN on Solana
    },
    starknet: {
        lzLabs: { name: 'LZ Labs', address: '0x067ba9b8e08d78e4600871db457f9620c56c39915167d32b0581a7fb639866dd' },
        nethermind: { name: 'Nethermind', address: '0x005fe707754524f23e788abfc2d159a8e8d400a59eedc07c00aa10ed9850adfb' },
    },
    sui: {
        lzLabs: { name: 'LZ Labs', address: '0x52aa129049de845353484868d1be6e2df6878b0ed2213d94d3c827309aeae685' },
        nethermind: { name: 'Nethermind', address: '0x0c12321ebe562b8fb8a74e6d29f144ea199a8f31a4cea3a417ce72477f6dfebb' },
    },
    ton: {
        lzLabs: { name: 'LZ Labs', address: '0x0d122dec4ec8bd66c68344faf0dd471d727a7d57a21b62051705bbe2e4c272a7' },
        horizen: { name: 'Horizen', address: '0x049e0ecaa2b3b4fc1966b06481d0b584e983327f4e55b185a73b8bd2eb7650e2' },
    },
}

export function getDvn(chain: string, provider: string): DvnEntry {
    const chainDvns = DVNS[chain.toLowerCase()]
    if (!chainDvns) throw new Error(`No DVNs registered for chain: ${chain}`)
    const dvn = chainDvns[provider.toLowerCase()] || chainDvns[provider]
    if (!dvn) {
        const available = Object.keys(chainDvns).join(', ')
        throw new Error(`DVN "${provider}" not found on ${chain}. Available: ${available}`)
    }
    return dvn
}

// ============ Executor Registry ============

export const EXECUTORS: Record<string, ExecutorConfig> = {
    arbitrum: {
        address: '0x31CAe3B7fB82d847621859fb1585353c5720660D',
        maxMessageSize: 10000,
    },
    solana: {
        // Solana executor PDA (for LZ Labs executor)
        address: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK',
        maxMessageSize: 10000,
    },
    // Starknet, Sui, TON: executors are managed by LZ infrastructure
}

// ============ Gas Table ============
// Enforced options for lzReceive on destination chain.
// Key = destination chain. Values = gas + value for lzReceive.

export const GAS_TABLE: Record<string, GasConfig> = {
    arbitrum: {
        lzReceiveGas: 80_000,
        lzReceiveValue: 0,
        confirmations: 15,
    },
    solana: {
        lzReceiveGas: 200_000, // Compute units
        lzReceiveValue: 2_039_280, // ATA rent in lamports
        confirmations: 32,
    },
    starknet: {
        lzReceiveGas: 200_000,
        lzReceiveValue: 0,
        confirmations: 10,
    },
    sui: {
        lzReceiveGas: 5_000, // Very cheap
        lzReceiveValue: 0,
        confirmations: 5,
    },
    ton: {
        lzReceiveGas: 1_000_000, // TON needs high gas for 5-hop flow
        lzReceiveValue: 0,
        confirmations: 20,
    },
}

export function getGasConfig(dstChain: string): GasConfig {
    const key = dstChain.toLowerCase()
    const config = GAS_TABLE[key]
    if (config) return config
    // Try resolving short name to full name
    const chain = Object.values(CHAINS).find((c) => c.shortName === key)
    if (chain) {
        const fullConfig = GAS_TABLE[Object.keys(CHAINS).find((k) => CHAINS[k] === chain)!]
        if (fullConfig) return fullConfig
    }
    throw new Error(`No gas config for destination: ${dstChain}`)
}

// ============ Solana-Specific Constants ============

export const SOLANA_CONSTANTS = {
    defaultLookupTable: 'AokBxha6VMLLgf97B5VYHEtqztamWmYERBmmFvjuTzJB',
    testnetLookupTable: '9thqPdbR27A1yLWw2spwJLySemiGMXxPnEvfmXVk4KuK',
    computeUnits: 600_000, // Minimum for OFT sends
    priorityFeeMultiplier: 4, // Priority fee = avg * 4
    dvnProgramId: 'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW', // LZ Labs DVN program
}

// ============ Starknet-Specific Constants ============

export const STARKNET_CONSTANTS = {
    strkToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    // Role encoding: use shortstring, NOT getSelectorFromName
    minterRole: '0x4d494e5445525f524f4c45', // shortstring 'MINTER_ROLE'
    burnerRole: '0x4255524e45525f524f4c45', // shortstring 'BURNER_ROLE'
}

// ============ Sui-Specific Constants ============

export const SUI_CONSTANTS = {
    oftComposerManager: '0xfbece0b75d097c31b9963402a66e49074b0d3a2a64dd0ed666187ca6911a4d12',
    rpcSyncDelayMs: 3000, // Delay between sequential TXs for RPC sync
}

// ============ TON-Specific Constants ============

export const TON_CONSTANTS = {
    controller: '0x1eb2bbea3d8c0d42ff7fd60f0264c866c934bbff727526ca759e7374cae0c166',
    ulnManager: '0x06b52b11abaf65bf1ff47c57e890ba4ad6a75a68859bbe5a51c1fc451954c54c',
    txValue: '0.3', // TON per setPeer/setEnforcedOptions TX (0.1 causes action phase failure)
    epConfigTxValue: '0.5', // TON per EP config TX (3-hop forwarding)
    sendTxValue: '1.5', // TON per send TX (excess refunded)
    opcodes: {
        SET_PEER: 0x5df77d23,
        SET_ENFORCED_OPTIONS: 0x0075a62d,
        SEND_OFT: 0x73b696eb,
        SET_LZ_CONFIG: 0x82801010,
        SET_EP_CONFIG_OAPP: 0x0a4ea4b3,
        SET_OAPP_MSGLIB_RECEIVE_CONFIG: 0x43997bfc,
    },
}

// ============ LZ Infrastructure Status ============
// Which chain pairs have active LZ endpoints (as of deployment).
// Some pairs are BLOCKED because LZ hasn't deployed endpoints.

export type PathwayStatus = 'active' | 'blocked' | 'unknown'

export const PATHWAY_STATUS: Record<string, PathwayStatus> = {
    'arbitrum-solana': 'active',
    'arbitrum-starknet': 'active',
    'arbitrum-sui': 'active',
    'arbitrum-ton': 'active',
    'solana-starknet': 'active',
    'solana-sui': 'active',
    'solana-ton': 'active',
    'starknet-sui': 'active',
    'starknet-ton': 'blocked', // LZ has NOT deployed TON endpoint for Starknet
    'sui-ton': 'blocked', // LZ has NOT deployed TON endpoint for Sui
}

export function getPathwayStatus(chain1: string, chain2: string): PathwayStatus {
    const key1 = `${chain1.toLowerCase()}-${chain2.toLowerCase()}`
    const key2 = `${chain2.toLowerCase()}-${chain1.toLowerCase()}`
    return PATHWAY_STATUS[key1] || PATHWAY_STATUS[key2] || 'unknown'
}

// ============ Env Var Mapping ============
// Standard .env variable names for deployed contract addresses.

export const ENV_VARS = {
    arbitrum: {
        contract: 'ARBITRUM_CONTRACT_ADDRESS',
        privateKey: 'PRIVATE_KEY',
        rpc: 'RPC_URL_ARBITRUM',
        deployer: 'EVM_DEPLOYER_ADDRESS',
    },
    solana: {
        contract: 'SOLANA_OFT_STORE',
        programId: 'SOLANA_OFT_PROGRAM_ID',
        privateKey: 'SOLANA_PRIVATE_KEY',
        rpc: 'SOLANA_RPC_URL',
        deployer: 'SOLANA_DEPLOYER_ADDRESS',
    },
    starknet: {
        contract: 'STARKNET_ADAPTER_ADDRESS',
        erc20: 'STARKNET_ERC20_ADDRESS',
        privateKey: 'STARKNET_PRIVATE_KEY',
        account: 'STARKNET_ACCOUNT_ADDRESS',
        rpc: 'STARKNET_RPC_URL',
    },
    sui: {
        tokenPackage: 'SUI_TOKEN_PACKAGE',
        oftPackage: 'SUI_OFT_PACKAGE',
        oftObject: 'SUI_OFT_OBJECT',
        oappObject: 'SUI_OAPP_OBJECT',
        adminCap: 'SUI_ADMIN_CAP',
        privateKey: 'SUI_PRIVATE_KEY',
        rpc: 'SUI_RPC_URL',
        deployer: 'SUI_DEPLOYER_ADDRESS',
    },
    ton: {
        adapter: 'TON_OFT_ADAPTER',
        adapterHash: 'TON_OFT_ADAPTER_HASH',
        jettonMaster: 'TON_JETTON_MASTER',
        mnemonic: 'TON_MNEMONIC',
        rpc: 'TON_RPC_URL',
        apiKey: 'TON_API_KEY',
    },
} as const

// ============ LayerZero Scan API ============

export const LZ_SCAN_API = 'https://scan.layerzero-api.com'
export const LZ_SCAN_URL = 'https://layerzeroscan.com'
