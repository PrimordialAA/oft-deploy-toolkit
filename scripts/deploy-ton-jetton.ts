/**
 * Deploy Jetton Master to TON mainnet.
 *
 * Deploys a standard TEP-74 Jetton with admin = deployer.
 * Admin will be transferred to OFT Adapter after adapter deployment.
 *
 * Run: cd ton/lz-framework && npx tsx ../../scripts/deploy-ton-jetton.ts
 */
import { mnemonicToWalletKey } from '@ton/crypto'
import { TonClient, WalletContractV4, internal } from '@ton/ton'
import { Address, beginCell, Cell, contractAddress, toNano } from '@ton/core'
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const TON_MNEMONIC = process.env.TON_MNEMONIC || ''
const TON_RPC_URL = process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'
const TON_API_KEY = process.env.TON_API_KEY || ''

/** Sleep for ms milliseconds */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Retry an async function with exponential backoff */
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

async function main() {
    if (!TON_MNEMONIC) {
        throw new Error('Set TON_MNEMONIC in .env')
    }

    const tokenName = process.env.TOKEN_NAME
    const tokenSymbol = process.env.TOKEN_SYMBOL
    if (!tokenName || !tokenSymbol) {
        throw new Error(
            'Missing TOKEN_NAME or TOKEN_SYMBOL in .env. ' +
            'Set these before deploying (e.g., TOKEN_NAME=MyToken TOKEN_SYMBOL=MTK).'
        )
    }

    console.log(`=== Deploying ${tokenSymbol} Jetton Master to TON Mainnet ===\n`)

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
    console.log(`Deployer wallet: ${walletAddress.toString()}`)

    const balance = await retry(() => walletContract.getBalance(), 'getBalance')
    console.log(`Balance: ${Number(balance) / 1e9} TON`)
    if (balance < toNano('1')) {
        throw new Error('Insufficient TON balance. Need at least 1 TON.')
    }

    // 2. Load compiled contracts
    const buildDir = path.resolve(__dirname, '../ton/lz-framework/build')
    const minterCompiled = JSON.parse(
        fs.readFileSync(path.join(buildDir, 'ItoftMinter.compiled.json'), 'utf-8')
    )
    const walletCompiled = JSON.parse(
        fs.readFileSync(path.join(buildDir, 'ItoftWallet.compiled.json'), 'utf-8')
    )

    const minterCode = Cell.fromBoc(Buffer.from(minterCompiled.hex, 'hex'))[0]
    const walletCode = Cell.fromBoc(Buffer.from(walletCompiled.hex, 'hex'))[0]

    console.log(`Minter code hash: ${minterCode.hash().toString('hex')}`)
    console.log(`Wallet code hash: ${walletCode.hash().toString('hex')}`)

    // 3. Build metadata content (off-chain format)
    // TOKEN_METADATA_URI: full URL to JSON metadata; if not set, uses placeholder
    const metadataUri = process.env.TOKEN_METADATA_URI ||
        `https://example.com/metadata/${tokenName.toLowerCase()}.json`
    console.log(`Metadata URI: ${metadataUri}`)
    const content = beginCell()
        .storeUint(0x01, 8) // off-chain content tag
        .storeStringTail(metadataUri)
        .endCell()

    // 4. Build initial data cell
    // storage#_ total_supply:Coins admin_address:MsgAddress content:^Cell jetton_wallet_code:^Cell
    const initialData = beginCell()
        .storeCoins(0n) // total_supply = 0 (adapter will mint)
        .storeAddress(walletAddress) // admin = deployer (will transfer to adapter later)
        .storeRef(content)
        .storeRef(walletCode)
        .endCell()

    // 5. Compute deploy address
    const stateInit = {
        code: minterCode,
        data: initialData,
    }
    const jettonMasterAddress = contractAddress(0, stateInit)
    console.log(`\nJetton Master address: ${jettonMasterAddress.toString()}`)
    console.log(`Jetton Master address (raw): 0:${jettonMasterAddress.hash.toString('hex')}`)

    // 6. Check if already deployed
    await sleep(1500) // Rate limit buffer
    const contractState = await retry(
        () => client.getContractState(jettonMasterAddress),
        'getContractState'
    )
    if (contractState.state === 'active') {
        console.log('\nJetton Master already deployed!')
        console.log(`View on tonscan: https://tonscan.org/address/${jettonMasterAddress.toString()}`)
        return
    }

    // 7. Deploy
    console.log('\nDeploying Jetton Master...')
    await sleep(1500) // Rate limit buffer
    const seqno = await retry(() => walletContract.getSeqno(), 'getSeqno')
    await sleep(1500)
    await retry(
        () =>
            walletContract.sendTransfer({
                secretKey: keyPair.secretKey,
                seqno,
                messages: [
                    internal({
                        to: jettonMasterAddress,
                        value: toNano('0.25'), // Deploy gas
                        init: stateInit,
                        body: beginCell().endCell(),
                    }),
                ],
            }),
        'sendTransfer'
    )

    console.log(`Deploy TX sent (seqno: ${seqno})`)
    console.log('Waiting for confirmation...')

    // 8. Wait for deployment
    let attempts = 0
    while (attempts < 40) {
        await sleep(3000) // Poll every 3s (within rate limit)
        try {
            const state = await client.getContractState(jettonMasterAddress)
            if (state.state === 'active') {
                console.log('\n=== Jetton Master deployed successfully! ===')
                console.log(`Address: ${jettonMasterAddress.toString()}`)
                console.log(`Raw: 0:${jettonMasterAddress.hash.toString('hex')}`)
                console.log(`View: https://tonscan.org/address/${jettonMasterAddress.toString()}`)

                console.log('\nAdd to .env:')
                console.log(`TON_JETTON_MASTER=${jettonMasterAddress.toString()}`)
                console.log(`[OFT_RESULT] TON_JETTON_MASTER=${jettonMasterAddress.toString()}`)
                return
            }
        } catch (err: any) {
            // Ignore rate limit errors during polling
            if (err?.response?.status === 429) {
                await sleep(3000) // Extra delay on rate limit
            }
        }
        attempts++
        process.stdout.write('.')
    }

    console.log('\nDeployment not confirmed after 120s. Check manually.')
    console.log(`Expected address: ${jettonMasterAddress.toString()}`)
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
