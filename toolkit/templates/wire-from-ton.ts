/**
 * Wire TON OFT Adapter → any destination chain.
 *
 * Steps: setPeer → setEnforcedOptions → setEpConfig → setReceiveConfig.
 * Uses classlib-encoded md cells for all TON-specific messages.
 *
 * Usage:
 *   DST=arb npx tsx toolkit/templates/wire-from-ton.ts    (from ton/lz-framework dir)
 *   DST=sol npx tsx toolkit/templates/wire-from-ton.ts
 *
 * Run: cd ton/lz-framework && DST=arb npx tsx ../../toolkit/templates/wire-from-ton.ts
 */

import {
    Address,
    beginCell,
    Cell,
    toNano,
    mnemonicToWalletKey,
    TonClient,
    WalletContractV4,
    internal,
    clDeclare,
    CL_TYPE,
    mdSetPeerNew,
    mdOptionsExtendedNew,
    mdOptionsV1New,
} from '../../ton/lz-framework/wrappers/classlib'
import * as path from 'path'
import * as dotenv from 'dotenv'
import bs58 from 'bs58'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { getChain, getGasConfig, getPathwayStatus, TON_CONSTANTS, DVNS } from '../constants'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const SET_EP_CONFIG = process.env.SET_EP_CONFIG !== 'false' // default true
const SET_RECV_CONFIG = process.env.SET_RECV_CONFIG !== 'false' // default true

const TON_MNEMONIC = process.env.TON_MNEMONIC || ''
const TON_RPC_URL = process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'
const TON_API_KEY = process.env.TON_API_KEY || ''
const TON_OFT_ADAPTER = process.env.TON_OFT_ADAPTER || ''
const OFT_ADAPTER_HASH_RAW = process.env.TON_OFT_ADAPTER_HASH || ''
const OFT_ADAPTER_HASH = OFT_ADAPTER_HASH_RAW ? BigInt(OFT_ADAPTER_HASH_RAW) : 0n
const TON_EID = 30343

const OPS = TON_CONSTANTS.opcodes
const ULN_MANAGER = BigInt(TON_CONSTANTS.ulnManager)
const CONTROLLER = BigInt(TON_CONSTANTS.controller)
const LZ_LABS_DVN = BigInt(DVNS.ton.lzLabs.address)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============ Helpers ============

function addressToBytes32BigInt(address: string): bigint {
    if (address.startsWith('0x')) {
        return BigInt('0x' + address.replace('0x', '').padStart(64, '0'))
    }
    const bytes = bs58.decode(address)
    return BigInt('0x' + Buffer.from(bytes).toString('hex').padStart(64, '0'))
}

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

async function sendTx(walletContract: any, keyPair: any, to: Address, value: string, body: Cell, label: string) {
    await sleep(2000)
    const seqno = await retry(() => walletContract.getSeqno(), `seqno-${label}`)
    await sleep(1500)
    await retry(
        () => walletContract.sendTransfer({
            secretKey: keyPair.secretKey,
            seqno,
            messages: [internal({ to, value: toNano(value), body })],
        }),
        label,
    )
    console.log(`  TX sent (seqno: ${seqno})`)
    await waitForSeqno(walletContract, seqno, label)
}

// ===== Classlib builders =====

function lzPathNew(srcEid: number, srcOApp: bigint, dstEid: number, dstOApp: bigint): Cell {
    return clDeclare('path', [
        { type: CL_TYPE.UINT32, value: srcEid },
        { type: CL_TYPE.ADDRESS, value: srcOApp },
        { type: CL_TYPE.UINT32, value: dstEid },
        { type: CL_TYPE.ADDRESS, value: dstOApp },
    ])
}

function setEpConfigNew(sendLib: bigint, recvLib: bigint): Cell {
    return clDeclare('SetEpCfg', [
        { type: CL_TYPE.BOOL, value: false }, // useDefaults
        { type: CL_TYPE.ADDRESS, value: sendLib },
        { type: CL_TYPE.ADDRESS, value: recvLib },
        { type: CL_TYPE.ADDRESS, value: 0n }, // timeout lib
        { type: CL_TYPE.UINT64, value: 0n }, // timeout expiry
    ])
}

function lzConfigNew(pathCell: Cell, forwardingAddr: bigint, opCode: number, config: Cell): Cell {
    return clDeclare('Config', [
        { type: CL_TYPE.OBJ_REF, value: pathCell },
        { type: CL_TYPE.ADDRESS, value: forwardingAddr },
        { type: CL_TYPE.UINT32, value: opCode },
        { type: CL_TYPE.OBJ_REF, value: config },
    ])
}

function ulnReceiveConfigNew(confirmations: bigint, dvnList: Cell): Cell {
    return clDeclare('UlnRecvCfg', [
        { type: CL_TYPE.BOOL, value: true }, // minCommitPacketGasNull (default)
        { type: CL_TYPE.UINT32, value: 0 },
        { type: CL_TYPE.BOOL, value: false }, // confirmationsNull
        { type: CL_TYPE.UINT64, value: confirmations },
        { type: CL_TYPE.BOOL, value: false }, // requiredDVNsNull
        { type: CL_TYPE.CELL_REF, value: dvnList },
        { type: CL_TYPE.BOOL, value: true }, // optionalDVNsNull (default)
        { type: CL_TYPE.CELL_REF, value: beginCell().endCell() },
        { type: CL_TYPE.UINT8, value: 0 },
    ])
}

// ============ Main ============

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> npx tsx toolkit/templates/wire-from-ton.ts')
        console.log('Chains: arb, sol, stk, sui')
        process.exit(1)
    }
    if (!TON_MNEMONIC) throw new Error('Set TON_MNEMONIC in .env')
    if (!TON_OFT_ADAPTER) throw new Error('Set TON_OFT_ADAPTER in .env')
    if (OFT_ADAPTER_HASH === 0n) throw new Error('Set TON_OFT_ADAPTER_HASH in .env')

    const dstChain = getChain(DST)
    const gasConfig = getGasConfig(DST)
    const peerAddress = resolvePeerAddress(DST)
    if (!peerAddress) throw new Error(`No peer address found for ${DST}`)

    const pathwayStatus = getPathwayStatus('ton', DST)
    if (pathwayStatus === 'blocked') {
        console.error(`WARNING: TON ↔ ${dstChain.name} pathway is BLOCKED (no LZ endpoint).`)
    }

    const peerBigInt = addressToBytes32BigInt(peerAddress)

    console.log(`=== Wiring TON OFT → ${dstChain.name} (EID ${dstChain.eid}) ===\n`)

    const mnemonic = TON_MNEMONIC.split(' ')
    const keyPair = await mnemonicToWalletKey(mnemonic)
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    const client = new TonClient({ endpoint: TON_RPC_URL, apiKey: TON_API_KEY || undefined })
    const walletContract = client.open(wallet)

    console.log(`Deployer: ${wallet.address.toString()}`)
    await sleep(1500)
    const balance = await retry(() => walletContract.getBalance(), 'getBalance')
    console.log(`Balance: ${Number(balance) / 1e9} TON`)

    const adapterAddr = Address.parse(TON_OFT_ADAPTER)
    console.log(`Adapter: ${TON_OFT_ADAPTER}`)
    console.log(`Peer: 0x${peerBigInt.toString(16).padStart(64, '0')}\n`)

    // ===== Step 1: Set Peer =====
    console.log('Step 1: Setting peer...')
    const peerMd = mdSetPeerNew(dstChain.eid, peerBigInt)
    const peerBody = beginCell()
        .storeUint(OPS.SET_PEER, 32)
        .storeUint(0, 64)
        .storeCoins(0n)
        .storeRef(peerMd)
        .endCell()
    await sendTx(walletContract, keyPair, adapterAddr, TON_CONSTANTS.txValue, peerBody, `setPeer-${dstChain.shortName}`)

    // ===== Step 2: Set Enforced Options =====
    console.log('\nStep 2: Setting enforced options...')
    console.log(`  Gas: ${gasConfig.lzReceiveGas}, Value: ${gasConfig.lzReceiveValue}`)
    const optionsV1 = mdOptionsV1New(
        BigInt(gasConfig.lzReceiveGas),
        BigInt(gasConfig.lzReceiveValue),
        0n, 0n,
    )
    const optionsMd = mdOptionsExtendedNew(dstChain.eid, 1, optionsV1)
    const optionsBody = beginCell()
        .storeUint(OPS.SET_ENFORCED_OPTIONS, 32)
        .storeUint(0, 64)
        .storeCoins(0n)
        .storeRef(optionsMd)
        .endCell()
    await sendTx(walletContract, keyPair, adapterAddr, TON_CONSTANTS.txValue, optionsBody, `setOpts-${dstChain.shortName}`)

    // ===== Step 3 (Optional): Set EP Config =====
    if (SET_EP_CONFIG) {
        console.log('\nStep 3: Setting EP config (ULN Manager)...')
        const epConfig = setEpConfigNew(ULN_MANAGER, ULN_MANAGER)

        // SEND direction
        const sendPath = lzPathNew(TON_EID, OFT_ADAPTER_HASH, dstChain.eid, peerBigInt)
        const sendConfigCell = lzConfigNew(sendPath, CONTROLLER, OPS.SET_EP_CONFIG_OAPP, epConfig)
        const sendBody = beginCell()
            .storeUint(OPS.SET_LZ_CONFIG, 32).storeUint(0, 64).storeCoins(0n)
            .storeRef(sendConfigCell).endCell()
        await sendTx(walletContract, keyPair, adapterAddr, TON_CONSTANTS.epConfigTxValue, sendBody, `epConfig-send-${dstChain.shortName}`)

        // RECEIVE direction
        const recvPath = lzPathNew(dstChain.eid, peerBigInt, TON_EID, OFT_ADAPTER_HASH)
        const recvConfigCell = lzConfigNew(recvPath, CONTROLLER, OPS.SET_EP_CONFIG_OAPP, epConfig)
        const recvBody = beginCell()
            .storeUint(OPS.SET_LZ_CONFIG, 32).storeUint(0, 64).storeCoins(0n)
            .storeRef(recvConfigCell).endCell()
        await sendTx(walletContract, keyPair, adapterAddr, TON_CONSTANTS.epConfigTxValue, recvBody, `epConfig-recv-${dstChain.shortName}`)
    }

    // ===== Step 4 (Optional): Set Receive ULN Config =====
    if (SET_RECV_CONFIG) {
        console.log('\nStep 4: Setting receive ULN config (DVN)...')
        const dvnList = beginCell().storeUint(LZ_LABS_DVN, 256).endCell()
        const recvUlnConfig = ulnReceiveConfigNew(BigInt(gasConfig.confirmations), dvnList)

        const sendPath = lzPathNew(TON_EID, OFT_ADAPTER_HASH, dstChain.eid, peerBigInt)
        const configCell = lzConfigNew(sendPath, ULN_MANAGER, OPS.SET_OAPP_MSGLIB_RECEIVE_CONFIG, recvUlnConfig)
        const body = beginCell()
            .storeUint(OPS.SET_LZ_CONFIG, 32).storeUint(0, 64).storeCoins(0n)
            .storeRef(configCell).endCell()
        await sendTx(walletContract, keyPair, adapterAddr, TON_CONSTANTS.epConfigTxValue, body, `recvConfig-${dstChain.shortName}`)
    }

    // Summary
    await sleep(2000)
    const finalBalance = await retry(() => walletContract.getBalance(), 'finalBalance')
    console.log(`\n=== TON → ${dstChain.name} wiring complete ===`)
    console.log(`Remaining balance: ${Number(finalBalance) / 1e9} TON`)
}

function resolvePeerAddress(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.ARBITRUM_CONTRACT_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_OFT_STORE || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ADAPTER_ADDRESS || ''
        case 'sui': return process.env.SUI_OFT_PACKAGE || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
