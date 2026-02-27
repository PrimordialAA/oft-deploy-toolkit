/**
 * Initialize Sui OFT after publishing both packages (token + OFT) via `sui client publish`.
 *
 * Prerequisites:
 *   1. `sui client publish sui/token/ --gas-budget 500000000 --json > sui/token_deploy.json`
 *      → Extract SUI_TOKEN_PACKAGE, SUI_TREASURY_CAP, SUI_COIN_METADATA from output
 *   2. Clone OFT package sources and publish:
 *      `sui client publish sui/oft/ --gas-budget 1000000000 --json > sui/oft_deploy.json`
 *      → Extract SUI_OFT_PACKAGE, SUI_OAPP_OBJECT, SUI_INIT_TICKET from output
 *   3. Set all SUI_* vars in .env
 *
 * This script:
 *   Step 1: initOftMoveCall — links token coin to OFT, transfers TreasuryCap, sets shared_decimals=6
 *   Step 2: registerOAppMoveCall — registers OFT as OApp with LZ EndpointV2
 *
 * Run: npx ts-node scripts/deploy-sui.ts
 */
import 'dotenv/config'
import { SuiClient } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import { SDK } from '@layerzerolabs/lz-sui-sdk-v2'
import { OFT } from '@layerzerolabs/lz-sui-oft-sdk-v2'
import { Stage } from '@layerzerolabs/lz-definitions'

// ============ CONFIG ============

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || ''

// From token package publish (Step 1)
const TOKEN_PACKAGE = process.env.SUI_TOKEN_PACKAGE || ''
const TREASURY_CAP = process.env.SUI_TREASURY_CAP || ''
const COIN_METADATA = process.env.SUI_COIN_METADATA || ''

// From OFT package publish (Step 2)
const OFT_PACKAGE = process.env.SUI_OFT_PACKAGE || ''
const OAPP_OBJECT = process.env.SUI_OAPP_OBJECT || ''
const INIT_TICKET = process.env.SUI_INIT_TICKET || ''

// Coin type from env (set by orchestrator during token publish, or manually)
function getCoinType(): string {
    if (process.env.SUI_COIN_TYPE) return process.env.SUI_COIN_TYPE
    if (!TOKEN_PACKAGE) throw new Error('Set SUI_COIN_TYPE or SUI_TOKEN_PACKAGE in .env')
    throw new Error(
        'Set SUI_COIN_TYPE in .env (format: 0xPACKAGE::module::STRUCT). ' +
        'The orchestrator sets this automatically during token publish.'
    )
}

function getKeypair(): Ed25519Keypair {
    if (!SUI_PRIVATE_KEY) throw new Error('Set SUI_PRIVATE_KEY in .env')
    // Support bech32 (suiprivkey1q...), hex (0x...), and base64 formats
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
    console.log('=== Sui OFT Initialization ===\n')

    // Validate env vars
    if (!TOKEN_PACKAGE || !TREASURY_CAP || !COIN_METADATA) {
        throw new Error(
            'Missing SUI_TOKEN_PACKAGE, SUI_TREASURY_CAP, or SUI_COIN_METADATA in .env.\n' +
            'Run `sui client publish sui/token/ --json` first and extract these values.'
        )
    }
    if (!OFT_PACKAGE || !OAPP_OBJECT || !INIT_TICKET) {
        throw new Error(
            'Missing SUI_OFT_PACKAGE, SUI_OAPP_OBJECT, or SUI_INIT_TICKET in .env.\n' +
            'Run `sui client publish sui/oft/ --json` first and extract these values.'
        )
    }

    const client = new SuiClient({ url: SUI_RPC_URL })
    const keypair = getKeypair()
    const deployer = keypair.toSuiAddress()

    console.log(`Deployer:       ${deployer}`)
    console.log(`Token Package:  ${TOKEN_PACKAGE}`)
    console.log(`OFT Package:    ${OFT_PACKAGE}`)
    console.log(`OApp Object:    ${OAPP_OBJECT}`)
    console.log(`Treasury Cap:   ${TREASURY_CAP}`)
    console.log(`Coin Metadata:  ${COIN_METADATA}`)
    console.log(`Init Ticket:    ${INIT_TICKET}`)
    console.log(`Coin Type:      ${getCoinType()}\n`)

    // Check balance
    const balance = await client.getBalance({ owner: deployer })
    console.log(`SUI balance: ${Number(balance.totalBalance) / 1e9} SUI\n`)

    // Create SDK + OFT instances
    const sdk = new SDK({ client, stage: Stage.MAINNET })
    const oft = new OFT(sdk, OFT_PACKAGE, undefined, getCoinType(), OAPP_OBJECT)

    // ===== Step 1: Initialize OFT =====
    // Links token coin to OFT, transfers TreasuryCap, sets shared_decimals=6
    // Returns: [AdminCap, MigrationCap]
    console.log('Step 1: Initializing OFT (linking coin, transferring TreasuryCap)...')

    const initTx = new Transaction()
    initTx.setSender(deployer)

    const [adminCap, migrationCap] = oft.initOftMoveCall(
        initTx,
        getCoinType(),
        INIT_TICKET,
        OAPP_OBJECT,
        TREASURY_CAP,
        COIN_METADATA,
        6, // shared_decimals = 6 (matches all chains)
    )

    // Transfer AdminCap and MigrationCap to deployer
    initTx.transferObjects([adminCap, migrationCap], deployer)

    const initResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: initTx,
        options: { showEffects: true, showObjectChanges: true },
    })

    console.log(`  TX digest: ${initResult.digest}`)
    console.log(`  Status: ${initResult.effects?.status?.status}`)
    console.log(`  https://suiscan.xyz/mainnet/tx/${initResult.digest}`)

    if (initResult.effects?.status?.status !== 'success') {
        console.error('  ERROR:', JSON.stringify(initResult.effects?.status))
        throw new Error('initOft failed')
    }

    // Wait for RPC to index objects created by initOft before registerOApp queries them
    console.log('\n  Waiting 5s for RPC indexing...')
    await new Promise((r) => setTimeout(r, 5000))

    // Extract created objects
    const createdObjects = initResult.objectChanges?.filter(
        (c: any) => c.type === 'created'
    ) || []

    console.log(`\n  Created objects:`)
    for (const obj of createdObjects) {
        if ('objectType' in obj) {
            console.log(`    ${obj.objectType}: ${obj.objectId}`)
        }
    }

    // Find OFT Object, AdminCap from created objects
    const oftObject = createdObjects.find((o: any) =>
        'objectType' in o && (o as any).objectType?.includes('::oft::OFT')
    )
    const adminCapObj = createdObjects.find((o: any) =>
        'objectType' in o && (o as any).objectType?.includes('AdminCap')
    )

    const OFT_OBJECT_ID = oftObject && 'objectId' in oftObject ? oftObject.objectId : ''
    const ADMIN_CAP_ID = adminCapObj && 'objectId' in adminCapObj ? adminCapObj.objectId : ''

    if (!OFT_OBJECT_ID || !ADMIN_CAP_ID) {
        console.error('  Could not extract OFT Object or AdminCap from initOft TX.')
        console.error('  Check TX manually: ' + initResult.digest)
        console.error('  Created objects:', JSON.stringify(createdObjects.map((o: any) => ({
            type: 'objectType' in o ? o.objectType : 'unknown',
            id: 'objectId' in o ? o.objectId : 'unknown',
        })), null, 2))
        throw new Error(
            `initOft succeeded but could not parse created objects. ` +
            `OFT_OBJECT_ID=${OFT_OBJECT_ID || 'MISSING'}, ADMIN_CAP_ID=${ADMIN_CAP_ID || 'MISSING'}. ` +
            `TX: ${initResult.digest}`
        )
    }

    console.log(`\n  OFT Object:  ${OFT_OBJECT_ID}`)
    console.log(`  Admin Cap:   ${ADMIN_CAP_ID}`)

    // ===== Step 2: Register OApp with Endpoint =====
    console.log('\nStep 2: Registering OApp with LayerZero EndpointV2...')

    // Re-create OFT instance with the now-known OFT object ID
    const oftWithObject = new OFT(sdk, OFT_PACKAGE, OFT_OBJECT_ID, getCoinType(), OAPP_OBJECT, ADMIN_CAP_ID)

    const regTx = new Transaction()
    regTx.setSender(deployer)

    // OFTComposerManager — shared singleton created when OFTCommon was published
    const OFT_COMPOSER_MANAGER = '0xfbece0b75d097c31b9963402a66e49074b0d3a2a64dd0ed666187ca6911a4d12'

    // registerOAppMoveCall handles lzReceiveInfo internally when passed undefined
    await oftWithObject.registerOAppMoveCall(
        regTx,
        getCoinType(),
        OFT_OBJECT_ID,
        OAPP_OBJECT,
        OFT_COMPOSER_MANAGER,
    )

    const regResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: regTx,
        options: { showEffects: true, showObjectChanges: true },
    })

    console.log(`  TX digest: ${regResult.digest}`)
    console.log(`  Status: ${regResult.effects?.status?.status}`)
    console.log(`  https://suiscan.xyz/mainnet/tx/${regResult.digest}`)

    if (regResult.effects?.status?.status !== 'success') {
        console.error('  ERROR:', JSON.stringify(regResult.effects?.status))
        throw new Error('registerOApp failed')
    }

    // ===== Summary =====
    console.log('\n=== Sui OFT Deployment Summary ===')
    console.log(`Token Package (coin):  ${TOKEN_PACKAGE}`)
    console.log(`OFT Package (PEER):    ${OFT_PACKAGE}  ← THIS is the peer address for all remote chains`)
    console.log(`OFT Object:            ${OFT_OBJECT_ID}`)
    console.log(`OApp Object:           ${OAPP_OBJECT}`)
    console.log(`Admin Cap:             ${ADMIN_CAP_ID}`)
    console.log(`Coin Type:             ${getCoinType()}`)

    console.log('\n=== Add to .env ===')
    console.log(`SUI_OFT_OBJECT=${OFT_OBJECT_ID}`)
    console.log(`SUI_ADMIN_CAP=${ADMIN_CAP_ID}`)
    console.log(`[OFT_RESULT] SUI_OFT_OBJECT=${OFT_OBJECT_ID}`)
    console.log(`[OFT_RESULT] SUI_OAPP_OBJECT=${OAPP_OBJECT}`)
    console.log(`[OFT_RESULT] SUI_ADMIN_CAP=${ADMIN_CAP_ID}`)

    console.log('\n=== Next Steps ===')
    console.log('1. Update .env with OFT_OBJECT and ADMIN_CAP above')
    console.log('2. Run wire-sui.ts to configure Sui side (peers, options, DVN)')
    console.log('3. Run wire-arb-to-sui.ts, wire-sol-to-sui.ts, wire-stk-to-sui.ts for remote sides')
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
