/**
 * Wire Starknet OFT Adapter → any destination chain.
 *
 * Steps: set_delegate → DVN config (send+recv) → set_enforced_options → set_peer
 *
 * Usage:
 *   DST=arb npx ts-node toolkit/templates/wire-from-starknet.ts
 *   DST=sol npx ts-node toolkit/templates/wire-from-starknet.ts
 */

import 'dotenv/config'
import { Account, RpcProvider, Contract, uint256, num } from 'starknet'
import { Options } from '@layerzerolabs/lz-v2-utilities'

import { getChain, getGasConfig, getPathwayStatus, DVNS } from '../constants'
import { addressToBytes32BigInt } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()

// ============ Helpers ============

/** Try multiple function names on a contract, return first that resolves. */
async function callFirst(contract: Contract, names: string[], args: any[]): Promise<any> {
    for (const name of names) {
        try {
            return await contract.call(name, args)
        } catch {
            continue
        }
    }
    throw new Error(`None of [${names.join(', ')}] found on contract`)
}

/** Invoke a contract method, log TX, wait for confirmation. */
async function invokeAndWait(
    contract: Contract,
    method: string,
    args: any[],
    provider: RpcProvider,
    label: string,
): Promise<string> {
    const tx = await contract.invoke(method, args)
    console.log(`  TX: ${tx.transaction_hash}`)
    await provider.waitForTransaction(tx.transaction_hash)
    console.log(`  ${label}`)
    return tx.transaction_hash
}

/**
 * Build a ULN config as Cairo-serialized felt array.
 * Layout: [confirmations, req_count, opt_count, opt_threshold, req_len, ...dvns, opt_len]
 */
function buildUlnConfigFelts(confirmations: number, requiredDvns: string[]): string[] {
    return [
        confirmations.toString(),
        requiredDvns.length.toString(),
        '0',  // optional_dvn_count
        '0',  // optional_dvn_threshold
        requiredDvns.length.toString(),
        ...requiredDvns,
        '0',  // optional_dvns (empty)
    ]
}

// ============ Main ============

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

    // Load contract ABIs from chain
    const adapterClassAt = await provider.getClassAt(adapterAddress)
    const adapter = new Contract({
        abi: adapterClassAt.abi,
        address: adapterAddress,
        providerOrAccount: account,
    })

    const endpointAddress = getChain('stk').endpointAddress
    const endpointClassAt = await provider.getClassAt(endpointAddress)
    const endpoint = new Contract({
        abi: endpointClassAt.abi,
        address: endpointAddress,
        providerOrAccount: account,
    })

    const dvnAddress = DVNS.starknet.lzLabs.address

    // ===== Step 1: Set Delegate =====
    console.log('Step 1: Setting delegate to deployer...')
    try {
        await invokeAndWait(adapter, 'set_delegate', [account.address], provider, 'Delegate set!')
    } catch (e: any) {
        console.log(`  set_delegate skipped (likely already set): ${e.message?.slice(0, 120)}`)
    }

    // ===== Step 2: Configure Send ULN (DVN) =====
    console.log('\nStep 2: Configuring send ULN DVN...')
    console.log(`  DVN: ${dvnAddress}`)
    try {
        const sendLib = num.toHex(
            await callFirst(endpoint, ['default_send_library', 'get_default_send_library'], [dstChain.eid]) as any
        )
        console.log(`  Send library: ${sendLib}`)

        await invokeAndWait(endpoint, 'set_config', [
            adapterAddress,
            sendLib,
            [{ eid: dstChain.eid, config_type: 2, config: buildUlnConfigFelts(gasConfig.confirmations, [dvnAddress]) }],
        ], provider, 'Send ULN DVN configured!')
    } catch (e: any) {
        console.error(`  Send ULN config failed: ${e.message?.slice(0, 200)}`)
        console.error('  Continuing with remaining steps...')
    }

    // ===== Step 3: Configure Recv ULN (DVN) =====
    console.log('\nStep 3: Configuring recv ULN DVN...')
    try {
        const recvLib = num.toHex(
            await callFirst(endpoint, ['default_receive_library', 'get_default_receive_library', 'default_send_library'], [dstChain.eid]) as any
        )
        console.log(`  Recv library: ${recvLib}`)

        await invokeAndWait(endpoint, 'set_config', [
            adapterAddress,
            recvLib,
            [{ eid: dstChain.eid, config_type: 2, config: buildUlnConfigFelts(1, [dvnAddress]) }],
        ], provider, 'Recv ULN DVN configured!')
    } catch (e: any) {
        console.error(`  Recv ULN config failed: ${e.message?.slice(0, 200)}`)
        console.error('  Continuing with remaining steps...')
    }

    // ===== Step 4: Set Enforced Options =====
    console.log(`\nStep 4: Setting enforced options for ${dstChain.name}...`)
    const options = Options.newOptions()
        .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
        .toBytes()
    const optionsHex = '0x' + Buffer.from(options).toString('hex')
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)

    await invokeAndWait(adapter, 'set_enforced_options', [[{
        eid: dstChain.eid,
        msg_type: 1, // SEND
        options: optionsHex,
    }]], provider, 'Enforced options set!')

    // ===== Step 5: Set Peer =====
    console.log(`\nStep 5: Setting ${dstChain.name} as peer...`)
    await invokeAndWait(adapter, 'set_peer', [
        dstChain.eid,
        { value: uint256.bnToUint256(peerBigInt) },
    ], provider, 'Peer set!')

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
