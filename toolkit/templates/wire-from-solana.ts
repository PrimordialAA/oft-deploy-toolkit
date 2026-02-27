/**
 * Wire Solana OFT → any destination chain.
 *
 * Steps: 4 PDA inits (idempotent) → setPeer → setEnforcedOptions → (optional) DVN config.
 *
 * Usage:
 *   DST=arb npx tsx toolkit/templates/wire-from-solana.ts
 *   DST=stk npx tsx toolkit/templates/wire-from-solana.ts
 *   DST=sui SET_DVN=true npx tsx toolkit/templates/wire-from-solana.ts
 */

import 'dotenv/config'

const { PublicKey } = require('@solana/web3.js')
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults')
const { mplToolbox, setComputeUnitPrice, setComputeUnitLimit } = require('@metaplex-foundation/mpl-toolbox')
const { createSignerFromKeypair, signerIdentity, transactionBuilder, publicKey } = require('@metaplex-foundation/umi')
const bs58Module = require('bs58')
const bs58 = bs58Module.default || bs58Module

const { getSolanaKeypair, createSolanaConnectionFactory, getPrioritizationFees } = require('@layerzerolabs/devtools-solana')
const { EndpointId } = require('@layerzerolabs/lz-definitions')
const { oft } = require('@layerzerolabs/oft-v2-solana-sdk')
const { Options } = require('@layerzerolabs/lz-v2-utilities')

import { getChain, getGasConfig, getPathwayStatus, SOLANA_CONSTANTS, DVNS } from '../constants'
import { addressToBytes32Uint8 } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const SET_DVN = process.env.SET_DVN === 'true'
const SOLANA_EID = EndpointId.SOLANA_V2_MAINNET
const OFT_PROGRAM_ID = process.env.SOLANA_OFT_PROGRAM_ID || ''
const OFT_STORE = process.env.SOLANA_OFT_STORE || ''

// ============ Main ============

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> npx tsx toolkit/templates/wire-from-solana.ts')
        console.log('Chains: arb, stk, sui, ton')
        process.exit(1)
    }
    if (!OFT_PROGRAM_ID || !OFT_STORE) {
        throw new Error('Set SOLANA_OFT_PROGRAM_ID and SOLANA_OFT_STORE in .env')
    }

    const dstChain = getChain(DST)
    const gasConfig = getGasConfig(DST)
    const peerAddress = resolvePeerAddress(DST)
    if (!peerAddress) throw new Error(`No peer address found for ${DST}. Set the appropriate env var.`)

    // Preflight
    const pathwayStatus = getPathwayStatus('solana', DST)
    if (pathwayStatus === 'blocked') {
        console.error(`WARNING: Sol ↔ ${dstChain.name} pathway is BLOCKED (no LZ endpoint).`)
    }

    const peerBytes = addressToBytes32Uint8(peerAddress)

    console.log(`=== Wiring Solana OFT → ${dstChain.name} (EID ${dstChain.eid}) ===\n`)

    // Setup connection
    const connectionFactory = createSolanaConnectionFactory()
    const connection = await connectionFactory(SOLANA_EID)
    const keypair = await getSolanaKeypair()
    console.log(`Deployer: ${keypair.publicKey.toBase58()}`)

    // Setup UMI
    const umi = createUmi(connection.rpcEndpoint).use(mplToolbox())
    const umiWalletKeyPair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey)
    const umiWalletSigner = createSignerFromKeypair(umi, umiWalletKeyPair)
    umi.use(signerIdentity(umiWalletSigner))

    const programId = publicKey(OFT_PROGRAM_ID)
    const oftStorePk = publicKey(OFT_STORE)

    const { averageFeeExcludingZeros } = await getPrioritizationFees(connection)
    const priorityFee = Math.max(Math.round(averageFeeExcludingZeros), 1000)
    console.log(`Priority fee: ${priorityFee} microLamports`)
    console.log(`Peer: 0x${Buffer.from(peerBytes).toString('hex')}\n`)

    // ===== Step 1: Init 4 PDAs =====
    console.log('Step 1: Initializing endpoint PDAs...')
    const pdaInits = [
        { name: 'initSendLibrary', fn: () => oft.initSendLibrary({ admin: umiWalletSigner, oftStore: oftStorePk }, dstChain.eid) },
        { name: 'initReceiveLibrary', fn: () => oft.initReceiveLibrary({ admin: umiWalletSigner, oftStore: oftStorePk }, dstChain.eid) },
        { name: 'initOAppNonce', fn: () => oft.initOAppNonce({ admin: umiWalletSigner, oftStore: oftStorePk }, dstChain.eid, peerBytes) },
        { name: 'initConfig', fn: () => oft.initConfig({ admin: umiWalletSigner, oftStore: oftStorePk, payer: umiWalletSigner }, dstChain.eid, { oft: programId }) },
    ]

    for (const { name, fn } of pdaInits) {
        try {
            const ix = fn()
            const tx = transactionBuilder()
                .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
                .add(setComputeUnitLimit(umi, { units: 100000 }))
                .add(ix)
            const { signature } = await tx.sendAndConfirm(umi)
            console.log(`  ${name}: ${bs58.encode(signature)}`)
        } catch (e: any) {
            if (e.message?.includes('already in use') || e.message?.includes('0x0') || e.message?.includes('already been processed')) {
                console.log(`  ${name}: already initialized (skipping)`)
            } else {
                throw e
            }
        }
    }

    // ===== Step 2: Set Peer =====
    console.log('\nStep 2: Setting peer...')
    try {
        const setPeerIx = oft.setPeerConfig(
            { admin: umiWalletSigner, oftStore: oftStorePk },
            { __kind: 'PeerAddress', peer: peerBytes, remote: dstChain.eid },
            programId
        )
        const tx = transactionBuilder()
            .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
            .add(setComputeUnitLimit(umi, { units: 60000 }))
            .add(setPeerIx)
        const { signature } = await tx.sendAndConfirm(umi)
        console.log(`  TX: ${bs58.encode(signature)}`)
    } catch (e: any) {
        console.error('  setPeer failed:', e.message?.slice(0, 200))
        throw e
    }

    // ===== Step 3: Set Enforced Options =====
    console.log('\nStep 3: Setting enforced options...')
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)
    try {
        const options = Options.newOptions()
            .addExecutorLzReceiveOption(gasConfig.lzReceiveGas, gasConfig.lzReceiveValue)
            .toBytes()

        const setOptionsIx = oft.setPeerConfig(
            { admin: umiWalletSigner, oftStore: oftStorePk },
            {
                __kind: 'EnforcedOptions',
                send: options,
                sendAndCall: new Uint8Array([0, 3]),
                remote: dstChain.eid,
            },
            programId
        )
        const tx = transactionBuilder()
            .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
            .add(setComputeUnitLimit(umi, { units: 60000 }))
            .add(setOptionsIx)
        const { signature } = await tx.sendAndConfirm(umi)
        console.log(`  TX: ${bs58.encode(signature)}`)
    } catch (e: any) {
        console.error('  setEnforcedOptions failed:', e.message?.slice(0, 200))
        throw e
    }

    // ===== Step 4 (Optional): Set DVN Config =====
    if (SET_DVN) {
        console.log('\nStep 4: Setting DVN config...')
        const { SetConfigType } = require('@layerzerolabs/lz-solana-sdk-v2')
        const dvnPda = new PublicKey(DVNS.solana.lzLabs.address)
        console.log(`  DVN PDA: ${dvnPda.toBase58()}`)

        // Send ULN
        const sendUlnConfig = {
            confirmations: BigInt(gasConfig.confirmations),
            requiredDvnCount: 1,
            optionalDvnCount: 0,
            optionalDvnThreshold: 0,
            requiredDvns: [dvnPda],
            optionalDvns: [],
        }
        try {
            const ix = await oft.setConfig(
                umi.rpc,
                { signer: umiWalletSigner, oftStore: oftStorePk },
                { remoteEid: dstChain.eid, configType: SetConfigType.SEND_ULN, config: sendUlnConfig }
            )
            const tx = transactionBuilder()
                .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
                .add(setComputeUnitLimit(umi, { units: 200000 }))
                .add(ix)
            const { signature } = await tx.sendAndConfirm(umi)
            console.log(`  SEND_ULN TX: ${bs58.encode(signature)}`)
        } catch (e: any) {
            console.error('  SEND_ULN error:', e.message?.slice(0, 200))
        }

        // Receive ULN
        const recvUlnConfig = { ...sendUlnConfig, confirmations: BigInt(1) }
        try {
            const ix = await oft.setConfig(
                umi.rpc,
                { signer: umiWalletSigner, oftStore: oftStorePk },
                { remoteEid: dstChain.eid, configType: SetConfigType.RECEIVE_ULN, config: recvUlnConfig }
            )
            const tx = transactionBuilder()
                .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
                .add(setComputeUnitLimit(umi, { units: 200000 }))
                .add(ix)
            const { signature } = await tx.sendAndConfirm(umi)
            console.log(`  RECEIVE_ULN TX: ${bs58.encode(signature)}`)
        } catch (e: any) {
            console.error('  RECEIVE_ULN error:', e.message?.slice(0, 200))
        }

        // Executor
        try {
            const ix = await oft.setConfig(
                umi.rpc,
                { signer: umiWalletSigner, oftStore: oftStorePk },
                {
                    remoteEid: dstChain.eid,
                    configType: SetConfigType.EXECUTOR,
                    config: {
                        maxMessageSize: 10000,
                        executor: new PublicKey(SOLANA_CONSTANTS.dvnProgramId),
                    },
                }
            )
            const tx = transactionBuilder()
                .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
                .add(setComputeUnitLimit(umi, { units: 200000 }))
                .add(ix)
            const { signature } = await tx.sendAndConfirm(umi)
            console.log(`  EXECUTOR TX: ${bs58.encode(signature)}`)
        } catch (e: any) {
            console.error('  EXECUTOR error (non-fatal):', e.message?.slice(0, 200))
        }
    }

    console.log(`\n=== Solana → ${dstChain.name} wiring complete ===`)
}

function resolvePeerAddress(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.ARBITRUM_CONTRACT_ADDRESS || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ADAPTER_ADDRESS || ''
        case 'sui': return process.env.SUI_OFT_PACKAGE || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
