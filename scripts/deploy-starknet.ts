/**
 * Deploy OFT on Starknet: ERC20MintBurnUpgradeable + OFTMintBurnAdapter.
 * Uses pre-deployed class hashes (declared on Starknet mainnet by LayerZero).
 * No Scarb/Cairo compilation needed.
 *
 * Prerequisites:
 *   - Set STARKNET_PRIVATE_KEY, STARKNET_ACCOUNT_ADDRESS, STARKNET_RPC_URL in .env
 *   - Starknet account funded with STRK for gas (~0.1 STRK)
 *
 * Run: npx ts-node scripts/deploy-starknet.ts
 */
import 'dotenv/config'
import { Account, RpcProvider, CallData, Contract, hash, uint256, num, stark, ec } from 'starknet'

// ============ CONFIG ============

// Starknet LayerZero EndpointV2
const STARKNET_ENDPOINT = process.env.STARKNET_LZ_ENDPOINT || '0x524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68'

// STRK token for fee payments
const STRK_TOKEN = process.env.STARKNET_STRK_TOKEN || '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'

// Pre-deployed class hashes from LayerZero (declared on Starknet mainnet)
const ERC20_CLASS_HASH = process.env.STARKNET_OFT_ERC20_CLASS_HASH || '0x01bea3900ebe975f332083d441cac55f807cf5de7b1aa0b7ccbda1de53268500'
const ADAPTER_CLASS_HASH = process.env.STARKNET_OFT_ADAPTER_CLASS_HASH || '0x07c02E3797d2c7B848FA94820FfB335617820d2c44D82d6B8Cf71c71fbE7dd6E'

async function main() {
    console.log('=== Deploying OFT on Starknet ===\n')

    // ===== Setup =====
    const rpcUrl = process.env.STARKNET_RPC_URL || process.env.RPC_STARKNET
    const privateKey = process.env.STARKNET_PRIVATE_KEY
    const accountAddress = process.env.STARKNET_ACCOUNT_ADDRESS

    if (!rpcUrl || !privateKey || !accountAddress) {
        throw new Error(
            'Missing env vars. Set STARKNET_RPC_URL, STARKNET_PRIVATE_KEY, STARKNET_ACCOUNT_ADDRESS in .env'
        )
    }

    const provider = new RpcProvider({ nodeUrl: rpcUrl })
    // cairoVersion must be set explicitly — account may not be deployed yet (auto-detect would fail)
    const account = new Account({ provider, address: accountAddress, signer: privateKey, cairoVersion: '1' })

    console.log(`Deployer: ${account.address}`)
    console.log(`RPC: ${rpcUrl}`)

    // Check chain connectivity
    const chainId = await provider.getChainId()
    console.log(`Chain ID: ${chainId}`)

    // ===== Verify class hashes are declared on mainnet =====
    // This is a zero-cost RPC read that prevents deploying with undeclared class hashes.
    // Deploying with an undeclared class hash creates an unreachable address and loses funds.
    const OZ_ACCOUNT_CLASS_HASH = process.env.STARKNET_ACCOUNT_CLASS_HASH || '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'

    console.log('\nVerifying class hashes on mainnet...')
    for (const [name, classHash] of [
        ['Account', OZ_ACCOUNT_CLASS_HASH],
        ['ERC20', ERC20_CLASS_HASH],
        ['Adapter', ADAPTER_CLASS_HASH],
    ] as const) {
        try {
            await provider.getClass(classHash)
            console.log(`  ${name}: ${classHash.slice(0, 18)}... OK`)
        } catch {
            throw new Error(
                `FATAL: ${name} class hash ${classHash} is NOT DECLARED on Starknet mainnet. ` +
                `Deploying would create an unreachable address and lose funds.`
            )
        }
    }

    // ===== Check if account is deployed, deploy if needed =====
    try {
        await provider.getClassAt(accountAddress)
        console.log('Account: deployed\n')
    } catch {
        console.log('Account: NOT deployed — deploying now...')
        const publicKey = ec.starkCurve.getStarkKey(privateKey)
        try {
            const deployResult = await account.deployAccount({
                classHash: OZ_ACCOUNT_CLASS_HASH,
                constructorCalldata: [publicKey],
                addressSalt: publicKey,
            })
            console.log(`  Deploy TX: ${deployResult.transaction_hash}`)
            await provider.waitForTransaction(deployResult.transaction_hash)
            console.log('  Account deployed!\n')
        } catch (e: any) {
            console.error(`\nAccount deploy error: ${e.message}`)
            // If fee estimation failed, retry with explicit resource bounds
            if (e.message?.includes('Insufficient') || e.message?.includes('fee') || e.message?.includes('transaction data')) {
                console.log('Fee estimation failed — retrying with explicit resource bounds...')
                try {
                    const deployResult = await account.deployAccount({
                        classHash: OZ_ACCOUNT_CLASS_HASH,
                        constructorCalldata: [publicKey],
                        addressSalt: publicKey,
                    }, {
                        resourceBounds: {
                            l1_gas: { max_amount: '0x2710', max_price_per_unit: '0x174876e800' },
                            l2_gas: { max_amount: '0x1000000', max_price_per_unit: '0x174876e800' },
                        }
                    } as any)
                    console.log(`  Deploy TX: ${deployResult.transaction_hash}`)
                    await provider.waitForTransaction(deployResult.transaction_hash)
                    console.log('  Account deployed!\n')
                } catch (e2: any) {
                    console.error(`\nRetry also failed: ${e2.message}`)
                    if (e2.message?.includes('balance') || e2.message?.includes('insufficient')) {
                        console.error(`Account ${accountAddress} needs STRK for deployment gas.`)
                        console.error('Send ~0.01 STRK to this address, then re-run.')
                    }
                    process.exit(1)
                }
            } else if (e.message?.includes('balance')) {
                console.error(`\nAccount ${accountAddress} needs STRK for deployment gas.`)
                console.error('Send ~0.01 STRK to this address, then re-run.')
                process.exit(1)
            } else {
                throw e
            }
        }
    }

    // ===== Discover constructor ABIs =====
    console.log('Fetching class ABIs from chain...')
    const erc20Class = await provider.getClass(ERC20_CLASS_HASH)
    const adapterClass = await provider.getClass(ADAPTER_CLASS_HASH)

    // Log constructor signatures for debugging
    const erc20Ctor = (erc20Class.abi as any[])?.find((e: any) => e.type === 'constructor')
    const adapterCtor = (adapterClass.abi as any[])?.find((e: any) => e.type === 'constructor')
    console.log(
        '  ERC20 constructor params:',
        erc20Ctor?.inputs?.map((i: any) => `${i.name}: ${i.type}`).join(', ') || 'unknown'
    )
    console.log(
        '  Adapter constructor params:',
        adapterCtor?.inputs?.map((i: any) => `${i.name}: ${i.type}`).join(', ') || 'unknown'
    )

    // ===== Step 1: Deploy ERC20MintBurnUpgradeable =====
    const tokenName = process.env.TOKEN_NAME
    const tokenSymbol = process.env.TOKEN_SYMBOL
    if (!tokenName || !tokenSymbol) {
        throw new Error(
            'Missing TOKEN_NAME or TOKEN_SYMBOL in .env. ' +
            'Set these before deploying (e.g., TOKEN_NAME=MyToken TOKEN_SYMBOL=MTK).'
        )
    }

    console.log('\nStep 1: Deploying ERC20MintBurnUpgradeable...')
    console.log(`  name: ${tokenName}`)
    console.log(`  symbol: ${tokenSymbol}`)
    console.log('  initial_supply: 0 (tokens arrive via cross-chain bridge)')
    console.log(`  owner: ${account.address}`)

    // Use class ABI for typed calldata compilation
    // Actual params discovered from chain: name, symbol, decimals, default_admin
    const erc20Cd = new CallData(erc20Class.abi)
    const erc20ConstructorCalldata = erc20Cd.compile('constructor', {
        name: tokenName,
        symbol: tokenSymbol,
        decimals: 6, // Match shared_decimals to avoid dust loss
        default_admin: account.address,
    })

    const erc20Deploy = await account.deployContract({
        classHash: ERC20_CLASS_HASH,
        constructorCalldata: erc20ConstructorCalldata,
        salt: stark.randomAddress(),
    })

    console.log(`  TX hash: ${erc20Deploy.transaction_hash}`)
    console.log('  Waiting for confirmation...')
    await provider.waitForTransaction(erc20Deploy.transaction_hash)

    const erc20Address = erc20Deploy.contract_address!
    console.log(`  ERC20 deployed at: ${erc20Address}`)
    console.log(`  https://starkscan.co/contract/${erc20Address}`)

    // ===== Step 2: Deploy OFTMintBurnAdapter =====
    console.log('\nStep 2: Deploying OFTMintBurnAdapter...')
    console.log(`  token: ${erc20Address}`)
    console.log(`  endpoint: ${STARKNET_ENDPOINT}`)
    console.log(`  strk_token: ${STRK_TOKEN}`)
    console.log('  shared_decimals: 6')

    // Actual params discovered from chain: erc20_token, minter_burner, lz_endpoint, owner, native_token, shared_decimals
    const adapterCd = new CallData(adapterClass.abi)
    const adapterConstructorCalldata = adapterCd.compile('constructor', {
        erc20_token: erc20Address,
        minter_burner: erc20Address, // MUST be ERC20 address — adapter calls permissioned_mint/burn on this contract
        lz_endpoint: STARKNET_ENDPOINT,
        owner: account.address,
        native_token: STRK_TOKEN,
        shared_decimals: 6,
    })

    const adapterDeploy = await account.deployContract({
        classHash: ADAPTER_CLASS_HASH,
        constructorCalldata: adapterConstructorCalldata,
        salt: stark.randomAddress(),
    })

    console.log(`  TX hash: ${adapterDeploy.transaction_hash}`)
    console.log('  Waiting for confirmation...')
    await provider.waitForTransaction(adapterDeploy.transaction_hash)

    const adapterAddress = adapterDeploy.contract_address!
    console.log(`  Adapter deployed at: ${adapterAddress}`)
    console.log(`  https://starkscan.co/contract/${adapterAddress}`)

    // ===== Step 3: Grant MINTER_ROLE + BURNER_ROLE on ERC20 to Adapter =====
    console.log('\nStep 3: Granting MINTER_ROLE + BURNER_ROLE to adapter...')

    // IMPORTANT: The ERC20 uses shortstring encoding for roles, NOT selector encoding.
    // Both encodings must be granted to be safe (Issue #2 in starknet.md).
    const MINTER_ROLE_SELECTOR = hash.getSelectorFromName('MINTER_ROLE')
    const MINTER_ROLE_SHORTSTRING = '0x' + Buffer.from('MINTER_ROLE').toString('hex')
    const BURNER_ROLE_SELECTOR = hash.getSelectorFromName('BURNER_ROLE')
    const BURNER_ROLE_SHORTSTRING = '0x' + Buffer.from('BURNER_ROLE').toString('hex')

    console.log(`  MINTER_ROLE (selector):    ${MINTER_ROLE_SELECTOR}`)
    console.log(`  MINTER_ROLE (shortstring): ${MINTER_ROLE_SHORTSTRING}`)
    console.log(`  BURNER_ROLE (selector):    ${BURNER_ROLE_SELECTOR}`)
    console.log(`  BURNER_ROLE (shortstring): ${BURNER_ROLE_SHORTSTRING}`)

    // Get deployed ERC20 ABI for clean contract interaction
    const erc20ContractClass = await provider.getClassAt(erc20Address)
    const erc20Contract = new Contract({ abi: erc20ContractClass.abi, address: erc20Address, providerOrAccount: account })

    // Grant all 4 role variants in a single multicall
    const grantTx = await account.execute([
        { contractAddress: erc20Address, entrypoint: 'grant_role', calldata: CallData.compile({ role: MINTER_ROLE_SELECTOR, account: adapterAddress }) },
        { contractAddress: erc20Address, entrypoint: 'grant_role', calldata: CallData.compile({ role: MINTER_ROLE_SHORTSTRING, account: adapterAddress }) },
        { contractAddress: erc20Address, entrypoint: 'grant_role', calldata: CallData.compile({ role: BURNER_ROLE_SELECTOR, account: adapterAddress }) },
        { contractAddress: erc20Address, entrypoint: 'grant_role', calldata: CallData.compile({ role: BURNER_ROLE_SHORTSTRING, account: adapterAddress }) },
    ])
    console.log(`  TX hash: ${grantTx.transaction_hash}`)
    await provider.waitForTransaction(grantTx.transaction_hash)
    console.log('  All roles granted!')

    // ===== Step 4: Verify =====
    console.log('\n=== Verification ===')

    try {
        const name = await erc20Contract.call('name')
        const symbol = await erc20Contract.call('symbol')
        console.log(`  Token name: ${name}`)
        console.log(`  Token symbol: ${symbol}`)
    } catch (e: any) {
        console.log(`  Token read: skipped (${e.message?.slice(0, 60)}...)`)
    }

    try {
        const hasRole = await erc20Contract.call('has_role', [MINTER_ROLE_SHORTSTRING, adapterAddress])
        console.log(`  Adapter has MINTER_ROLE: ${hasRole}`)
    } catch (e: any) {
        console.log(`  Role check: skipped (${e.message?.slice(0, 60)}...)`)
    }

    try {
        const adapterContractClass = await provider.getClassAt(adapterAddress)
        const adapterContract = new Contract({ abi: adapterContractClass.abi, address: adapterAddress, providerOrAccount: provider })
        const owner = await adapterContract.call('owner')
        console.log(`  Adapter owner: ${num.toHex(owner as any)}`)
    } catch (e: any) {
        console.log(`  Adapter owner: skipped (${e.message?.slice(0, 60)}...)`)
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60))
    console.log('  DEPLOYMENT COMPLETE')
    console.log('='.repeat(60))
    console.log(`  ERC20 Token:    ${erc20Address}`)
    console.log(`  OFT Adapter:    ${adapterAddress}`)
    console.log(`  Deployer:       ${account.address}`)
    console.log(`  Endpoint:       ${STARKNET_ENDPOINT}`)
    console.log('')
    console.log('  Starkscan:')
    console.log(`    Token:   https://starkscan.co/contract/${erc20Address}`)
    console.log(`    Adapter: https://starkscan.co/contract/${adapterAddress}`)
    console.log('='.repeat(60))

    console.log('\nNext steps:')
    console.log('1. Add to .env:')
    console.log(`   STARKNET_ERC20_ADDRESS=${erc20Address}`)
    console.log(`   STARKNET_ADAPTER_ADDRESS=${adapterAddress}`)
    console.log(`[OFT_RESULT] STARKNET_ERC20_ADDRESS=${erc20Address}`)
    console.log(`[OFT_RESULT] STARKNET_ADAPTER_ADDRESS=${adapterAddress}`)
    console.log('2. Run: npx ts-node scripts/wire-starknet.ts')
    console.log('3. Run: npx hardhat run scripts/wire-arb-to-starknet.ts --network arbitrum')
    console.log('4. Run: npx hardhat run scripts/wire-sol-to-starknet.ts')
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
