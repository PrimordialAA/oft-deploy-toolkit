/**
 * Register Sui OFT as OApp with LZ EndpointV2.
 * Run this AFTER initOft has succeeded but registerOApp was skipped/failed.
 *
 * Run: npx tsx scripts/register-sui-oapp.ts
 */
import 'dotenv/config'
import { SuiClient } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import { SDK } from '@layerzerolabs/lz-sui-sdk-v2'
import { OFT } from '@layerzerolabs/lz-sui-oft-sdk-v2'
import { Stage } from '@layerzerolabs/lz-definitions'

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || ''

const OFT_PACKAGE = process.env.SUI_OFT_PACKAGE || ''
const OFT_OBJECT_ID = process.env.SUI_OFT_OBJECT || ''
const OAPP_OBJECT = process.env.SUI_OAPP_OBJECT || ''
const ADMIN_CAP_ID = process.env.SUI_ADMIN_CAP || ''
const COIN_TYPE = process.env.SUI_COIN_TYPE || ''

function getKeypair(): Ed25519Keypair {
    if (!SUI_PRIVATE_KEY) throw new Error('Set SUI_PRIVATE_KEY in .env')
    if (SUI_PRIVATE_KEY.startsWith('suiprivkey')) {
        return Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY)
    }
    if (SUI_PRIVATE_KEY.startsWith('0x')) {
        const bytes = Buffer.from(SUI_PRIVATE_KEY.slice(2), 'hex')
        return Ed25519Keypair.fromSecretKey(bytes)
    }
    return Ed25519Keypair.fromSecretKey(fromBase64(SUI_PRIVATE_KEY))
}

async function main() {
    console.log('=== Sui OApp Registration ===\n')

    if (!OFT_PACKAGE || !OFT_OBJECT_ID || !OAPP_OBJECT || !ADMIN_CAP_ID || !COIN_TYPE) {
        throw new Error(
            'Missing required env vars: SUI_OFT_PACKAGE, SUI_OFT_OBJECT, SUI_OAPP_OBJECT, SUI_ADMIN_CAP, SUI_COIN_TYPE'
        )
    }

    const client = new SuiClient({ url: SUI_RPC_URL })
    const keypair = getKeypair()
    const deployer = keypair.toSuiAddress()

    console.log(`Deployer:    ${deployer}`)
    console.log(`OFT Package: ${OFT_PACKAGE}`)
    console.log(`OFT Object:  ${OFT_OBJECT_ID}`)
    console.log(`OApp Object: ${OAPP_OBJECT}`)
    console.log(`Admin Cap:   ${ADMIN_CAP_ID}`)
    console.log(`Coin Type:   ${COIN_TYPE}`)

    const sdk = new SDK({ client, stage: Stage.MAINNET })
    const oft = new OFT(sdk, OFT_PACKAGE, OFT_OBJECT_ID, COIN_TYPE, OAPP_OBJECT, ADMIN_CAP_ID)

    const regTx = new Transaction()
    regTx.setSender(deployer)
    regTx.setGasPrice(1000)
    regTx.setGasBudget(100_000_000)

    const OFT_COMPOSER_MANAGER = '0xfbece0b75d097c31b9963402a66e49074b0d3a2a64dd0ed666187ca6911a4d12'

    await oft.registerOAppMoveCall(
        regTx,
        COIN_TYPE,
        OFT_OBJECT_ID,
        OAPP_OBJECT,
        OFT_COMPOSER_MANAGER,
    )

    const regResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: regTx,
        options: { showEffects: true, showObjectChanges: true },
    })

    console.log(`\nTX digest: ${regResult.digest}`)
    console.log(`Status: ${regResult.effects?.status?.status}`)
    console.log(`https://suiscan.xyz/mainnet/tx/${regResult.digest}`)

    if (regResult.effects?.status?.status !== 'success') {
        console.error('ERROR:', JSON.stringify(regResult.effects?.status))
        throw new Error('registerOApp failed')
    }

    console.log('\n[OFT_RESULT] SUI_OAPP_REGISTERED=true')
}

main().catch((err) => {
    console.error('FATAL:', err)
    process.exit(1)
})
