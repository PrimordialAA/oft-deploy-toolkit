/**
 * OFT Orchestrator — Deploy all 5 chains
 *
 * Deploys contracts in parallel across Arbitrum, Solana, Starknet, Sui, and TON.
 * Captures addresses via [OFT_RESULT] tags and auto-updates .env.
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { run, checkTool, formatDuration, readJsonOutput, PROJECT_ROOT, type RunResult } from './runner'
import { readEnv, updateEnv } from './env'
import { loadState, saveState, setDeployStatus, type OrchestratorState } from './state'
import { CHAINS, ENV_VARS } from '../constants'
import { runDeepPreflight } from './preflight'

const ALL_CHAINS = ['arbitrum', 'solana', 'starknet', 'sui', 'ton'] as const

interface DeployOptions {
    chains?: string[]
    dryRun?: boolean
}

// ============ Pre-flight Checks ============

interface BalanceCheck {
    command: string
    args: string[]
    parse: (stdout: string) => number
    minBalance: number
    unit: string
}

interface PreflightCheck {
    chain: string
    tools: string[]
    envVars: string[]
    balanceCheck?: BalanceCheck
    buildArtifacts?: string[]  // File paths to check (warning only)
}

const PREFLIGHT: PreflightCheck[] = [
    {
        chain: 'arbitrum',
        tools: [],  // npx is always available
        envVars: ['PRIVATE_KEY', 'RPC_URL_ARBITRUM'],
    },
    {
        chain: 'solana',
        tools: ['solana', 'anchor'],
        envVars: ['SOLANA_PRIVATE_KEY', 'SOLANA_RPC_URL'],
        balanceCheck: {
            command: 'solana',
            args: ['balance', '--output', 'json'],
            parse: (stdout: string) => {
                try {
                    // `solana balance --output json` outputs a number (SOL)
                    return parseFloat(stdout.trim())
                } catch { return 0 }
            },
            minBalance: 5,
            unit: 'SOL',
        },
    },
    {
        chain: 'starknet',
        tools: [],
        // deploy-starknet.ts accepts STARKNET_RPC_URL || RPC_STARKNET, so only require key + account
        envVars: ['STARKNET_PRIVATE_KEY', 'STARKNET_ACCOUNT_ADDRESS'],
        // RPC checked separately below since deploy script accepts either name
    },
    {
        chain: 'sui',
        tools: ['sui'],
        envVars: ['SUI_PRIVATE_KEY'],
        balanceCheck: {
            command: 'sui',
            args: ['client', 'gas', '--json'],
            parse: (stdout: string) => {
                try {
                    // `sui client gas --json` returns array of {gasCoinId, mistBalance, suiBalance}
                    const coins = JSON.parse(stdout.trim())
                    const totalMist = coins.reduce((sum: number, c: any) => sum + (c.mistBalance || 0), 0)
                    return totalMist / 1e9  // MIST → SUI
                } catch { return 0 }
            },
            minBalance: 2,
            unit: 'SUI',
        },
    },
    {
        chain: 'ton',
        tools: [],
        envVars: ['TON_MNEMONIC'],
        buildArtifacts: [
            'ton/lz-framework/build/OftAdapter.compiled.json',
            'ton/lz-framework/build/Endpoint.compiled.json',
            'ton/lz-framework/build/Channel.compiled.json',
            'ton/lz-framework/build/ItoftMinter.compiled.json',
            'ton/lz-framework/build/ItoftWallet.compiled.json',
        ],
    },
]

async function runPreflight(chains: string[]): Promise<string[]> {
    const issues: string[] = []
    const warnings: string[] = []
    const env = readEnv()

    // TOKEN_NAME and TOKEN_SYMBOL are required for all chains
    // Check both .env file and process.env (for CLI overrides)
    if (!env.TOKEN_NAME && !process.env.TOKEN_NAME) {
        issues.push('Missing TOKEN_NAME in .env (e.g., TOKEN_NAME=MyToken)')
    }
    if (!env.TOKEN_SYMBOL && !process.env.TOKEN_SYMBOL) {
        issues.push('Missing TOKEN_SYMBOL in .env (e.g., TOKEN_SYMBOL=MTK)')
    }

    for (const check of PREFLIGHT) {
        if (!chains.includes(check.chain)) continue

        // Check env vars (check both .env file and process.env for CLI overrides)
        for (const key of check.envVars) {
            if (!env[key] && !process.env[key]) {
                issues.push(`${check.chain}: Missing env var ${key}`)
            }
        }

        // Starknet RPC: deploy script accepts STARKNET_RPC_URL || RPC_STARKNET
        if (check.chain === 'starknet'
            && !env.STARKNET_RPC_URL && !env.RPC_STARKNET
            && !process.env.STARKNET_RPC_URL && !process.env.RPC_STARKNET) {
            issues.push('starknet: Missing env var STARKNET_RPC_URL (or RPC_STARKNET)')
        }

        // Check CLI tools
        for (const tool of check.tools) {
            const hasIt = await checkTool(tool)
            if (!hasIt) {
                issues.push(`${check.chain}: CLI tool '${tool}' not found on PATH`)
            }
        }

        // Check wallet balance
        if (check.balanceCheck) {
            const bc = check.balanceCheck
            try {
                const result = await run({
                    command: bc.command,
                    args: bc.args,
                    timeout: 15_000,
                    label: `${check.chain}-balance`,
                })
                if (result.exitCode === 0) {
                    const balance = bc.parse(result.stdout)
                    if (balance < bc.minBalance) {
                        issues.push(
                            `${check.chain}: Insufficient balance: ${balance.toFixed(2)} ${bc.unit} (need ≥${bc.minBalance} ${bc.unit})`
                        )
                    } else {
                        console.log(`  ${check.chain}: Balance OK (${balance.toFixed(2)} ${bc.unit})`)
                    }
                }
            } catch {
                warnings.push(`${check.chain}: Could not check balance (${bc.command} failed)`)
            }
        }

        // Check build artifacts (warning only — build step will create them)
        if (check.buildArtifacts) {
            const missing = check.buildArtifacts.filter(
                (f) => !fs.existsSync(path.resolve(PROJECT_ROOT, f))
            )
            if (missing.length > 0) {
                warnings.push(`${check.chain}: ${missing.length} build artifact(s) missing (will be built)`)
            }
        }
    }

    for (const w of warnings) {
        console.log(`  ⚠ ${w}`)
    }

    return issues
}

// ============ Per-Chain Deploy Functions ============

async function deployArbitrum(state: OrchestratorState, dryRun: boolean): Promise<void> {
    setDeployStatus(state, 'arbitrum', { status: 'running' })
    saveState(state)

    if (dryRun) {
        console.log('[arb] DRY RUN: pnpm compile && npx hardhat deploy --network arbitrum --tags MyOFT')
        setDeployStatus(state, 'arbitrum', { status: 'skipped' })
        saveState(state)
        return
    }

    // Compile first
    const compile = await run({
        command: 'pnpm',
        args: ['compile'],
        label: 'arb',
        timeout: 120_000,
    })
    if (compile.exitCode !== 0) {
        setDeployStatus(state, 'arbitrum', { status: 'failed', error: 'Compilation failed' })
        saveState(state)
        throw new Error('Arbitrum: compilation failed')
    }

    // Deploy using hardhat-deploy (not lz:deploy which is interactive)
    const result = await run({
        command: 'npx',
        args: ['hardhat', 'deploy', '--network', 'arbitrum', '--tags', 'MyOFT'],
        label: 'arb',
        timeout: 300_000,
    })

    if (result.exitCode !== 0) {
        setDeployStatus(state, 'arbitrum', { status: 'failed', error: 'Deploy failed' })
        saveState(state)
        throw new Error('Arbitrum: deploy failed')
    }

    // Try [OFT_RESULT] tag first, then fall back to deployments JSON
    let addr = result.results['ARBITRUM_CONTRACT_ADDRESS']
    if (!addr) {
        const deployJson = readJsonOutput(path.resolve(PROJECT_ROOT, 'deployments/arbitrum/MyOFT.json'))
        addr = deployJson.address || ''
        if (addr) console.log(`[arb] Read address from deployments/arbitrum/MyOFT.json: ${addr}`)
    }

    if (addr) {
        updateEnv({ ARBITRUM_CONTRACT_ADDRESS: addr })
        setDeployStatus(state, 'arbitrum', { status: 'complete', address: addr })
    } else {
        setDeployStatus(state, 'arbitrum', { status: 'failed', error: 'No address in output or deployments JSON' })
    }
    saveState(state)
}

/**
 * Sync Anchor.toml [programs.mainnet] program ID with the keypair file.
 * If they don't match, auto-fix Anchor.toml to prevent build failures.
 */
function syncAnchorTomlProgramId(): void {
    const anchorTomlPath = path.resolve(PROJECT_ROOT, 'Anchor.toml')
    const keypairPath = path.resolve(PROJECT_ROOT, 'target/deploy/oft-keypair.json')

    if (!fs.existsSync(anchorTomlPath)) {
        console.log('[sol] Anchor.toml not found — skipping program ID sync')
        return
    }
    if (!fs.existsSync(keypairPath)) {
        console.log('[sol] oft-keypair.json not found — skipping program ID sync (will be created by anchor build)')
        return
    }

    const tomlContent = fs.readFileSync(anchorTomlPath, 'utf-8')
    const match = tomlContent.match(/(\[programs\.mainnet\]\s*\n\s*oft\s*=\s*")(\w+)(")/)
    if (!match) {
        console.warn('[sol] Warning: Could not parse [programs.mainnet] in Anchor.toml — skipping sync')
        return
    }

    const tomlProgramId = match[2]

    // Derive program ID from keypair using solana-keygen
    try {
        const env = readEnv()
        const home = process.env.HOME || ''
        const extraPath = (env.EXTRA_PATH || '').replace(/~/g, home)
        const testPath = extraPath ? `${extraPath}:${process.env.PATH || ''}` : process.env.PATH || ''

        const result = execSync(`solana-keygen pubkey ${keypairPath}`, {
            env: { ...process.env, PATH: testPath },
            timeout: 5_000,
            stdio: 'pipe',
        })
        const keypairProgramId = result.toString().trim()

        if (tomlProgramId !== keypairProgramId) {
            console.log(`[sol] Anchor.toml program ID mismatch: ${tomlProgramId} → ${keypairProgramId}`)
            // Fix both [programs.mainnet] and [programs.localnet]
            let fixed = tomlContent.replace(
                /(\[programs\.mainnet\]\s*\n\s*oft\s*=\s*")\w+(")/,
                `$1${keypairProgramId}$2`
            )
            fixed = fixed.replace(
                /(\[programs\.localnet\]\s*\n\s*oft\s*=\s*")\w+(")/,
                `$1${keypairProgramId}$2`
            )
            fs.writeFileSync(anchorTomlPath, fixed)
            console.log(`[sol] Anchor.toml auto-fixed to ${keypairProgramId}`)
        }
    } catch (e: any) {
        console.warn(`[sol] Warning: Could not run solana-keygen to verify program ID: ${e.message || e}`)
    }
}

async function deploySolana(state: OrchestratorState, dryRun: boolean): Promise<void> {
    setDeployStatus(state, 'solana', { status: 'running' })
    saveState(state)

    if (dryRun) {
        const soExists = fs.existsSync(path.resolve(PROJECT_ROOT, 'target/deploy/oft.so'))
        console.log('[sol] DRY RUN:')
        console.log(`[sol]   Step 0: anchor build ${soExists ? '(skipped — oft.so exists)' : '(needed)'}`)
        console.log('[sol]   Step 1: solana program deploy target/deploy/oft.so')
        console.log('[sol]   Step 2: npx hardhat run scripts/create-oft-solana.ts')
        console.log('[sol]   Step 3: Read deployments/solana-mainnet/OFT.json for addresses')
        setDeployStatus(state, 'solana', { status: 'skipped' })
        saveState(state)
        return
    }

    // Sync Anchor.toml program ID with keypair before build (Bug #3)
    syncAnchorTomlProgramId()

    // Step 0: Build if needed
    const soPath = path.resolve(PROJECT_ROOT, 'target/deploy/oft.so')
    if (!fs.existsSync(soPath)) {
        console.log('[sol] Step 0: Building Solana program (anchor build)...')
        const build = await run({
            command: 'anchor',
            args: ['build'],
            label: 'sol-build',
            timeout: 300_000,
        })
        if (build.exitCode !== 0) {
            setDeployStatus(state, 'solana', { status: 'failed', error: 'anchor build failed' })
            saveState(state)
            throw new Error('Solana: anchor build failed')
        }
    } else {
        console.log('[sol] Step 0: Skipping build (target/deploy/oft.so exists)')
    }

    // Step 1: Deploy the Solana program
    console.log('[sol] Step 1: Deploying program...')
    const programDeploy = await run({
        command: 'solana',
        args: ['program', 'deploy', 'target/deploy/oft.so', '--program-id', 'target/deploy/oft-keypair.json', '--output', 'json'],
        label: 'sol',
        timeout: 600_000,
    })

    let programId = ''
    // Try to extract program ID from JSON output
    try {
        const jsonOutput = JSON.parse(programDeploy.stdout.trim().split('\n').pop() || '{}')
        programId = jsonOutput.programId || ''
    } catch {
        // Try regex fallback
        const match = programDeploy.stdout.match(/Program Id:\s*(\w+)/)
        if (match) programId = match[1]
    }

    if (programDeploy.exitCode !== 0 || !programId) {
        setDeployStatus(state, 'solana', { status: 'failed', error: 'Program deploy failed' })
        saveState(state)
        throw new Error('Solana: program deploy failed')
    }

    updateEnv({ SOLANA_OFT_PROGRAM_ID: programId })
    console.log(`[sol] Program ID: ${programId}`)

    // Step 2: Create OFT store (Hardhat task)
    console.log('[sol] Step 2: Creating OFT store...')
    const createOft = await run({
        command: 'npx',
        args: ['hardhat', 'run', 'scripts/create-oft-solana.ts'],
        label: 'sol',
        timeout: 300_000,
    })

    if (createOft.exitCode !== 0) {
        setDeployStatus(state, 'solana', { status: 'failed', error: 'OFT store creation failed' })
        saveState(state)
        throw new Error('Solana: OFT store creation failed')
    }

    // Step 3: Read deployment output JSON for addresses (not regex from stdout)
    const deployJson = readJsonOutput(path.resolve(PROJECT_ROOT, 'deployments/solana-mainnet/OFT.json'))
    const oftStore = deployJson.oftStore || ''
    const mint = deployJson.mint || ''
    const jsonProgramId = deployJson.programId || ''

    if (oftStore) {
        console.log(`[sol] Read from deployments/solana-mainnet/OFT.json: oftStore=${oftStore}`)
        updateEnv({ SOLANA_OFT_STORE: oftStore })
    }
    if (mint) {
        updateEnv({ SOLANA_TOKEN_MINT: mint })
    }
    // Use JSON programId if available, otherwise keep the one from deploy output
    const finalProgramId = jsonProgramId || programId

    setDeployStatus(state, 'solana', {
        status: 'complete',
        address: oftStore || finalProgramId,
        extras: {
            SOLANA_OFT_PROGRAM_ID: finalProgramId,
            SOLANA_OFT_STORE: oftStore,
            SOLANA_TOKEN_MINT: mint,
        },
    })
    saveState(state)
}

async function deployStarknet(state: OrchestratorState, dryRun: boolean): Promise<void> {
    setDeployStatus(state, 'starknet', { status: 'running' })
    saveState(state)

    if (dryRun) {
        console.log('[stk] DRY RUN: npx tsx scripts/deploy-starknet.ts')
        setDeployStatus(state, 'starknet', { status: 'skipped' })
        saveState(state)
        return
    }

    const result = await run({
        command: 'npx',
        args: ['tsx', 'scripts/deploy-starknet.ts'],
        label: 'stk',
        timeout: 300_000,
    })

    if (result.exitCode !== 0) {
        setDeployStatus(state, 'starknet', { status: 'failed', error: 'Deploy failed' })
        saveState(state)
        throw new Error('Starknet: deploy failed')
    }

    const erc20 = result.results['STARKNET_ERC20_ADDRESS']
    const adapter = result.results['STARKNET_ADAPTER_ADDRESS']

    if (erc20 && adapter) {
        updateEnv({ STARKNET_ERC20_ADDRESS: erc20, STARKNET_ADAPTER_ADDRESS: adapter })
        setDeployStatus(state, 'starknet', {
            status: 'complete',
            address: adapter,
            extras: { STARKNET_ERC20_ADDRESS: erc20 },
        })
    } else {
        setDeployStatus(state, 'starknet', { status: 'failed', error: 'Missing addresses in output' })
    }
    saveState(state)
}

/**
 * Auto-generate Sui Move source from TOKEN_NAME/TOKEN_SYMBOL.
 * Creates: sui/token/sources/{symbol}.move and sui/token/Move.toml
 * Removes old .move files and stale build artifacts.
 */
function generateSuiTokenSource(): void {
    const tokenName = process.env.TOKEN_NAME || readEnv().TOKEN_NAME
    const tokenSymbol = process.env.TOKEN_SYMBOL || readEnv().TOKEN_SYMBOL
    if (!tokenName || !tokenSymbol) {
        throw new Error('Set TOKEN_NAME and TOKEN_SYMBOL in .env before deploying Sui')
    }

    const moduleName = tokenSymbol.toLowerCase().replace(/[^a-z0-9_]/g, '')
    const structName = tokenSymbol.toUpperCase().replace(/[^A-Z0-9_]/g, '')
    if (!moduleName || !structName || !/^[a-z]/.test(moduleName)) {
        throw new Error(
            `TOKEN_SYMBOL "${tokenSymbol}" cannot be used as a Move module name. ` +
            `Must start with a letter and contain only alphanumeric/underscore characters.`
        )
    }

    const sourcesDir = path.resolve(PROJECT_ROOT, 'sui/token/sources')
    const buildDir = path.resolve(PROJECT_ROOT, 'sui/token/build')
    const moveFile = path.resolve(sourcesDir, `${moduleName}.move`)
    const moveToml = path.resolve(PROJECT_ROOT, 'sui/token/Move.toml')

    // Ensure sources directory exists
    if (!fs.existsSync(sourcesDir)) {
        fs.mkdirSync(sourcesDir, { recursive: true })
    }

    // Check if source already matches (idempotent)
    if (fs.existsSync(moveFile)) {
        const existing = fs.readFileSync(moveFile, 'utf-8')
        if (existing.includes(`module ${moduleName}::${moduleName}`) && existing.includes(`public struct ${structName}`)) {
            console.log(`[sui] Move source already matches ${structName}. Skipping generation.`)
            return
        }
    }

    // Remove old .move files (there should only be one)
    if (fs.existsSync(sourcesDir)) {
        for (const f of fs.readdirSync(sourcesDir)) {
            if (f.endsWith('.move') && f !== `${moduleName}.move`) {
                console.log(`[sui] Removing old source: ${f}`)
                fs.unlinkSync(path.resolve(sourcesDir, f))
            }
        }
    }

    // Remove stale build directory (build dir name = old package name)
    if (fs.existsSync(buildDir)) {
        console.log('[sui] Removing stale build/ directory')
        fs.rmSync(buildDir, { recursive: true, force: true })
    }

    // Generate .move source
    const moveSource = `module ${moduleName}::${moduleName};

use sui::coin;

/// One-time witness — struct name MUST match module name (uppercase)
public struct ${structName} has drop {}

fun init(otw: ${structName}, ctx: &mut TxContext) {
    let (treasury_cap, coin_metadata) = coin::create_currency(
        otw, 6, b"${tokenSymbol}", b"${tokenName}",
        b"Omnichain token deployed via LayerZero V2",
        option::none(), ctx,
    );
    transfer::public_freeze_object(coin_metadata);
    transfer::public_transfer(treasury_cap, ctx.sender());
}
`
    fs.writeFileSync(moveFile, moveSource)
    console.log(`[sui] Generated ${moduleName}.move (module: ${moduleName}, OTW: ${structName})`)

    // Generate Move.toml
    const moveTomlContent = `[package]
name = "${moduleName}"
edition = "2024.beta"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }

[addresses]
${moduleName} = "0x0"
`
    fs.writeFileSync(moveToml, moveTomlContent)
    console.log(`[sui] Generated Move.toml (package: ${moduleName})`)
}

async function deploySui(state: OrchestratorState, dryRun: boolean): Promise<void> {
    setDeployStatus(state, 'sui', { status: 'running' })
    saveState(state)

    // Auto-generate Move source from TOKEN_NAME/TOKEN_SYMBOL
    generateSuiTokenSource()

    // Auto-delete stale Published.toml BEFORE reading env (Bug #5)
    // Only delete if we don't already have a published package ID in .env
    // (if package ID exists, we skip publish anyway; if not, stale file blocks publish)
    if (!dryRun) {
        const preEnv = readEnv()
        if (!preEnv.SUI_TOKEN_PACKAGE) {
            const tokenPub = path.resolve(PROJECT_ROOT, 'sui/token/Published.toml')
            if (fs.existsSync(tokenPub)) {
                console.log('[sui] Removing stale sui/token/Published.toml')
                fs.unlinkSync(tokenPub)
            }
        }
        if (!preEnv.SUI_OFT_PACKAGE) {
            const oftPub = path.resolve(PROJECT_ROOT, 'sui/oft/Published.toml')
            if (fs.existsSync(oftPub)) {
                console.log('[sui] Removing stale sui/oft/Published.toml')
                fs.unlinkSync(oftPub)
            }
        }
    }

    const env = readEnv()
    const existingTokenPkg = env.SUI_TOKEN_PACKAGE || ''
    const existingOftPkg = env.SUI_OFT_PACKAGE || ''

    if (dryRun) {
        console.log('[sui] DRY RUN:')
        console.log(`[sui]   Step 1: sui client publish token ${existingTokenPkg ? `(skipped — already published: ${existingTokenPkg})` : '(needed)'}`)
        console.log(`[sui]   Step 2: sui client publish OFT ${existingOftPkg ? `(skipped — already published: ${existingOftPkg})` : '(needed)'}`)
        console.log('[sui]   Step 3: npx tsx scripts/deploy-sui.ts (always runs — idempotent)')
        setDeployStatus(state, 'sui', { status: 'skipped' })
        saveState(state)
        return
    }

    // Step 1: Publish token package (skip if already published)
    let tokenPackageId = existingTokenPkg
    let tokenTreasuryCap = ''
    let tokenCoinMetadata = ''

    if (tokenPackageId) {
        console.log(`[sui] Step 1: Skipping token publish (already published: ${tokenPackageId})`)
    } else {
        console.log('[sui] Step 1: Publishing token package...')
        const tokenPub = await run({
            command: 'sui',
            args: ['client', 'publish', 'sui/token/', '--gas-budget', '500000000', '--json'],
            label: 'sui-token',
            timeout: 120_000,
        })

        if (tokenPub.exitCode !== 0) {
            setDeployStatus(state, 'sui', { status: 'failed', error: 'Token package publish failed' })
            saveState(state)
            throw new Error('Sui: token package publish failed')
        }

        const tokenJson = parseSuiPublishOutput(tokenPub.stdout)
        if (!tokenJson.packageId) {
            setDeployStatus(state, 'sui', { status: 'failed', error: 'Could not parse token package ID' })
            saveState(state)
            throw new Error('Sui: could not parse token package ID')
        }

        tokenPackageId = tokenJson.packageId
        tokenTreasuryCap = tokenJson.treasuryCap || ''
        tokenCoinMetadata = tokenJson.coinMetadata || ''

        const suiEnv: Record<string, string> = { SUI_TOKEN_PACKAGE: tokenPackageId }
        if (tokenTreasuryCap) suiEnv.SUI_TREASURY_CAP = tokenTreasuryCap
        if (tokenCoinMetadata) suiEnv.SUI_COIN_METADATA = tokenCoinMetadata
        if (tokenJson.coinType) suiEnv.SUI_COIN_TYPE = tokenJson.coinType
        updateEnv(suiEnv)

        console.log(`[sui] Token Package: ${tokenPackageId}`)
        if (tokenJson.coinType) console.log(`[sui] Coin Type: ${tokenJson.coinType}`)

        // Wait for RPC sync
        await new Promise((r) => setTimeout(r, 3000))
    }

    // Step 2: Publish OFT package (skip if already published)
    let oftPackageId = existingOftPkg
    let oappObject = ''
    let initTicket = ''

    if (oftPackageId) {
        console.log(`[sui] Step 2: Skipping OFT publish (already published: ${oftPackageId})`)
    } else {
        console.log('[sui] Step 2: Publishing OFT package...')
        const oftPub = await run({
            command: 'sui',
            args: ['client', 'publish', 'sui/oft/', '--gas-budget', '1000000000', '--json'],
            label: 'sui-oft',
            timeout: 120_000,
        })

        if (oftPub.exitCode !== 0) {
            setDeployStatus(state, 'sui', { status: 'failed', error: 'OFT package publish failed' })
            saveState(state)
            throw new Error('Sui: OFT package publish failed')
        }

        const oftJson = parseSuiPublishOutput(oftPub.stdout)
        if (!oftJson.packageId) {
            setDeployStatus(state, 'sui', { status: 'failed', error: 'Could not parse OFT package ID' })
            saveState(state)
            throw new Error('Sui: could not parse OFT package ID')
        }

        oftPackageId = oftJson.packageId
        oappObject = oftJson.oappObject || ''
        initTicket = oftJson.initTicket || ''

        const oftEnv: Record<string, string> = { SUI_OFT_PACKAGE: oftPackageId }
        if (oappObject) oftEnv.SUI_OAPP_OBJECT = oappObject
        if (initTicket) oftEnv.SUI_INIT_TICKET = initTicket
        updateEnv(oftEnv)

        console.log(`[sui] OFT Package: ${oftPackageId}`)

        // Wait for RPC sync
        await new Promise((r) => setTimeout(r, 3000))
    }

    // Step 3: Initialize OFT (always runs — idempotent)
    console.log('[sui] Step 3: Initializing OFT...')
    const init = await run({
        command: 'npx',
        args: ['tsx', 'scripts/deploy-sui.ts'],
        label: 'sui-init',
        timeout: 120_000,
    })

    if (init.exitCode !== 0) {
        setDeployStatus(state, 'sui', { status: 'failed', error: 'OFT initialization failed' })
        saveState(state)
        throw new Error('Sui: OFT initialization failed')
    }

    // Collect all result tags
    const allResults = { ...init.results }
    if (allResults.SUI_OFT_OBJECT) updateEnv({ SUI_OFT_OBJECT: allResults.SUI_OFT_OBJECT })
    if (allResults.SUI_ADMIN_CAP) updateEnv({ SUI_ADMIN_CAP: allResults.SUI_ADMIN_CAP })

    // Read SUI_COIN_TYPE that was set during token publish
    const suiCoinType = readEnv().SUI_COIN_TYPE || ''

    setDeployStatus(state, 'sui', {
        status: 'complete',
        address: oftPackageId,  // Package ID = peer address
        extras: {
            SUI_TOKEN_PACKAGE: tokenPackageId,
            SUI_OFT_PACKAGE: oftPackageId,
            SUI_OFT_OBJECT: allResults.SUI_OFT_OBJECT || '',
            SUI_OAPP_OBJECT: allResults.SUI_OAPP_OBJECT || oappObject || '',
            SUI_ADMIN_CAP: allResults.SUI_ADMIN_CAP || '',
            SUI_COIN_TYPE: suiCoinType,
        },
    })
    saveState(state)
}

async function deployTon(state: OrchestratorState, dryRun: boolean): Promise<void> {
    setDeployStatus(state, 'ton', { status: 'running' })
    saveState(state)

    const TON_BUILD_ARTIFACTS = [
        'OftAdapter.compiled.json',
        'Endpoint.compiled.json',
        'Channel.compiled.json',
        'ItoftMinter.compiled.json',
        'ItoftWallet.compiled.json',
    ]
    const buildDir = path.resolve(PROJECT_ROOT, 'ton/lz-framework/build')
    const allArtifactsExist = TON_BUILD_ARTIFACTS.every(
        (f) => fs.existsSync(path.join(buildDir, f))
    )

    if (dryRun) {
        console.log('[ton] DRY RUN:')
        console.log(`[ton]   Step 0: pnpm build in ton/lz-framework/ ${allArtifactsExist ? '(skipped — all 5 artifacts exist)' : '(needed)'}`)
        console.log('[ton]   Step 1: npx tsx scripts/deploy-ton-jetton.ts')
        console.log('[ton]   Step 2: npx tsx scripts/deploy-ton-adapter.ts')
        setDeployStatus(state, 'ton', { status: 'skipped' })
        saveState(state)
        return
    }

    // Step 0: Build TON contracts if needed
    if (!allArtifactsExist) {
        console.log('[ton] Step 0: Building TON contracts (pnpm build)...')
        const build = await run({
            command: 'pnpm',
            args: ['build'],
            cwd: path.resolve(PROJECT_ROOT, 'ton/lz-framework'),
            label: 'ton-build',
            timeout: 300_000,
        })
        if (build.exitCode !== 0) {
            setDeployStatus(state, 'ton', { status: 'failed', error: 'TON build failed' })
            saveState(state)
            throw new Error('TON: pnpm build failed')
        }
    } else {
        console.log('[ton] Step 0: Skipping build (all 5 compiled artifacts exist)')
    }

    // Step 1: Deploy Jetton Master
    console.log('[ton] Step 1: Deploying Jetton Master...')
    const jetton = await run({
        command: 'npx',
        args: ['tsx', 'scripts/deploy-ton-jetton.ts'],
        label: 'ton-jetton',
        timeout: 300_000,
    })

    if (jetton.exitCode !== 0) {
        setDeployStatus(state, 'ton', { status: 'failed', error: 'Jetton deploy failed' })
        saveState(state)
        throw new Error('TON: Jetton deploy failed')
    }

    const jettonMaster = jetton.results['TON_JETTON_MASTER']
    if (jettonMaster) {
        updateEnv({ TON_JETTON_MASTER: jettonMaster })
    }

    // Step 2: Deploy OFT Adapter
    console.log('[ton] Step 2: Deploying OFT Adapter...')
    const adapter = await run({
        command: 'npx',
        args: ['tsx', 'scripts/deploy-ton-adapter.ts'],
        label: 'ton-adapter',
        timeout: 300_000,
    })

    if (adapter.exitCode !== 0) {
        setDeployStatus(state, 'ton', { status: 'failed', error: 'Adapter deploy failed' })
        saveState(state)
        throw new Error('TON: Adapter deploy failed')
    }

    const adapterAddr = adapter.results['TON_OFT_ADAPTER']
    const adapterHash = adapter.results['TON_OFT_ADAPTER_HASH']

    if (adapterAddr) updateEnv({ TON_OFT_ADAPTER: adapterAddr })
    if (adapterHash) updateEnv({ TON_OFT_ADAPTER_HASH: adapterHash })

    setDeployStatus(state, 'ton', {
        status: 'complete',
        address: adapterAddr || '',
        extras: {
            TON_JETTON_MASTER: jettonMaster || '',
            TON_OFT_ADAPTER: adapterAddr || '',
            TON_OFT_ADAPTER_HASH: adapterHash || '',
        },
    })
    saveState(state)
}

// ============ Sui JSON Parser ============

interface SuiPublishResult {
    packageId: string
    treasuryCap?: string
    coinMetadata?: string
    coinType?: string    // Full coin type from TreasuryCap<PKG::module::STRUCT>
    oappObject?: string
    initTicket?: string
}

function parseSuiPublishOutput(stdout: string): SuiPublishResult {
    const result: SuiPublishResult = { packageId: '' }

    // Find the JSON portion in stdout (may be preceded by non-JSON log lines)
    let jsonStr = ''
    const lines = stdout.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.startsWith('{')) {
            jsonStr = lines.slice(i).join('\n')
            break
        }
    }

    if (!jsonStr) return result

    try {
        const json = JSON.parse(jsonStr)
        const changes = json.objectChanges || []

        for (const change of changes) {
            if (change.type === 'published') {
                result.packageId = change.packageId
            }
            if (change.type === 'created' && change.objectType) {
                const type: string = change.objectType
                if (type.includes('TreasuryCap')) {
                    result.treasuryCap = change.objectId
                    // Extract full coin type: TreasuryCap<0xPKG::module::STRUCT>
                    const coinTypeMatch = type.match(/TreasuryCap<(.+)>/)
                    if (coinTypeMatch) result.coinType = coinTypeMatch[1]
                } else if (type.includes('CoinMetadata')) {
                    result.coinMetadata = change.objectId
                } else if (type.includes('OApp') || type.includes('oapp')) {
                    result.oappObject = change.objectId
                } else if (type.includes('InitTicket') || type.includes('init_ticket')) {
                    result.initTicket = change.objectId
                }
            }
        }
    } catch {
        // If JSON parse fails, try regex
        const pkgMatch = jsonStr.match(/"packageId"\s*:\s*"(0x[a-f0-9]+)"/)
        if (pkgMatch) result.packageId = pkgMatch[1]
    }

    return result
}

// ============ Main Entry Point ============

const DEPLOY_FNS: Record<string, (state: OrchestratorState, dryRun: boolean) => Promise<void>> = {
    arbitrum: deployArbitrum,
    solana: deploySolana,
    starknet: deployStarknet,
    sui: deploySui,
    ton: deployTon,
}

export async function deployAll(opts: DeployOptions = {}): Promise<void> {
    const rawChains = opts.chains?.map((c) => c.toLowerCase()) || [...ALL_CHAINS]
    // Validate chain names
    const invalid = rawChains.filter((c) => !(ALL_CHAINS as readonly string[]).includes(c))
    if (invalid.length > 0) {
        throw new Error(`Unknown chain(s): ${invalid.join(', ')}. Valid: ${ALL_CHAINS.join(', ')}`)
    }
    const chains = [...new Set(rawChains)]  // Deduplicate
    const dryRun = opts.dryRun || false

    console.log('\n=== OFT Deploy Orchestrator ===')
    console.log(`Chains: ${chains.join(', ')}`)
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`)

    // Pre-flight checks
    if (!dryRun) {
        console.log('Running pre-flight checks...')
        const basicIssues = await runPreflight(chains)

        // Deep preflight: chain-specific invariant checks (RPC reads, tool verification)
        console.log('\nRunning deep pre-flight checks...')
        const env = readEnv()
        const deep = await runDeepPreflight(chains, env)
        for (const w of deep.warnings) {
            console.log(`  ⚠ ${w}`)
        }

        const allIssues = [...basicIssues, ...deep.issues]
        if (allIssues.length > 0) {
            console.error('\nPre-flight failed:')
            for (const issue of allIssues) {
                console.error(`  - ${issue}`)
            }
            throw new Error('Pre-flight checks failed. Fix issues above and retry.')
        }
        console.log('Pre-flight: all checks passed.\n')
    }

    const state = loadState()
    if (!state.startedAt) state.startedAt = new Date().toISOString()

    // Filter out already-completed chains (resume support)
    const pending = chains.filter((chain) => {
        const current = state.deploy[chain]
        if (current?.status === 'complete') {
            console.log(`${chain}: already deployed (${current.address}). Skipping.`)
            return false
        }
        return true
    })

    if (pending.length === 0) {
        console.log('\nAll chains already deployed.')
        return
    }

    // Deploy in parallel
    const startTime = Date.now()
    console.log(`\nDeploying ${pending.length} chain(s) in parallel...\n`)

    const results = await Promise.allSettled(
        pending.map(async (chain) => {
            const fn = DEPLOY_FNS[chain]
            if (!fn) throw new Error(`No deploy function for chain: ${chain}`)
            await fn(state, dryRun)
            return chain
        })
    )

    // Summary
    const duration = Date.now() - startTime
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Deploy complete in ${formatDuration(duration)}`)
    console.log('='.repeat(50))

    let hasFailures = false
    for (const result of results) {
        if (result.status === 'fulfilled') {
            const chain = result.value
            const ds = state.deploy[chain]
            console.log(`  ${chain.padEnd(12)} ${ds?.status || 'unknown'}  ${ds?.address || ''}`)
        } else {
            hasFailures = true
            console.error(`  FAILED: ${result.reason}`)
        }
    }

    if (hasFailures) {
        console.error('\nSome deployments failed. Run `npx tsx toolkit/oft.ts status` to check.')
        console.error('Re-run `npx tsx toolkit/oft.ts deploy` to retry failed chains.')
    }
}
