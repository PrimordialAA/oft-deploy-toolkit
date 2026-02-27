/**
 * OFT Deployment Toolkit — Cross-Chain Balance Checker
 *
 * Query OFT token balances across all configured chains.
 * Supports: EVM ERC20, Solana SPL, Starknet ERC20, Sui Coin<T>, TON Jetton.
 *
 * Usage:
 *   npx tsx toolkit/balances.ts
 *   CHAINS=arb,sol npx tsx toolkit/balances.ts   (check specific chains only)
 */

import 'dotenv/config'
import { CHAINS, ENV_VARS, getChain, type ChainConfig } from './constants'

// ============ Types ============

export interface BalanceResult {
    chain: string
    balance: bigint
    decimals: number
    formatted: string
    error?: string
}

// ============ Per-Chain Balance Queries ============

async function getEvmBalance(
    rpcUrl: string,
    tokenAddress: string,
    walletAddress: string
): Promise<{ balance: bigint; decimals: number }> {
    const { ethers } = require('ethers')
    const Provider = ethers.JsonRpcProvider || ethers.providers.JsonRpcProvider
    const provider = new Provider(rpcUrl)
    const abi = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ]
    const token = new ethers.Contract(tokenAddress, abi, provider)
    const [balance, decimals] = await Promise.all([
        token.balanceOf(walletAddress),
        token.decimals(),
    ])
    return { balance: BigInt(balance.toString()), decimals: Number(decimals) }
}

async function getSolanaBalance(
    walletAddress?: string
): Promise<{ balance: bigint; decimals: number }> {
    const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults')
    const { mplToolbox, fetchMint, fetchToken, findAssociatedTokenPda } = require('@metaplex-foundation/mpl-toolbox')
    const { createSignerFromKeypair, signerIdentity, publicKey } = require('@metaplex-foundation/umi')
    const { fromWeb3JsPublicKey } = require('@metaplex-foundation/umi-web3js-adapters')
    const { TOKEN_PROGRAM_ID } = require('@solana/spl-token')
    const { getSolanaKeypair, createSolanaConnectionFactory } = require('@layerzerolabs/devtools-solana')
    const { EndpointId } = require('@layerzerolabs/lz-definitions')
    const { oft } = require('@layerzerolabs/oft-v2-solana-sdk')

    const connectionFactory = createSolanaConnectionFactory()
    const connection = await connectionFactory(EndpointId.SOLANA_V2_MAINNET)
    const keypair = await getSolanaKeypair()

    const umi = createUmi(connection.rpcEndpoint).use(mplToolbox())
    const umiWalletKeyPair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey)
    const umiWalletSigner = createSignerFromKeypair(umi, umiWalletKeyPair)
    umi.use(signerIdentity(umiWalletSigner))

    const storePda = publicKey(process.env.SOLANA_OFT_STORE || '')
    const oftStoreInfo = await oft.accounts.fetchOFTStore(umi, storePda)

    const mintPk = fromWeb3JsPublicKey(new (require('@solana/web3.js').PublicKey)(oftStoreInfo.tokenMint))
    const tokenProgramId = fromWeb3JsPublicKey(TOKEN_PROGRAM_ID)
    const owner = walletAddress ? publicKey(walletAddress) : umiWalletSigner.publicKey
    const tokenAccount = findAssociatedTokenPda(umi, { mint: mintPk, owner, tokenProgramId })

    const balance = (await fetchToken(umi, tokenAccount)).amount
    const decimals = (await fetchMint(umi, mintPk)).decimals

    return { balance: BigInt(balance.toString()), decimals }
}

async function getStarknetBalance(): Promise<{ balance: bigint; decimals: number }> {
    const { RpcProvider, Contract, Account, uint256 } = require('starknet')
    const rpcUrl = process.env.STARKNET_RPC_URL
    const erc20 = process.env.STARKNET_ERC20_ADDRESS
    const account = process.env.STARKNET_ACCOUNT_ADDRESS

    if (!rpcUrl || !erc20 || !account) throw new Error('Missing STARKNET env vars')

    const provider = new RpcProvider({ nodeUrl: rpcUrl })
    const classAt = await provider.getClassAt(erc20)
    const token = new Contract({ abi: classAt.abi, address: erc20, providerOrAccount: provider })

    const raw = await token.call('balance_of', [account])
    const balance = typeof raw === 'bigint' ? raw : uint256.uint256ToBN(raw as any)
    return { balance, decimals: 6 }
}

async function getSuiBalance(): Promise<{ balance: bigint; decimals: number }> {
    const { SuiClient } = require('@mysten/sui/client')
    const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519')
    const { fromBase64 } = require('@mysten/sui/utils')

    const rpcUrl = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
    const privateKey = process.env.SUI_PRIVATE_KEY

    if (!privateKey) throw new Error('Missing SUI_PRIVATE_KEY in .env')

    const client = new SuiClient({ url: rpcUrl })

    let keypair: any
    if (privateKey.startsWith('suiprivkey')) {
        keypair = Ed25519Keypair.fromSecretKey(privateKey)
    } else if (privateKey.startsWith('0x')) {
        keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey.slice(2), 'hex'))
    } else {
        keypair = Ed25519Keypair.fromSecretKey(fromBase64(privateKey))
    }

    const coinType = process.env.SUI_COIN_TYPE
    if (!coinType) throw new Error('Set SUI_COIN_TYPE in .env (format: 0xPACKAGE::module::STRUCT)')
    const balance = await client.getBalance({ owner: keypair.toSuiAddress(), coinType })

    return { balance: BigInt(balance.totalBalance), decimals: 6 }
}

async function getTonBalance(): Promise<{ balance: bigint; decimals: number }> {
    // TON Jetton balance requires querying the Jetton Wallet contract
    // For simplicity, use tonapi.io or TonClient to query
    const jettonMaster = process.env.TON_JETTON_MASTER
    const mnemonic = process.env.TON_MNEMONIC

    if (!jettonMaster || !mnemonic) throw new Error('Missing TON env vars')

    // Use TonClient to get wallet address, then query jetton wallet
    const {
        TonClient,
        WalletContractV4,
        mnemonicToWalletKey,
        Address,
    } = require('../ton/lz-framework/wrappers/classlib')

    const rpcUrl = process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'
    const apiKey = process.env.TON_API_KEY

    const keyPair = await mnemonicToWalletKey(mnemonic.split(' '))
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    const walletAddr = wallet.address.toString()

    // Query via tonapi.io for jetton balance (simpler than raw TonClient)
    try {
        const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(walletAddr)}/jettons/${encodeURIComponent(jettonMaster)}`
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`tonapi returned ${resp.status}`)
        const data = await resp.json()
        return { balance: BigInt(data.balance || '0'), decimals: 6 }
    } catch {
        // Fallback: return 0 with a note
        return { balance: 0n, decimals: 6 }
    }
}

// ============ Main ============

export async function getBalance(chainName: string): Promise<BalanceResult> {
    const chain = getChain(chainName)

    try {
        let result: { balance: bigint; decimals: number }

        switch (chain.chainType) {
            case 'evm': {
                const rpc = process.env[ENV_VARS.arbitrum.rpc] || ''
                const token = process.env[ENV_VARS.arbitrum.contract] || ''
                const wallet = process.env[ENV_VARS.arbitrum.deployer] || ''
                if (!rpc || !token || !wallet) throw new Error('Missing ARB env vars')
                result = await getEvmBalance(rpc, token, wallet)
                break
            }
            case 'solana':
                result = await getSolanaBalance()
                break
            case 'starknet':
                result = await getStarknetBalance()
                break
            case 'sui':
                result = await getSuiBalance()
                break
            case 'ton':
                result = await getTonBalance()
                break
            default:
                throw new Error(`Unsupported chain type: ${chain.chainType}`)
        }

        const formatted = (Number(result.balance) / 10 ** result.decimals).toFixed(
            result.decimals <= 6 ? result.decimals : 6
        )

        return {
            chain: chain.name,
            balance: result.balance,
            decimals: result.decimals,
            formatted,
        }
    } catch (e: any) {
        return {
            chain: chain.name,
            balance: 0n,
            decimals: 0,
            formatted: '???',
            error: e.message?.slice(0, 200),
        }
    }
}

export async function getAllBalances(chainNames?: string[]): Promise<BalanceResult[]> {
    const names = chainNames || Object.keys(CHAINS)
    const results = await Promise.allSettled(names.map((n) => getBalance(n)))

    return results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        return {
            chain: names[i],
            balance: 0n,
            decimals: 0,
            formatted: '???',
            error: r.reason?.message?.slice(0, 200),
        }
    })
}

// ============ CLI Runner ============

if (require.main === module) {
    const chainArg = process.env.CHAINS
    const chains = chainArg ? chainArg.split(',').map((c) => c.trim()) : undefined

    console.log('=== OFT Cross-Chain Balance Check ===\n')

    getAllBalances(chains).then((results) => {
        // Print table
        const maxNameLen = Math.max(...results.map((r) => r.chain.length))

        const tokenSymbol = process.env.TOKEN_SYMBOL || 'OFT'
        let total = 0n
        let totalDecimals = 6

        for (const r of results) {
            const name = r.chain.padEnd(maxNameLen)
            const status = r.error ? `  ERROR: ${r.error}` : ''
            console.log(`  ${name}  ${r.formatted.padStart(14)} ${tokenSymbol}${status}`)
            if (!r.error && r.decimals > 0) {
                // Normalize to shared decimals (6) for total
                const normalized = r.decimals === 6
                    ? r.balance
                    : r.balance / BigInt(10 ** (r.decimals - 6))
                total += normalized
            }
        }

        console.log(`  ${'─'.repeat(maxNameLen + 16)}`)
        console.log(`  ${'Total'.padEnd(maxNameLen)}  ${(Number(total) / 1e6).toFixed(6).padStart(14)} ${tokenSymbol}`)
        console.log()
    }).catch((err) => {
        console.error('Fatal: Balance check failed:', err.message || err)
        process.exit(1)
    })
}
