/**
 * Deploy OFT Adapter (OApp) to TON mainnet.
 *
 * The OFT Adapter is a FunC++ OApp that bridges tokens via LayerZero.
 * Deploys with proper classlib storage and sends INITIALIZE in the deploy message.
 *
 * Prerequisites:
 * - Jetton Master deployed (TON_JETTON_MASTER set in .env)
 * - Endpoint + Channel + OftAdapter BOCs built
 *
 * Run: cd ton/lz-framework && npx tsx ../../scripts/deploy-ton-adapter.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

// Import ALL @ton/* types from classlib to avoid dual-module Cell instanceof issues
import {
    Address,
    beginCell,
    Cell,
    toNano,
    contractAddress,
    mnemonicToWalletKey,
    TonClient,
    WalletContractV4,
    internal,
    oftAdapterNew,
} from '../ton/lz-framework/wrappers/classlib'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const TON_MNEMONIC = process.env.TON_MNEMONIC || ''
const TON_RPC_URL = process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'
const TON_API_KEY = process.env.TON_API_KEY || ''
const TON_JETTON_MASTER = process.env.TON_JETTON_MASTER || ''

// LZ Controller on TON mainnet
const CONTROLLER_ADDRESS = BigInt(
    '0x1eb2bbea3d8c0d42ff7fd60f0264c866c934bbff727526ca759e7374cae0c166'
)
const TON_EID = 30343

// FunC CRC32 opcodes
const OP_INITIALIZE = 0xf65ce988 // CRC32("BaseInterface::OP::INITIALIZE")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function retry<T>(fn: () => Promise<T>, label: string, maxRetries = 5, baseDelay = 2000): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn()
        } catch (err: any) {
            const isRateLimit = err?.response?.status === 429 || err?.message?.includes('429')
            if (isRateLimit && i < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, i)
                console.log(`  [${label}] Rate limited, retrying in ${delay / 1000}s... (${i + 1}/${maxRetries})`)
                await sleep(delay)
            } else {
                throw err
            }
        }
    }
    throw new Error(`${label}: max retries exceeded`)
}

function loadBoc(buildDir: string, name: string): Cell {
    const compiled = JSON.parse(
        fs.readFileSync(path.join(buildDir, `${name}.compiled.json`), 'utf-8')
    )
    return Cell.fromBoc(Buffer.from(compiled.hex, 'hex'))[0]
}

async function main() {
    if (!TON_MNEMONIC) throw new Error('Set TON_MNEMONIC in .env')
    if (!TON_JETTON_MASTER) throw new Error('Set TON_JETTON_MASTER in .env (deploy Jetton first)')

    console.log('=== Deploying OFT Adapter to TON Mainnet ===\n')

    // 1. Set up wallet
    const mnemonic = TON_MNEMONIC.split(' ')
    const keyPair = await mnemonicToWalletKey(mnemonic)
    const wallet = WalletContractV4.create({
        publicKey: keyPair.publicKey,
        workchain: 0,
    })

    const client = new TonClient({
        endpoint: TON_RPC_URL,
        apiKey: TON_API_KEY || undefined,
    })
    const walletContract = client.open(wallet)
    const walletAddress = wallet.address
    const ownerHash = BigInt('0x' + walletAddress.hash.toString('hex'))
    console.log(`Deployer: ${walletAddress.toString()}`)
    console.log(`Owner hash: 0x${ownerHash.toString(16)}`)

    const balance = await retry(() => walletContract.getBalance(), 'getBalance')
    console.log(`Balance: ${Number(balance) / 1e9} TON`)
    if (balance < toNano('2')) {
        throw new Error('Need at least 2 TON for adapter deployment.')
    }

    // 2. Load compiled contracts
    const buildDir = path.resolve(__dirname, '../ton/lz-framework/build')
    const adapterCode = loadBoc(buildDir, 'OftAdapter')
    const endpointCode = loadBoc(buildDir, 'Endpoint')
    const channelCode = loadBoc(buildDir, 'Channel')

    console.log(`\nAdapter code hash: ${adapterCode.hash().toString('hex').slice(0, 16)}...`)
    console.log(`Endpoint code hash: ${endpointCode.hash().toString('hex').slice(0, 16)}...`)
    console.log(`Channel code hash: ${channelCode.hash().toString('hex').slice(0, 16)}...`)

    // 3. Parse Jetton Master address
    const jettonMasterAddr = Address.parse(TON_JETTON_MASTER)
    const jettonMasterHash = BigInt('0x' + jettonMasterAddr.hash.toString('hex'))
    console.log(`\nJetton Master: ${TON_JETTON_MASTER}`)
    console.log(`Jetton hash: 0x${jettonMasterHash.toString(16)}`)
    console.log(`Controller: 0x${CONTROLLER_ADDRESS.toString(16)}`)
    console.log(`EID: ${TON_EID}`)

    // 4. Build initial classlib storage
    // This replicates OftAdapter::New() from FunC exactly
    console.log('\nBuilding classlib storage...')
    const initialStorage = oftAdapterNew(
        ownerHash,
        CONTROLLER_ADDRESS,
        TON_EID,
        jettonMasterHash,
        endpointCode,
        channelCode
    )
    console.log(`Storage cell: ${initialStorage.bits.length} bits, ${initialStorage.refs.length} refs`)
    console.log(`Storage hash: ${initialStorage.hash().toString('hex').slice(0, 16)}...`)

    // 5. Compute deploy address
    const stateInit = { code: adapterCode, data: initialStorage }
    const adapterAddress = contractAddress(0, stateInit)
    console.log(`\nOFT Adapter address: ${adapterAddress.toString()}`)
    console.log(`OFT Adapter (raw): 0:${adapterAddress.hash.toString('hex')}`)

    // 6. Check if already deployed
    await sleep(1500)
    const contractState = await retry(
        () => client.getContractState(adapterAddress),
        'getContractState'
    )
    if (contractState.state === 'active') {
        console.log('\nAdapter already deployed!')
        console.log(`View: https://tonscan.org/address/${adapterAddress.toString()}`)
        return
    }

    // 7. Build INITIALIZE message body
    // Format: [32-bit opcode][64-bit queryId][varint coins donationNanos]
    // This combines deployment + initialization in one TX
    const initBody = beginCell()
        .storeUint(OP_INITIALIZE, 32)   // opcode
        .storeUint(0, 64)               // queryId
        .storeCoins(0n)                  // donationNanos
        .endCell()

    // 8. Deploy + Initialize
    console.log('\nDeploying OFT Adapter (with INITIALIZE)...')
    await sleep(1500)
    const seqno = await retry(() => walletContract.getSeqno(), 'getSeqno')
    await sleep(1500)
    await retry(
        () =>
            walletContract.sendTransfer({
                secretKey: keyPair.secretKey,
                seqno,
                messages: [
                    internal({
                        to: adapterAddress,
                        value: toNano('0.5'),
                        init: stateInit,
                        body: initBody,
                    }),
                ],
            }),
        'sendTransfer'
    )

    console.log(`Deploy TX sent (seqno: ${seqno})`)
    console.log('Waiting for confirmation...')

    // 9. Wait for deployment
    let attempts = 0
    while (attempts < 40) {
        await sleep(3000)
        try {
            const state = await client.getContractState(adapterAddress)
            if (state.state === 'active') {
                console.log('\n=== OFT Adapter deployed + initialized! ===')
                console.log(`Address: ${adapterAddress.toString()}`)
                console.log(`Raw: 0:${adapterAddress.hash.toString('hex')}`)
                console.log(`View: https://tonscan.org/address/${adapterAddress.toString()}`)

                console.log('\nAdd to .env:')
                console.log(`TON_OFT_ADAPTER=${adapterAddress.toString()}`)
                console.log(`[OFT_RESULT] TON_OFT_ADAPTER=${adapterAddress.toString()}`)
                console.log(`[OFT_RESULT] TON_OFT_ADAPTER_HASH=0x${adapterAddress.hash.toString('hex')}`)

                console.log('\n=== NEXT STEPS ===')
                console.log('1. Transfer Jetton Master admin to adapter')
                console.log('2. Set peers and enforced options (wire-ton.ts)')
                console.log('3. Wire remote chains to TON')
                return
            }
        } catch (err: any) {
            if (err?.response?.status === 429) {
                await sleep(3000)
            }
        }
        attempts++
        process.stdout.write('.')
    }

    console.log('\nDeployment not confirmed after 120s. Check manually.')
    console.log(`Expected address: ${adapterAddress.toString()}`)
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
