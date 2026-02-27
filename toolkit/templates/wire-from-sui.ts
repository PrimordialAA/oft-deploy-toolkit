/**
 * Wire Sui OFT → any destination chain.
 *
 * Steps: DVN config (send+recv) → enforced options → peer.
 * 3s delays between TXs for RPC sync.
 *
 * Usage:
 *   DST=arb npx tsx toolkit/templates/wire-from-sui.ts
 *   DST=sol npx tsx toolkit/templates/wire-from-sui.ts
 */

import 'dotenv/config'
import { SuiClient } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import { SDK, PACKAGE_ULN_302_ADDRESS, OBJECT_ULN_302_ADDRESS, OAppUlnConfigBcs } from '@layerzerolabs/lz-sui-sdk-v2'
import { OFT } from '@layerzerolabs/lz-sui-oft-sdk-v2'
import { Stage } from '@layerzerolabs/lz-definitions'
import { Options } from '@layerzerolabs/lz-v2-utilities'

import { getChain, getGasConfig, DVNS, SUI_CONSTANTS, getPathwayStatus } from '../constants'
import { addressToBytes32Uint8 } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || ''
const TOKEN_PACKAGE = process.env.SUI_TOKEN_PACKAGE || ''
const OFT_PACKAGE = process.env.SUI_OFT_PACKAGE || ''
const OFT_OBJECT = process.env.SUI_OFT_OBJECT || ''
const OAPP_OBJECT = process.env.SUI_OAPP_OBJECT || ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============ Main ============

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> npx tsx toolkit/templates/wire-from-sui.ts')
        console.log('Chains: arb, sol, stk, ton')
        process.exit(1)
    }

    if (!TOKEN_PACKAGE || !OFT_PACKAGE || !OFT_OBJECT || !OAPP_OBJECT) {
        throw new Error('Missing SUI_* env vars. Run deploy-sui.ts first.')
    }

    const dstChain = getChain(DST)
    const gasConfig = getGasConfig(DST)
    const peerAddress = resolvePeerAddress(DST)
    if (!peerAddress) throw new Error(`No peer address found for ${DST}. Set the appropriate env var.`)

    // Preflight
    const pathwayStatus = getPathwayStatus('sui', DST)
    if (pathwayStatus === 'blocked') {
        console.error(`WARNING: Sui ↔ ${dstChain.name} pathway is BLOCKED (no LZ endpoint).`)
    }

    const peerBytes = addressToBytes32Uint8(peerAddress)

    console.log(`=== Wiring Sui OFT → ${dstChain.name} (EID ${dstChain.eid}) ===\n`)

    const client = new SuiClient({ url: SUI_RPC_URL })
    const keypair = getKeypair()
    const deployer = keypair.toSuiAddress()

    console.log(`Deployer: ${deployer}`)
    console.log(`OFT Pkg:  ${OFT_PACKAGE}`)
    console.log(`Peer:     0x${Buffer.from(peerBytes).toString('hex')}\n`)

    const balance = await client.getBalance({ owner: deployer })
    console.log(`SUI balance: ${Number(balance.totalBalance) / 1e9} SUI\n`)

    const sdk = new SDK({ client, stage: Stage.MAINNET })
    const coinType = process.env.SUI_COIN_TYPE
    if (!coinType) throw new Error('Set SUI_COIN_TYPE in .env (format: 0xPACKAGE::module::STRUCT)')
    const oft = new OFT(sdk, OFT_PACKAGE, OFT_OBJECT, coinType, OAPP_OBJECT)
    const oapp = sdk.getOApp(OFT_PACKAGE)

    const uln302Pkg = PACKAGE_ULN_302_ADDRESS[Stage.MAINNET]
    const uln302Obj = OBJECT_ULN_302_ADDRESS[Stage.MAINNET]
    const dvnLzLabs = DVNS.sui.lzLabs.address

    // ===== Step 1: DVN Config (Send ULN) =====
    console.log('Step 1: Setting send ULN config...')
    try {
        const sendConfig = OAppUlnConfigBcs.serialize({
            use_default_confirmations: false,
            use_default_required_dvns: false,
            use_default_optional_dvns: true,
            uln_config: {
                confirmations: gasConfig.confirmations,
                required_dvns: [dvnLzLabs],
                optional_dvns: [],
                optional_dvn_threshold: 0,
            },
        }).toBytes()

        const tx = new Transaction()
        tx.setSender(deployer)
        const call = await oapp.setConfigMoveCall(tx, uln302Pkg, dstChain.eid, 2, sendConfig)
        tx.moveCall({
            target: `${uln302Pkg}::uln_302::set_config`,
            arguments: [tx.object(uln302Obj), call],
        })

        const result = await client.signAndExecuteTransaction({
            signer: keypair, transaction: tx, options: { showEffects: true },
        })
        console.log(`  TX: ${result.digest} (${result.effects?.status?.status})`)
    } catch (e: any) {
        console.error(`  Send ULN config failed: ${e.message?.slice(0, 200)}`)
    }

    await sleep(SUI_CONSTANTS.rpcSyncDelayMs)

    // ===== Step 2: DVN Config (Recv ULN) =====
    console.log('\nStep 2: Setting recv ULN config...')
    try {
        const recvConfig = OAppUlnConfigBcs.serialize({
            use_default_confirmations: false,
            use_default_required_dvns: false,
            use_default_optional_dvns: true,
            uln_config: {
                confirmations: gasConfig.confirmations,
                required_dvns: [dvnLzLabs],
                optional_dvns: [],
                optional_dvn_threshold: 0,
            },
        }).toBytes()

        const tx = new Transaction()
        tx.setSender(deployer)
        const call = await oapp.setConfigMoveCall(tx, uln302Pkg, dstChain.eid, 3, recvConfig)
        tx.moveCall({
            target: `${uln302Pkg}::uln_302::set_config`,
            arguments: [tx.object(uln302Obj), call],
        })

        const result = await client.signAndExecuteTransaction({
            signer: keypair, transaction: tx, options: { showEffects: true },
        })
        console.log(`  TX: ${result.digest} (${result.effects?.status?.status})`)
    } catch (e: any) {
        console.error(`  Recv ULN config failed: ${e.message?.slice(0, 200)}`)
    }

    await sleep(SUI_CONSTANTS.rpcSyncDelayMs)

    // ===== Step 3: Enforced Options =====
    console.log('\nStep 3: Setting enforced options...')
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)
    try {
        const options = Options.newOptions()
            .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
            .toBytes()

        const tx = new Transaction()
        tx.setSender(deployer)
        await oapp.setEnforcedOptionsMoveCall(tx, dstChain.eid, 1, options)

        const result = await client.signAndExecuteTransaction({
            signer: keypair, transaction: tx, options: { showEffects: true },
        })
        console.log(`  TX: ${result.digest} (${result.effects?.status?.status})`)
    } catch (e: any) {
        console.error(`  Enforced options failed: ${e.message?.slice(0, 200)}`)
    }

    await sleep(SUI_CONSTANTS.rpcSyncDelayMs)

    // ===== Step 4: Set Peer =====
    console.log('\nStep 4: Setting peer...')
    try {
        const tx = new Transaction()
        tx.setSender(deployer)
        await oapp.setPeerMoveCall(tx, dstChain.eid, peerBytes)

        const result = await client.signAndExecuteTransaction({
            signer: keypair, transaction: tx, options: { showEffects: true },
        })
        console.log(`  TX: ${result.digest} (${result.effects?.status?.status})`)
    } catch (e: any) {
        console.error(`  setPeer failed: ${e.message?.slice(0, 200)}`)
    }

    console.log(`\n=== Sui → ${dstChain.name} wiring complete ===`)
}

function getKeypair(): Ed25519Keypair {
    if (!SUI_PRIVATE_KEY) throw new Error('Set SUI_PRIVATE_KEY in .env')
    if (SUI_PRIVATE_KEY.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY)
    if (SUI_PRIVATE_KEY.startsWith('0x')) return Ed25519Keypair.fromSecretKey(Buffer.from(SUI_PRIVATE_KEY.slice(2), 'hex'))
    return Ed25519Keypair.fromSecretKey(fromBase64(SUI_PRIVATE_KEY))
}

function resolvePeerAddress(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.ARBITRUM_CONTRACT_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_OFT_STORE || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ADAPTER_ADDRESS || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
