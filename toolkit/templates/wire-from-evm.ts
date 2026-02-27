/**
 * Wire EVM OFT → any destination chain.
 *
 * Steps: setPeer + setEnforcedOptions + (optional) DVN/executor config.
 * Idempotent — skips steps that are already configured.
 *
 * Usage:
 *   DST=sol npx tsx toolkit/templates/wire-from-evm.ts
 *   DST=stk npx tsx toolkit/templates/wire-from-evm.ts
 *   DST=sui SET_DVN=true npx tsx toolkit/templates/wire-from-evm.ts
 */

import 'dotenv/config'
import { ethers } from 'hardhat'
import { Options } from '@layerzerolabs/lz-v2-utilities'
import {
    CHAINS,
    DVNS,
    EXECUTORS,
    GAS_TABLE,
    ENV_VARS,
    getChain,
    getGasConfig,
    getPathwayStatus,
} from '../constants'
import { addressToBytes32Hex, encodeEvmUlnConfig, encodeEvmExecutorConfig } from '../encoding'

// ============ Config from env ============

const DST = (process.env.DST || '').toLowerCase()
const SET_DVN = process.env.SET_DVN === 'true'
const OFT_ADDRESS = process.env.ARBITRUM_CONTRACT_ADDRESS || ''
const ENDPOINT_V2 = '0x1a44076050125825900e736c501f859c50fE728c'

// ============ ABI ============

const OFT_ABI = [
    'function setPeer(uint32 _eid, bytes32 _peer) external',
    'function peers(uint32 _eid) external view returns (bytes32)',
    'function setEnforcedOptions((uint32 eid, uint16 msgType, bytes options)[] _enforcedOptions) external',
    'function enforcedOptions(uint32 _eid, uint16 _msgType) external view returns (bytes)',
]

const ENDPOINT_ABI = [
    'function setConfig(address _oapp, address _lib, tuple(uint32 eid, uint32 configType, bytes config)[] _params) external',
    'function defaultSendLibrary(uint32 _eid) external view returns (address)',
    'function defaultReceiveLibrary(uint32 _eid) external view returns (address)',
]

// ============ Main ============

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> npx hardhat run toolkit/templates/wire-from-evm.ts --network arbitrum')
        console.log('Chains: sol, stk, sui, ton, arb')
        process.exit(1)
    }
    if (!OFT_ADDRESS) throw new Error('Set ARBITRUM_CONTRACT_ADDRESS in .env')

    const dstChain = getChain(DST)
    const gasConfig = getGasConfig(DST)

    // Preflight
    const pathwayStatus = getPathwayStatus('arbitrum', DST)
    if (pathwayStatus === 'blocked') {
        console.error(`WARNING: Arb ↔ ${dstChain.name} pathway is BLOCKED (no LZ endpoint).`)
    }

    // Resolve destination peer address from env
    const peerAddress = resolvePeerAddress(DST)
    if (!peerAddress) throw new Error(`No peer address found for ${DST}. Set the appropriate env var.`)

    const peerBytes32 = addressToBytes32Hex(peerAddress)

    console.log(`=== Wiring Arbitrum OFT → ${dstChain.name} (EID ${dstChain.eid}) ===\n`)

    const [deployer] = await ethers.getSigners()
    console.log(`Deployer: ${deployer.address}`)
    const balance = await deployer.getBalance()
    console.log(`Balance: ${ethers.utils.formatEther(balance)} ETH`)
    console.log(`OFT: ${OFT_ADDRESS}`)
    console.log(`Peer: ${peerBytes32}\n`)

    const oft = new ethers.Contract(OFT_ADDRESS, OFT_ABI, deployer)

    // ===== Step 1: Set Peer =====
    console.log('Step 1: Setting peer...')
    const currentPeer = await oft.peers(dstChain.eid)

    if (currentPeer.toLowerCase() === peerBytes32.toLowerCase()) {
        console.log('  Peer already set correctly. Skipping.')
    } else if (currentPeer !== ethers.constants.HashZero) {
        console.log(`  WARNING: Different peer set: ${currentPeer}`)
        console.log(`  Updating to: ${peerBytes32}`)
        const tx = await oft.setPeer(dstChain.eid, peerBytes32)
        console.log(`  TX: ${tx.hash}`)
        await tx.wait()
        console.log(`  https://arbiscan.io/tx/${tx.hash}`)
    } else {
        const tx = await oft.setPeer(dstChain.eid, peerBytes32)
        console.log(`  TX: ${tx.hash}`)
        await tx.wait()
        console.log(`  https://arbiscan.io/tx/${tx.hash}`)
    }

    // ===== Step 2: Set Enforced Options =====
    console.log('\nStep 2: Setting enforced options...')
    const options = Options.newOptions()
        .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
        .toHex()
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)

    const currentOptions = await oft.enforcedOptions(dstChain.eid, 1)
    if (currentOptions === options) {
        console.log('  Enforced options already set correctly. Skipping.')
    } else {
        const tx = await oft.setEnforcedOptions([
            { eid: dstChain.eid, msgType: 1, options },
        ])
        console.log(`  TX: ${tx.hash}`)
        await tx.wait()
        console.log(`  https://arbiscan.io/tx/${tx.hash}`)
    }

    // ===== Step 3 (Optional): Set DVN Config =====
    if (SET_DVN) {
        console.log('\nStep 3: Setting DVN/executor config...')
        const endpoint = new ethers.Contract(ENDPOINT_V2, ENDPOINT_ABI, deployer)

        const dvn = DVNS.arbitrum.lzLabs.address
        const executor = EXECUTORS.arbitrum?.address || ''
        console.log(`  DVN: ${dvn}`)
        console.log(`  Executor: ${executor}`)

        // Send ULN config
        const sendLib = await endpoint.defaultSendLibrary(dstChain.eid)
        console.log(`  Send library: ${sendLib}`)

        const sendUlnConfig = encodeEvmUlnConfig({
            confirmations: gasConfig.confirmations,
            requiredDvns: [dvn],
        })
        const executorConfig = encodeEvmExecutorConfig(executor)

        const tx1 = await endpoint.setConfig(OFT_ADDRESS, sendLib, [
            { eid: dstChain.eid, configType: 1, config: executorConfig },
            { eid: dstChain.eid, configType: 2, config: sendUlnConfig },
        ])
        console.log(`  Send config TX: ${tx1.hash}`)
        await tx1.wait()

        // Receive ULN config
        let recvLib: string
        try {
            recvLib = await endpoint.defaultReceiveLibrary(dstChain.eid)
        } catch {
            recvLib = sendLib
        }

        const recvUlnConfig = encodeEvmUlnConfig({
            confirmations: 1, // Low confirmations for fast chains
            requiredDvns: [dvn],
        })

        const tx2 = await endpoint.setConfig(OFT_ADDRESS, recvLib, [
            { eid: dstChain.eid, configType: 2, config: recvUlnConfig },
        ])
        console.log(`  Recv config TX: ${tx2.hash}`)
        await tx2.wait()
    }

    // ===== Verify =====
    console.log('\n=== Verification ===')
    const finalPeer = await oft.peers(dstChain.eid)
    const finalOptions = await oft.enforcedOptions(dstChain.eid, 1)
    console.log(`Peer for ${dstChain.name} (${dstChain.eid}): ${finalPeer}`)
    console.log(`Enforced options (SEND): ${finalOptions}`)
    console.log(`\n=== Arbitrum → ${dstChain.name} wiring complete ===`)
}

// ============ Helpers ============

function resolvePeerAddress(dst: string): string {
    switch (dst) {
        case 'sol':
        case 'solana':
            return process.env.SOLANA_OFT_STORE || ''
        case 'stk':
        case 'starknet':
            return process.env.STARKNET_ADAPTER_ADDRESS || ''
        case 'sui':
            return process.env.SUI_OFT_PACKAGE || '' // Package ID = peer
        case 'ton':
            return process.env.TON_OFT_ADAPTER_HASH || ''
        case 'arb':
        case 'arbitrum':
            return process.env.ARBITRUM_CONTRACT_ADDRESS || ''
        default:
            return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
