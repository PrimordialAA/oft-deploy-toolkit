/**
 * Wrapper script to run lz:oft:solana:create non-interactively.
 * Usage: npx hardhat run scripts/create-oft-solana.ts
 *
 * Patches the prompts library to auto-accept all confirmations before
 * invoking the task.
 */
const prompts = require('prompts')

// Inject auto-accept for all prompts
prompts.inject([true, true, true, true, true])

async function main() {
    const tokenName = process.env.TOKEN_NAME
    const tokenSymbol = process.env.TOKEN_SYMBOL
    if (!tokenName || !tokenSymbol) {
        throw new Error(
            'Missing TOKEN_NAME or TOKEN_SYMBOL in .env. ' +
            'Set these before deploying (e.g., TOKEN_NAME=MyToken TOKEN_SYMBOL=MTK).'
        )
    }

    const hre = require('hardhat')
    await hre.run('lz:oft:solana:create', {
        eid: '30168',
        programId: process.env.SOLANA_OFT_PROGRAM_ID || '',
        name: tokenName,
        symbol: tokenSymbol,
        onlyOftStore: true,
        ci: true,
        localDecimals: 9,
        sharedDecimals: 6,
        sellerFeeBasisPoints: 0,
        tokenMetadataIsMutable: true,
        uri: '',
        computeUnitPriceScaleFactor: 4,
    })
}

main().catch((err: any) => {
    console.error(err)
    process.exit(1)
})
