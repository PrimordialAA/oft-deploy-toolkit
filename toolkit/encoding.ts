/**
 * OFT Deployment Toolkit — Encoding
 *
 * Universal peer/address encoding and enforced options builder.
 * Handles all address formats: EVM hex, Solana base58, Starknet felt,
 * Sui package ID, TON raw hash.
 */

import { getChain, getGasConfig, type ChainConfig } from './constants'

// ============ Address Format Detection ============

export type AddressFormat = 'evm' | 'starknet_or_sui' | 'solana' | 'ton_raw'

/**
 * Detect address format:
 * - Starts with 0x, <=42 chars: EVM (20 bytes)
 * - Starts with 0x, >42 chars: Starknet/Sui/TON (32 bytes)
 * - Base58, 32-44 chars: Solana
 * - Contains ':': TON raw format (workchain:hash)
 */
export function detectAddressFormat(address: string): AddressFormat {
    if (address.includes(':')) return 'ton_raw'
    if (address.startsWith('0x')) {
        return address.length <= 42 ? 'evm' : 'starknet_or_sui'
    }
    // Base58 check: Solana addresses are 32-44 chars of base58 alphabet
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana'
    throw new Error(`Cannot detect address format: ${address}`)
}

// ============ Address to Bytes32 ============

/**
 * Convert any address to a 32-byte hex string (0x-prefixed, 64 hex chars).
 * This is the universal peer format used by LayerZero V2.
 */
export function addressToBytes32Hex(address: string): string {
    const format = detectAddressFormat(address)

    switch (format) {
        case 'evm': {
            const hex = address.replace('0x', '').toLowerCase()
            return '0x' + hex.padStart(64, '0')
        }
        case 'starknet_or_sui': {
            const hex = address.replace('0x', '').toLowerCase()
            return '0x' + hex.padStart(64, '0')
        }
        case 'solana': {
            const bs58Module = require('bs58')
            const bs58 = bs58Module.default || bs58Module
            const bytes = bs58.decode(address)
            return '0x' + Buffer.from(bytes).toString('hex').padStart(64, '0')
        }
        case 'ton_raw': {
            // TON raw: "workchain:hash" — extract the hash part
            const hash = address.split(':')[1]
            return '0x' + hash.padStart(64, '0')
        }
    }
}

/**
 * Convert any address to a 32-byte Uint8Array.
 * Used by Solana and Sui SDKs.
 */
export function addressToBytes32Uint8(address: string): Uint8Array {
    const hex = addressToBytes32Hex(address).replace('0x', '')
    return Buffer.from(hex, 'hex')
}

/**
 * Convert any address to a BigInt (256-bit).
 * Used by Starknet (uint256) and TON (classlib encoding).
 */
export function addressToBytes32BigInt(address: string): bigint {
    return BigInt(addressToBytes32Hex(address))
}

// ============ Enforced Options Builder ============

/**
 * Build enforced options for a destination chain.
 * Returns hex string (for EVM/Starknet) or bytes (for Solana/Sui).
 *
 * Options format: ExecutorLzReceiveOption(gas, value)
 * - gas: lzReceive gas on destination
 * - value: native value to forward (e.g., ATA rent for Solana)
 */
export function buildEnforcedOptionsHex(dstChainName: string): string {
    const gasConfig = getGasConfig(dstChainName)
    const { Options } = require('@layerzerolabs/lz-v2-utilities')
    return Options.newOptions()
        .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
        .toHex()
}

export function buildEnforcedOptionsBytes(dstChainName: string): Uint8Array {
    const gasConfig = getGasConfig(dstChainName)
    const { Options } = require('@layerzerolabs/lz-v2-utilities')
    return Options.newOptions()
        .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
        .toBytes()
}

// ============ Starknet-Specific Encoding ============

/**
 * Convert a bytes32 hex string to Starknet Bytes32 struct.
 * Starknet uses { value: u256 } where u256 = { low: felt, high: felt }.
 */
export function toStarknetBytes32(address: string) {
    const { uint256 } = require('starknet')
    const bigint = addressToBytes32BigInt(address)
    return { value: uint256.bnToUint256(bigint) }
}

/**
 * Convert raw bytes to Cairo ByteArray struct.
 * ByteArray = { data: bytes31[], pending_word: felt252, pending_word_len: u32 }
 */
export function bytesToCairoByteArray(bytes: Uint8Array): {
    data: string[]
    pending_word: string
    pending_word_len: number
} {
    const chunks: string[] = []
    let i = 0
    while (i + 31 <= bytes.length) {
        chunks.push('0x' + Buffer.from(bytes.slice(i, i + 31)).toString('hex'))
        i += 31
    }
    const remaining = bytes.slice(i)
    return {
        data: chunks,
        pending_word: remaining.length > 0 ? '0x' + Buffer.from(remaining).toString('hex') : '0x0',
        pending_word_len: remaining.length,
    }
}

// ============ EVM ULN Config Encoding ============

/**
 * Encode ULN send/receive config for EVM endpoint.setConfig().
 * configType 2 = ULN config.
 */
export function encodeEvmUlnConfig(params: {
    confirmations: number
    requiredDvns: string[]
    optionalDvns?: string[]
    optionalDvnThreshold?: number
}): string {
    const { ethers } = require('ethers')
    const coder = ethers.AbiCoder ? new ethers.AbiCoder() : ethers.utils.defaultAbiCoder
    const encode = coder.encode.bind(coder)
    return encode(
        [
            'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)',
        ],
        [
            {
                confirmations: params.confirmations,
                requiredDVNCount: params.requiredDvns.length,
                optionalDVNCount: (params.optionalDvns || []).length,
                optionalDVNThreshold: params.optionalDvnThreshold || 0,
                requiredDVNs: params.requiredDvns,
                optionalDVNs: params.optionalDvns || [],
            },
        ]
    )
}

/**
 * Encode executor config for EVM endpoint.setConfig().
 * configType 1 = Executor config.
 */
export function encodeEvmExecutorConfig(executorAddress: string, maxMessageSize = 10000): string {
    const { ethers } = require('ethers')
    const coder = ethers.AbiCoder ? new ethers.AbiCoder() : ethers.utils.defaultAbiCoder
    const encode = coder.encode.bind(coder)
    return encode(
        ['tuple(uint32 maxMessageSize, address executor)'],
        [{ maxMessageSize, executor: executorAddress }]
    )
}

// ============ Utilities ============

/**
 * Get the explorer URL for a transaction on a given chain.
 */
export function getExplorerTxUrl(chainName: string, txHash: string): string {
    const chain = getChain(chainName)
    return chain.explorerTxUrl.replace('{tx}', txHash)
}

/**
 * Get the LayerZero Scan URL for a transaction.
 */
export function getLzScanUrl(txHash: string): string {
    return `https://layerzeroscan.com/tx/${txHash}`
}
