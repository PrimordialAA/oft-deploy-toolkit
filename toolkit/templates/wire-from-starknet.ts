/**
 * Wire Starknet OFT Adapter → any destination chain.
 *
 * Order CRITICAL: set_delegate → set_enforced_options → set_peer
 *
 * Usage:
 *   DST=arb npx ts-node toolkit/templates/wire-from-starknet.ts
 *   DST=sol npx ts-node toolkit/templates/wire-from-starknet.ts
 */

import 'dotenv/config'
import { Account, RpcProvider, Contract, uint256, num } from 'starknet'
import { Options } from '@layerzerolabs/lz-v2-utilities'

import { getChain, getGasConfig, getPathwayStatus } from '../constants'
import { addressToBytes32BigInt } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> npx ts-node toolkit/templates/wire-from-starknet.ts')
        console.log('Chains: arb, sol, sui, ton')
        process.exit(1)
    }

    const rpcUrl = process.env.STARKNET_RPC_URL || process.env.RPC_STARKNET
    const privateKey = process.env.STARKNET_PRIVATE_KEY
    const accountAddress = process.env.STARKNET_ACCOUNT_ADDRESS
    const adapterAddress = process.env.STARKNET_ADAPTER_ADDRESS

    if (!rpcUrl || !privateKey || !accountAddress) {
        throw new Error('Missing STARKNET_RPC_URL, STARKNET_PRIVATE_KEY, or STARKNET_ACCOUNT_ADDRESS in .env')
    }
    if (!adapterAddress) {
        throw new Error('Missing STARKNET_ADAPTER_ADDRESS in .env')
    }

    const dstChain = getChain(DST)
    const gasConfig = getGasConfig(DST)
    const peerAddress = resolvePeerAddress(DST)
    if (!peerAddress) throw new Error(`No peer address found for ${DST}. Set the appropriate env var.`)

    // Preflight
    const pathwayStatus = getPathwayStatus('starknet', DST)
    if (pathwayStatus === 'blocked') {
        console.error(`WARNING: Stk ↔ ${dstChain.name} pathway is BLOCKED (no LZ endpoint).`)
    }

    const peerBigInt = addressToBytes32BigInt(peerAddress)

    console.log(`=== Wiring Starknet OFT → ${dstChain.name} (EID ${dstChain.eid}) ===\n`)

    const provider = new RpcProvider({ nodeUrl: rpcUrl })
    const account = new Account({ provider, address: accountAddress, signer: privateKey })

    console.log(`Deployer: ${account.address}`)
    console.log(`Adapter:  ${adapterAddress}`)
    console.log(`Peer:     0x${peerBigInt.toString(16).padStart(64, '0')}\n`)

    // Get adapter ABI
    const adapterClassAt = await provider.getClassAt(adapterAddress)
    const adapter = new Contract({
        abi: adapterClassAt.abi,
        address: adapterAddress,
        providerOrAccount: account,
    })

    // ===== Step 1: Set Delegate =====
    console.log('Step 1: Setting delegate to deployer...')
    try {
        const tx = await adapter.invoke('set_delegate', [account.address])
        console.log(`  TX: ${tx.transaction_hash}`)
        await provider.waitForTransaction(tx.transaction_hash)
        console.log('  Delegate set!')
    } catch (e: any) {
        console.log(`  set_delegate skipped (likely already set): ${e.message?.slice(0, 120)}`)
    }

    // ===== Step 2: Set Enforced Options =====
    console.log(`\nStep 2: Setting enforced options for ${dstChain.name}...`)
    const options = Options.newOptions()
        .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
        .toBytes()
    const optionsHex = '0x' + Buffer.from(options).toString('hex')
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)

    try {
        const tx = await adapter.invoke('set_enforced_options', [[{
            eid: dstChain.eid,
            msg_type: 1, // SEND
            options: optionsHex,
        }]])
        console.log(`  TX: ${tx.transaction_hash}`)
        await provider.waitForTransaction(tx.transaction_hash)
        console.log('  Enforced options set!')
    } catch (e: any) {
        console.error(`  set_enforced_options failed: ${e.message?.slice(0, 200)}`)
        throw e
    }

    // ===== Step 3: Set Peer =====
    console.log(`\nStep 3: Setting ${dstChain.name} as peer...`)
    try {
        const tx = await adapter.invoke('set_peer', [
            dstChain.eid,
            { value: uint256.bnToUint256(peerBigInt) },
        ])
        console.log(`  TX: ${tx.transaction_hash}`)
        await provider.waitForTransaction(tx.transaction_hash)
        console.log('  Peer set!')
    } catch (e: any) {
        console.error(`  set_peer failed: ${e.message?.slice(0, 200)}`)
        throw e
    }

    // ===== Verify =====
    console.log('\n=== Verification ===')
    try {
        const peer = await adapter.call('get_peer', [dstChain.eid])
        console.log(`  Peer for ${dstChain.name} (${dstChain.eid}): ${num.toHex(peer as any)}`)
    } catch (e: any) {
        console.log(`  Peer read error: ${e.message?.slice(0, 100)}`)
    }

    console.log(`\n=== Starknet → ${dstChain.name} wiring complete ===`)
}

function resolvePeerAddress(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.ARBITRUM_CONTRACT_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_OFT_STORE || ''
        case 'sui': return process.env.SUI_OFT_PACKAGE || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
