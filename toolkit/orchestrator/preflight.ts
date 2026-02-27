/**
 * OFT Orchestrator — Deep Preflight Checks
 *
 * Chain-specific invariant checks that run before any on-chain TX.
 * All checks are read-only RPC calls — zero cost, ~2-3s wall time.
 *
 * Catches the expensive failures that the basic preflight (env vars, CLI tools)
 * cannot detect: undeclared class hashes, mismatched keypairs, stale artifacts.
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { PROJECT_ROOT } from './runner'
import { readEnv } from './env'

export interface DeepPreflightResult {
    issues: string[]   // Fatal — must fix before proceeding
    warnings: string[] // Non-fatal — orchestrator will auto-fix or can proceed
}

/**
 * Run all deep preflight checks in parallel.
 * Returns issues (fatal) and warnings (non-fatal).
 */
export async function runDeepPreflight(
    chains: string[],
    env: Record<string, string>
): Promise<DeepPreflightResult> {
    const issues: string[] = []
    const warnings: string[] = []

    const checks: Promise<void>[] = []

    if (chains.includes('starknet')) {
        checks.push(checkStarknetClassHashes(env, issues))
    }
    if (chains.includes('solana')) {
        checks.push(checkSolanaToolchain(env, issues, warnings))
        checks.push(checkSolanaAnchorToml(issues, warnings))
    }
    if (chains.includes('sui')) {
        try {
            checkSuiPublishedToml(warnings)
        } catch (e: any) {
            warnings.push(`sui: Published.toml check failed: ${e.message || e}`)
        }
    }

    // Wallet balance checks (RPC calls, run in parallel)
    if (chains.includes('arbitrum')) {
        checks.push(checkArbBalance(env, issues, warnings))
    }
    if (chains.includes('starknet')) {
        checks.push(checkStarknetBalance(env, issues, warnings))
    }
    if (chains.includes('ton')) {
        checks.push(checkTonBalance(env, issues, warnings))
    }

    // Run all async checks in parallel — don't let one failure skip others
    const results = await Promise.allSettled(checks)
    for (const result of results) {
        if (result.status === 'rejected') {
            warnings.push(`Preflight check error: ${result.reason?.message || result.reason}`)
        }
    }

    return { issues, warnings }
}

// ============ Starknet: Class Hash Validation (Bug #1) ============

async function checkStarknetClassHashes(
    env: Record<string, string>,
    issues: string[]
): Promise<void> {
    const rpcUrl = env.STARKNET_RPC_URL || env.RPC_STARKNET
    if (!rpcUrl) return // Will be caught by basic preflight

    const accountClassHash = env.STARKNET_ACCOUNT_CLASS_HASH || '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'
    const erc20ClassHash = env.STARKNET_OFT_ERC20_CLASS_HASH || '0x01bea3900ebe975f332083d441cac55f807cf5de7b1aa0b7ccbda1de53268500'
    const adapterClassHash = env.STARKNET_OFT_ADAPTER_CLASS_HASH || '0x07c02E3797d2c7B848FA94820FfB335617820d2c44D82d6B8Cf71c71fbE7dd6E'

    const hashes = [
        ['Account', accountClassHash],
        ['ERC20', erc20ClassHash],
        ['Adapter', adapterClassHash],
    ] as const

    for (const [name, classHash] of hashes) {
        try {
            const resp = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'starknet_getClass',
                    params: { class_hash: classHash, block_id: 'latest' },
                    id: 1,
                }),
            })
            const data = await resp.json() as any
            if (data.error) {
                issues.push(
                    `starknet: ${name} class hash ${classHash.slice(0, 20)}... is NOT DECLARED on mainnet. ` +
                    `Deploying would create an unreachable address and lose funds.`
                )
            } else {
                console.log(`  starknet: ${name} class hash OK`)
            }
        } catch (e: any) {
            issues.push(`starknet: Could not verify ${name} class hash — RPC error: ${e.message}`)
        }
    }
}

// ============ Solana: Toolchain + Tilde Expansion (Bug #2) ============

async function checkSolanaToolchain(
    env: Record<string, string>,
    issues: string[],
    warnings: string[]
): Promise<void> {
    // Check for literal ~ in EXTRA_PATH
    const extraPath = env.EXTRA_PATH || ''
    if (extraPath.includes('~')) {
        warnings.push(
            `solana: EXTRA_PATH contains literal '~' (${extraPath}). ` +
            `Node.js spawn() does not expand tilde. ` +
            `The orchestrator now auto-expands this, but consider using the full path.`
        )
    }

    // Build the expanded PATH as runner.ts would
    const home = process.env.HOME || ''
    const expandedExtra = extraPath.replace(/~/g, home)
    const testPath = expandedExtra ? `${expandedExtra}:${process.env.PATH || ''}` : process.env.PATH || ''

    // Verify anchor, cargo-build-sbf, and solana-keygen are callable
    for (const tool of ['anchor', 'cargo-build-sbf', 'solana-keygen']) {
        try {
            execSync(`which ${tool}`, {
                env: { ...process.env, PATH: testPath },
                timeout: 5_000,
                stdio: 'pipe',
            })
            console.log(`  solana: ${tool} found on PATH`)
        } catch {
            issues.push(
                `solana: '${tool}' not found on PATH (including EXTRA_PATH=${extraPath}). ` +
                `Ensure it's installed and EXTRA_PATH points to the correct directory.`
            )
        }
    }
}

// ============ Solana: Anchor.toml Program ID Match (Bug #3) ============

async function checkSolanaAnchorToml(
    issues: string[],
    warnings: string[]
): Promise<void> {
    const anchorTomlPath = path.resolve(PROJECT_ROOT, 'Anchor.toml')
    const keypairPath = path.resolve(PROJECT_ROOT, 'target/deploy/oft-keypair.json')

    if (!fs.existsSync(anchorTomlPath)) {
        warnings.push('solana: Anchor.toml not found (will be needed for anchor build)')
        return
    }
    if (!fs.existsSync(keypairPath)) {
        warnings.push('solana: target/deploy/oft-keypair.json not found (will be created by anchor build)')
        return
    }

    // Read Anchor.toml program ID
    const tomlContent = fs.readFileSync(anchorTomlPath, 'utf-8')
    const match = tomlContent.match(/\[programs\.mainnet\]\s*\n\s*oft\s*=\s*"(\w+)"/)
    if (!match) {
        warnings.push('solana: Could not parse program ID from Anchor.toml [programs.mainnet]')
        return
    }
    const tomlProgramId = match[1]

    // Derive program ID from keypair using solana-keygen
    try {
        const home = process.env.HOME || ''
        const extraPath = (readEnv().EXTRA_PATH || '').replace(/~/g, home)
        const testPath = extraPath ? `${extraPath}:${process.env.PATH || ''}` : process.env.PATH || ''

        const result = execSync(`solana-keygen pubkey ${keypairPath}`, {
            env: { ...process.env, PATH: testPath },
            timeout: 5_000,
            stdio: 'pipe',
        })
        const keypairProgramId = result.toString().trim()

        if (tomlProgramId !== keypairProgramId) {
            warnings.push(
                `solana: Anchor.toml program ID (${tomlProgramId}) does NOT match ` +
                `oft-keypair.json (${keypairProgramId}). Orchestrator will auto-fix before build.`
            )
        } else {
            console.log(`  solana: Anchor.toml program ID matches keypair`)
        }
    } catch (e: any) {
        warnings.push(`solana: Could not derive keypair program ID: ${e.message}`)
    }
}

// ============ Sui: Stale Published.toml (Bug #5) ============

function checkSuiPublishedToml(warnings: string[]): void {
    const paths = ['sui/token/Published.toml', 'sui/oft/Published.toml']
    for (const p of paths) {
        const full = path.resolve(PROJECT_ROOT, p)
        if (fs.existsSync(full)) {
            warnings.push(
                `sui: Stale ${p} found. Orchestrator will auto-delete before publish.`
            )
        }
    }
}

// ============ Wallet Balance Checks ============

async function checkArbBalance(
    env: Record<string, string>,
    issues: string[],
    warnings: string[]
): Promise<void> {
    const rpcUrl = env.RPC_URL_ARBITRUM
    const privateKey = env.PRIVATE_KEY
    if (!rpcUrl || !privateKey) return

    try {
        // Derive address from private key using eth_getBalance
        // Use ethers v5 API (this project pins ethers@5.x)
        const { ethers } = await import('ethers')
        const wallet = new ethers.Wallet(privateKey)
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
        const balance = await provider.getBalance(wallet.address)
        const ethBalance = Number(ethers.utils.formatEther(balance))

        if (ethBalance < 0.01) {
            issues.push(
                `arbitrum: Insufficient ETH balance: ${ethBalance.toFixed(4)} ETH (need >= 0.01 ETH)`
            )
        } else {
            console.log(`  arbitrum: ETH balance OK (${ethBalance.toFixed(4)} ETH)`)
        }
    } catch (e: any) {
        warnings.push(`arbitrum: Could not check ETH balance: ${e.message}`)
    }
}

async function checkStarknetBalance(
    env: Record<string, string>,
    issues: string[],
    warnings: string[]
): Promise<void> {
    const rpcUrl = env.STARKNET_RPC_URL || env.RPC_STARKNET
    const accountAddress = env.STARKNET_ACCOUNT_ADDRESS
    if (!rpcUrl || !accountAddress) return

    // Check if account is deployed first
    try {
        const resp = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'starknet_getClassAt',
                params: { contract_address: accountAddress, block_id: 'latest' },
                id: 1,
            }),
        })
        const data = await resp.json() as any
        if (data.error) {
            // Account not deployed yet — can't check balance, will be deployed during deploy step
            console.log(`  starknet: Account not yet deployed (will be deployed during deployment)`)
            return
        }
    } catch {
        return
    }

    // Account is deployed — check STRK balance
    const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
    try {
        const resp = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'starknet_call',
                params: {
                    request: {
                        contract_address: STRK_TOKEN,
                        entry_point_selector: '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e', // balanceOf
                        calldata: [accountAddress],
                    },
                    block_id: 'latest',
                },
                id: 1,
            }),
        })
        const data = await resp.json() as any
        if (data.result && data.result.length >= 1) {
            const balanceRaw = BigInt(data.result[0])
            const strkBalance = Number(balanceRaw) / 1e18
            if (strkBalance < 0.5) {
                issues.push(
                    `starknet: Insufficient STRK balance: ${strkBalance.toFixed(4)} STRK (need >= 0.5 STRK)`
                )
            } else {
                console.log(`  starknet: STRK balance OK (${strkBalance.toFixed(4)} STRK)`)
            }
        }
    } catch (e: any) {
        warnings.push(`starknet: Could not check STRK balance: ${e.message}`)
    }
}

async function checkTonBalance(
    env: Record<string, string>,
    issues: string[],
    warnings: string[]
): Promise<void> {
    const mnemonic = env.TON_MNEMONIC
    if (!mnemonic) return

    try {
        // Use TON API to check balance — derive wallet address from mnemonic
        const apiKey = env.TON_API_KEY || ''
        const rpcUrl = env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC'

        // We need tonweb or @ton/ton to derive address from mnemonic.
        // Use the toncenter API directly if we have the deployer address cached.
        const deployerAddress = env.TON_DEPLOYER_ADDRESS
        if (!deployerAddress) {
            warnings.push('ton: Cannot check balance without TON_DEPLOYER_ADDRESS in .env')
            return
        }

        const baseUrl = rpcUrl.replace('/jsonRPC', '')
        const url = `${baseUrl}/getAddressBalance?address=${deployerAddress}${apiKey ? `&api_key=${apiKey}` : ''}`
        const resp = await fetch(url)
        const data = await resp.json() as any
        if (data.ok && data.result) {
            const tonBalance = Number(data.result) / 1e9
            if (tonBalance < 3) {
                issues.push(
                    `ton: Insufficient TON balance: ${tonBalance.toFixed(2)} TON (need >= 3 TON)`
                )
            } else {
                console.log(`  ton: Balance OK (${tonBalance.toFixed(2)} TON)`)
            }
        }
    } catch (e: any) {
        warnings.push(`ton: Could not check balance: ${e.message}`)
    }
}
