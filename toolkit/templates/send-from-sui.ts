/**
 * Send OFT tokens from Sui → any destination.
 * Uses splitCoin + transferObjects pattern.
 *
 * Usage:
 *   DST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-sui.ts
 *   DST=sol AMOUNT=5 npx tsx toolkit/templates/send-from-sui.ts
 */

import 'dotenv/config'
import { SuiClient } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import { SDK } from '@layerzerolabs/lz-sui-sdk-v2'
import { OFT } from '@layerzerolabs/lz-sui-oft-sdk-v2'
import { Stage } from '@layerzerolabs/lz-definitions'

import { getChain, getPathwayStatus } from '../constants'
import { addressToBytes32Uint8, getLzScanUrl } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const AMOUNT = process.env.AMOUNT || '1'
const TOKEN_DECIMALS = 6

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || ''
const TOKEN_PACKAGE = process.env.SUI_TOKEN_PACKAGE || ''
const OFT_PACKAGE = process.env.SUI_OFT_PACKAGE || ''
const OFT_OBJECT = process.env.SUI_OFT_OBJECT || ''
const OAPP_OBJECT = process.env.SUI_OAPP_OBJECT || ''
const ADMIN_CAP = process.env.SUI_ADMIN_CAP || ''

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> AMOUNT=<n> npx tsx toolkit/templates/send-from-sui.ts')
        process.exit(1)
    }
    if (!TOKEN_PACKAGE || !OFT_PACKAGE || !OFT_OBJECT || !OAPP_OBJECT) {
        throw new Error('Missing SUI_* env vars')
    }

    const dstChain = getChain(DST)
    const recipientAddress = resolveRecipient(DST)
    if (!recipientAddress) throw new Error(`No recipient for ${DST}`)

    const pathwayStatus = getPathwayStatus('sui', DST)
    if (pathwayStatus === 'blocked') {
        throw new Error(`Sui → ${dstChain.name} pathway is BLOCKED. Do NOT send tokens.`)
    }

    const recipientBytes = addressToBytes32Uint8(recipientAddress)

    const tokenSymbol = process.env.TOKEN_SYMBOL || 'OFT'
    console.log(`=== Sending ${AMOUNT} ${tokenSymbol}: Sui → ${dstChain.name} ===\n`)

    const client = new SuiClient({ url: SUI_RPC_URL })
    const keypair = getKeypair()
    const deployer = keypair.toSuiAddress()

    console.log(`Deployer: ${deployer}`)

    // Check balances
    const suiBalance = await client.getBalance({ owner: deployer })
    console.log(`SUI balance: ${Number(suiBalance.totalBalance) / 1e9} SUI`)

    const coinType = process.env.SUI_COIN_TYPE
    if (!coinType) throw new Error('Set SUI_COIN_TYPE in .env (format: 0xPACKAGE::module::STRUCT)')
    const tokenBalance = await client.getBalance({ owner: deployer, coinType })
    console.log(`${tokenSymbol} balance: ${Number(tokenBalance.totalBalance) / 10 ** TOKEN_DECIMALS} ${tokenSymbol}`)

    // Create SDK + OFT
    const sdk = new SDK({ client, stage: Stage.MAINNET })
    const oft = new OFT(sdk, OFT_PACKAGE, OFT_OBJECT, coinType, OAPP_OBJECT, ADMIN_CAP)

    const amountLD = BigInt(AMOUNT) * BigInt(10 ** TOKEN_DECIMALS)
    const minAmountLD = (amountLD * 99n) / 100n

    console.log(`\nRecipient: ${recipientAddress}`)
    console.log(`Recipient (bytes32): 0x${Buffer.from(recipientBytes).toString('hex')}`)

    const sendParam = {
        dstEid: dstChain.eid,
        to: recipientBytes,
        amountLd: amountLD,
        minAmountLd: minAmountLD,
        extraOptions: new Uint8Array(0),
        composeMsg: new Uint8Array(0),
        oftCmd: new Uint8Array(0),
    }

    // Quote
    console.log('\nQuoting...')
    const fee = await oft.quoteSend(deployer, sendParam, false)
    console.log(`Native fee: ${Number(fee.nativeFee) / 1e9} SUI`)

    // Send
    console.log('\nSending...')
    const tx = new Transaction()
    tx.setSender(deployer)

    const coin = await oft.splitCoinMoveCall(tx, deployer, amountLD)
    await oft.sendMoveCall(tx, deployer, sendParam, coin, fee.nativeFee, fee.zroFee, deployer)
    tx.transferObjects([coin], deployer) // Required: return unused coin

    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true },
    })

    console.log(`\nTX: ${result.digest}`)
    console.log(`Status: ${result.effects?.status?.status}`)
    console.log(`https://suiscan.xyz/mainnet/tx/${result.digest}`)

    if (result.effects?.status?.status !== 'success') {
        console.error('ERROR:', JSON.stringify(result.effects?.status))
        throw new Error('Send failed')
    }

    // New balance
    const newBalance = await client.getBalance({ owner: deployer, coinType })
    console.log(`\nNew balance: ${Number(newBalance.totalBalance) / 10 ** TOKEN_DECIMALS} ${tokenSymbol}`)
    console.log(`\nTrack: ${getLzScanUrl(result.digest)}`)
}

function getKeypair(): Ed25519Keypair {
    if (!SUI_PRIVATE_KEY) throw new Error('Set SUI_PRIVATE_KEY in .env')
    if (SUI_PRIVATE_KEY.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY)
    if (SUI_PRIVATE_KEY.startsWith('0x')) return Ed25519Keypair.fromSecretKey(Buffer.from(SUI_PRIVATE_KEY.slice(2), 'hex'))
    return Ed25519Keypair.fromSecretKey(fromBase64(SUI_PRIVATE_KEY))
}

function resolveRecipient(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.EVM_DEPLOYER_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_DEPLOYER_ADDRESS || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ACCOUNT_ADDRESS || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
