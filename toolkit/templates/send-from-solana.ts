/**
 * Send OFT tokens from Solana → any destination.
 * Uses versioned TX with address lookup tables and 600K compute units.
 *
 * Usage:
 *   DST=arb AMOUNT=1 npx tsx toolkit/templates/send-from-solana.ts
 *   DST=stk AMOUNT=5 npx tsx toolkit/templates/send-from-solana.ts
 */

import 'dotenv/config'

const { fetchMint, fetchToken, findAssociatedTokenPda, setComputeUnitPrice, setComputeUnitLimit, fetchAddressLookupTable } = require('@metaplex-foundation/mpl-toolbox')
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults')
const { mplToolbox } = require('@metaplex-foundation/mpl-toolbox')
const { createSignerFromKeypair, signerIdentity, transactionBuilder, publicKey } = require('@metaplex-foundation/umi')
const { fromWeb3JsPublicKey } = require('@metaplex-foundation/umi-web3js-adapters')
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token')
const { PublicKey } = require('@solana/web3.js')
const bs58Module = require('bs58')
const bs58 = bs58Module.default || bs58Module

const { getSolanaKeypair, createSolanaConnectionFactory, getPrioritizationFees } = require('@layerzerolabs/devtools-solana')
const { EndpointId } = require('@layerzerolabs/lz-definitions')
const { oft } = require('@layerzerolabs/oft-v2-solana-sdk')
const { addressToBytes32 } = require('@layerzerolabs/lz-v2-utilities')

import { getChain, getPathwayStatus, SOLANA_CONSTANTS } from '../constants'
import { getLzScanUrl } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const AMOUNT = process.env.AMOUNT || '1'
const SOLANA_EID = EndpointId.SOLANA_V2_MAINNET
const OFT_PROGRAM_ID = process.env.SOLANA_OFT_PROGRAM_ID || ''
const OFT_STORE = process.env.SOLANA_OFT_STORE || ''

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> AMOUNT=<n> npx tsx toolkit/templates/send-from-solana.ts')
        process.exit(1)
    }
    if (!OFT_PROGRAM_ID || !OFT_STORE) throw new Error('Set SOLANA_OFT_PROGRAM_ID and SOLANA_OFT_STORE in .env')

    const dstChain = getChain(DST)
    const recipientAddress = resolveRecipient(DST)
    if (!recipientAddress) throw new Error(`No recipient for ${DST}. Set the appropriate env var.`)

    const pathwayStatus = getPathwayStatus('solana', DST)
    if (pathwayStatus === 'blocked') {
        throw new Error(`Sol → ${dstChain.name} pathway is BLOCKED. Do NOT send tokens.`)
    }

    console.log(`=== Sending ${AMOUNT} ${process.env.TOKEN_SYMBOL || 'OFT'}: Solana → ${dstChain.name} ===\n`)

    const connectionFactory = createSolanaConnectionFactory()
    const connection = await connectionFactory(SOLANA_EID)
    const keypair = await getSolanaKeypair()
    console.log(`Deployer: ${keypair.publicKey.toBase58()}`)

    const umi = createUmi(connection.rpcEndpoint).use(mplToolbox())
    const umiWalletKeyPair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey)
    const umiWalletSigner = createSignerFromKeypair(umi, umiWalletKeyPair)
    umi.use(signerIdentity(umiWalletSigner))

    const programId = publicKey(OFT_PROGRAM_ID)
    const storePda = publicKey(OFT_STORE)

    // Fetch token info
    const oftStoreInfo = await oft.accounts.fetchOFTStore(umi, storePda)
    const mintPk = new PublicKey(oftStoreInfo.tokenMint)
    const escrowPk = new PublicKey(oftStoreInfo.tokenEscrow)

    const tokenProgramId = fromWeb3JsPublicKey(TOKEN_PROGRAM_ID)
    const tokenAccount = findAssociatedTokenPda(umi, {
        mint: fromWeb3JsPublicKey(mintPk),
        owner: umiWalletSigner.publicKey,
        tokenProgramId,
    })

    const balance = (await fetchToken(umi, tokenAccount)).amount
    const decimals = (await fetchMint(umi, fromWeb3JsPublicKey(mintPk))).decimals
    console.log(`Balance: ${Number(balance) / 10 ** decimals} ${process.env.TOKEN_SYMBOL || 'OFT'}`)

    const amountUnits = BigInt(AMOUNT) * BigInt(10 ** decimals)
    const minAmountUnits = (amountUnits * 99n) / 100n
    const recipientBytes32 = Buffer.from(addressToBytes32(recipientAddress))

    console.log(`Recipient: ${recipientAddress}`)
    console.log(`Recipient (bytes32): 0x${recipientBytes32.toString('hex')}`)

    const sendParam = {
        dstEid: dstChain.eid,
        to: recipientBytes32,
        amountLd: amountUnits,
        minAmountLd: minAmountUnits,
        options: undefined,
        composeMsg: undefined,
    }

    // Lookup table
    const lookupTablePk = publicKey(SOLANA_CONSTANTS.defaultLookupTable)
    const lookupTableAddresses = [lookupTablePk]
    const addressLookupTableInput = await fetchAddressLookupTable(umi, lookupTablePk)

    console.log('\nQuoting...')
    const { nativeFee } = await oft.quote(
        umi.rpc,
        {
            payer: umiWalletSigner.publicKey,
            tokenMint: fromWeb3JsPublicKey(mintPk),
            tokenEscrow: fromWeb3JsPublicKey(escrowPk),
        },
        { payInLzToken: false, ...sendParam },
        { oft: programId },
        [],
        lookupTableAddresses,
    )
    console.log(`Native fee: ${Number(nativeFee) / 1e9} SOL`)

    console.log('\nSending...')
    const ix = await oft.send(
        umi.rpc,
        {
            payer: umiWalletSigner,
            tokenMint: fromWeb3JsPublicKey(mintPk),
            tokenEscrow: fromWeb3JsPublicKey(escrowPk),
            tokenSource: tokenAccount[0],
        },
        {
            nativeFee,
            lzTokenFee: 0n,
            ...sendParam,
        },
        { oft: programId, token: tokenProgramId },
    )

    const { averageFeeExcludingZeros } = await getPrioritizationFees(connection)
    const priorityFee = Math.max(Math.round(averageFeeExcludingZeros), 1000)

    const txB = transactionBuilder()
        .add(setComputeUnitPrice(umi, { microLamports: BigInt(priorityFee * SOLANA_CONSTANTS.priorityFeeMultiplier) }))
        .add(setComputeUnitLimit(umi, { units: SOLANA_CONSTANTS.computeUnits }))
        .setAddressLookupTables([addressLookupTableInput])
        .add([ix])

    const { signature } = await txB.sendAndConfirm(umi)
    const txHash = bs58.encode(signature)

    console.log(`\nTX: ${txHash}`)
    console.log(`https://solscan.io/tx/${txHash}?cluster=mainnet-beta`)

    const newBalance = (await fetchToken(umi, tokenAccount)).amount
    console.log(`\nNew balance: ${Number(newBalance) / 10 ** decimals} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`Burned: ${Number(balance - newBalance) / 10 ** decimals} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`\nTrack: ${getLzScanUrl(txHash)}`)
}

function resolveRecipient(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.EVM_DEPLOYER_ADDRESS || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ACCOUNT_ADDRESS || ''
        case 'sui': return process.env.SUI_DEPLOYER_ADDRESS || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
