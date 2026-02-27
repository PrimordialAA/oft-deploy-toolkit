/**
 * Send OFT tokens from TON → any destination.
 * Uses classlib md encoding + SEND_OFT opcode.
 *
 * Usage:
 *   DEST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-ton.ts
 *   DEST=sol AMOUNT=5 npx tsx toolkit/templates/send-from-ton.ts
 *
 * Run: cd ton/lz-framework && DEST=arb AMOUNT=1 npx tsx ../../toolkit/templates/send-from-ton.ts
 */

import {
    Address,
    beginCell,
    toNano,
    mnemonicToWalletKey,
    TonClient,
    WalletContractV4,
    internal,
    clDeclare,
    CL_TYPE,
} from '../../ton/lz-framework/wrappers/classlib'
import * as path from 'path'
import * as dotenv from 'dotenv'
import bs58 from 'bs58'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { getChain, getPathwayStatus, TON_CONSTANTS } from '../constants'

// ============ Config ============

const DEST = (process.env.DEST || process.env.DST || '').toLowerCase()
const AMOUNT = parseInt(process.env.AMOUNT || '1', 10)
const AMOUNT_SD = BigInt(AMOUNT) * 1_000_000n // 6 decimals

const TON_MNEMONIC = process.env.TON_MNEMONIC || ''
const TON_RPC_URL = process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'
const TON_API_KEY = process.env.TON_API_KEY || ''
const TON_OFT_ADAPTER = process.env.TON_OFT_ADAPTER || ''

const OPS = TON_CONSTANTS.opcodes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function retry<T>(fn: () => Promise<T>, label: string, maxRetries = 5, baseDelay = 2000): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn() }
        catch (err: any) {
            const isRateLimit = err?.response?.status === 429 || err?.message?.includes('429')
            if (isRateLimit && i < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, i)
                console.log(`  [${label}] Rate limited, retrying in ${delay / 1000}s...`)
                await sleep(delay)
            } else throw err
        }
    }
    throw new Error(`${label}: max retries exceeded`)
}

async function waitForSeqno(walletContract: any, prevSeqno: number, label: string, maxWait = 60000) {
    const start = Date.now()
    while (Date.now() - start < maxWait) {
        await sleep(3000)
        try {
            const current = await walletContract.getSeqno()
            if (current > prevSeqno) {
                console.log(`  ${label}: confirmed (seqno ${prevSeqno} → ${current})`)
                return true
            }
        } catch (err: any) {
            if (err?.response?.status === 429) await sleep(3000)
        }
        process.stdout.write('.')
    }
    console.log(`\n  ${label}: not confirmed after ${maxWait / 1000}s`)
    return false
}

function addressToBytes32(address: string): bigint {
    if (!address.startsWith('0x') && address.length > 40 && address.length < 50) {
        const bytes = bs58.decode(address)
        return BigInt('0x' + Buffer.from(bytes).toString('hex').padStart(64, '0'))
    }
    return BigInt('0x' + address.replace('0x', '').padStart(64, '0'))
}

async function main() {
    if (!DEST) {
        console.log('Usage: DEST=<chain> AMOUNT=<n> npx tsx toolkit/templates/send-from-ton.ts')
        console.log('Chains: arb, sol, stk, sui')
        process.exit(1)
    }
    if (!TON_MNEMONIC) throw new Error('Set TON_MNEMONIC in .env')
    if (!TON_OFT_ADAPTER) throw new Error('Set TON_OFT_ADAPTER in .env')

    const dstChain = getChain(DEST)
    const recipientAddress = resolveRecipient(DEST)
    if (!recipientAddress) throw new Error(`No recipient for ${DEST}`)

    const pathwayStatus = getPathwayStatus('ton', DEST)
    if (pathwayStatus === 'blocked') {
        throw new Error(`TON → ${dstChain.name} pathway is BLOCKED. Do NOT send tokens.`)
    }

    const recipientBytes32 = addressToBytes32(recipientAddress)

    console.log(`=== Sending ${AMOUNT} ${process.env.TOKEN_SYMBOL || 'OFT'}: TON → ${dstChain.name} ===\n`)

    const mnemonic = TON_MNEMONIC.split(' ')
    const keyPair = await mnemonicToWalletKey(mnemonic)
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    const client = new TonClient({ endpoint: TON_RPC_URL, apiKey: TON_API_KEY || undefined })
    const walletContract = client.open(wallet)

    console.log(`Sender: ${wallet.address.toString()}`)
    await sleep(1500)
    const balance = await retry(() => walletContract.getBalance(), 'getBalance')
    console.log(`TON Balance: ${Number(balance) / 1e9} TON`)

    const adapterAddr = Address.parse(TON_OFT_ADAPTER)
    console.log(`Adapter: ${TON_OFT_ADAPTER}`)
    console.log(`Dest EID: ${dstChain.eid} (${dstChain.name})`)
    console.log(`Recipient: ${recipientAddress}`)
    console.log(`Recipient (bytes32): 0x${recipientBytes32.toString(16).padStart(64, '0')}`)
    console.log(`Amount: ${AMOUNT} ${process.env.TOKEN_SYMBOL || 'OFT'} (${AMOUNT_SD} raw SD)`)

    const nativeFee = toNano('0.5')
    const zroFee = 0n

    // Build oftSend md cell
    const oftSendMd = clDeclare('oftSend', [
        { type: CL_TYPE.UINT32, value: dstChain.eid },
        { type: CL_TYPE.UINT256, value: recipientBytes32 },
        { type: CL_TYPE.UINT64, value: AMOUNT_SD },
        { type: CL_TYPE.COINS, value: nativeFee },
        { type: CL_TYPE.COINS, value: zroFee },
        { type: CL_TYPE.OBJ_REF, value: beginCell().endCell() }, // extra options
    ])

    const body = beginCell()
        .storeUint(OPS.SEND_OFT, 32)
        .storeUint(0, 64)
        .storeCoins(0n)
        .storeRef(oftSendMd)
        .endCell()

    const totalValue = toNano(TON_CONSTANTS.sendTxValue)

    console.log(`\nNative fee (in md): ${Number(nativeFee) / 1e9} TON`)
    console.log(`Total TX value: ${Number(totalValue) / 1e9} TON (excess refunded)`)
    console.log(`NOTE: v1 adapter does not burn — TON supply won't decrease.`)

    await sleep(2000)
    const seqno = await retry(() => walletContract.getSeqno(), 'seqno')
    await sleep(1500)
    await retry(
        () => walletContract.sendTransfer({
            secretKey: keyPair.secretKey,
            seqno,
            messages: [internal({ to: adapterAddr, value: totalValue, body })],
        }),
        'sendOft',
    )
    console.log(`\nTX sent (seqno: ${seqno})`)
    await waitForSeqno(walletContract, seqno, 'Send OFT')

    await sleep(3000)
    const finalBalance = await retry(() => walletContract.getBalance(), 'finalBalance')
    console.log(`\n=== Send Complete ===`)
    console.log(`TON remaining: ${Number(finalBalance) / 1e9} TON`)
    console.log(`Track: https://layerzeroscan.com`)
}

function resolveRecipient(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.EVM_DEPLOYER_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_DEPLOYER_ADDRESS || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ACCOUNT_ADDRESS || ''
        case 'sui': return process.env.SUI_DEPLOYER_ADDRESS || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
