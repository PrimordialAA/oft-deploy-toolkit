/**
 * OFT Orchestrator — Test cross-chain transfers
 *
 * Phase 1: Send from Arb → all destinations (sequential — same signer)
 * Phase 2: Poll LZ Scan API for delivery (parallel)
 * Phase 3: Send back from each chain → Arb (parallel — different signers)
 * Phase 4: Poll return deliveries (parallel)
 * Phase 5: Run balances.ts for final accounting
 */

import { run, formatDuration } from './runner'
import { loadState, saveState, setTestStatus, type OrchestratorState } from './state'
import { CHAINS, getPathwayStatus, LZ_SCAN_API } from '../constants'

const ALL_CHAINS = ['arbitrum', 'solana', 'starknet', 'sui', 'ton'] as const
type ChainName = typeof ALL_CHAINS[number]

interface TestOptions {
    chains?: string[]
    dryRun?: boolean
    amount?: string   // Default: '1'
    skipReturn?: boolean  // Skip Phase 3+4
}

// ============ Send Command Builders ============

interface SendConfig {
    src: ChainName
    dst: ChainName
    command: string
    args: string[]
    env?: Record<string, string>
}

function getSendCommand(src: ChainName, dst: ChainName, amount: string): SendConfig {
    const dstShort = CHAINS[dst]?.shortName || dst
    const env = { DST: dstShort, AMOUNT: amount }

    if (src === 'arbitrum') {
        return {
            src, dst,
            command: 'npx',
            args: ['hardhat', 'run', 'toolkit/templates/send-from-evm.ts', '--network', 'arbitrum'],
            env,
        }
    }

    const srcFile = src === 'starknet' ? 'starknet' : src
    return {
        src, dst,
        command: 'npx',
        args: ['tsx', `toolkit/templates/send-from-${srcFile}.ts`],
        env,
    }
}

// ============ LZ Delivery Polling ============

async function pollDelivery(txHash: string, maxWaitMs = 300_000): Promise<string> {
    const startTime = Date.now()
    const pollInterval = 15_000 // 15s

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const url = `${LZ_SCAN_API}/v1/messages/tx/${txHash}`
            const response = await fetch(url)
            if (response.ok) {
                const data = await response.json()
                const messages = data?.messages || data?.data || []
                if (Array.isArray(messages) && messages.length > 0) {
                    const msg = messages[0]
                    const status = msg.status?.name || msg.status || 'UNKNOWN'
                    if (status === 'DELIVERED') return 'DELIVERED'
                    if (status === 'FAILED') return 'FAILED'
                    if (status === 'BLOCKED') return 'BLOCKED'
                }
            }
        } catch {
            // Ignore polling errors
        }
        await new Promise((r) => setTimeout(r, pollInterval))
    }

    return 'TIMEOUT'
}

/**
 * Extract TX hash from send output.
 * Looks for common patterns: 'TX: 0x...', 'tx hash: ...', 'TX digest: ...'
 */
function extractTxHash(stdout: string): string {
    // EVM: TX: 0x...
    const evmMatch = stdout.match(/TX:\s+(0x[a-fA-F0-9]{64})/)
    if (evmMatch) return evmMatch[1]

    // Sui: TX digest: ...
    const suiMatch = stdout.match(/TX digest:\s+([A-Za-z0-9+/=]{43,44})/)
    if (suiMatch) return suiMatch[1]

    // Solana: Signature: ...
    const solMatch = stdout.match(/Signature:\s+([A-Za-z0-9]{87,88})/)
    if (solMatch) return solMatch[1]

    // Generic: transaction_hash: 0x...
    const genericMatch = stdout.match(/transaction_hash:\s+(0x[a-fA-F0-9]+)/)
    if (genericMatch) return genericMatch[1]

    return ''
}

// ============ Test Phases ============

async function phase1_sendFromArb(
    destinations: ChainName[],
    amount: string,
    state: OrchestratorState,
    dryRun: boolean
): Promise<Map<string, string>> {
    console.log('\n--- Phase 1: Send from Arbitrum ---')
    const txHashes = new Map<string, string>() // key -> txHash

    for (const dst of destinations) {
        const key = `arb-${CHAINS[dst]?.shortName || dst}`
        const status = getPathwayStatus('arbitrum', dst)
        if (status === 'blocked') {
            console.log(`[${key}] Pathway blocked. Skipping.`)
            setTestStatus(state, 'arbitrum', dst, { status: 'skipped' })
            saveState(state)
            continue
        }

        if (dryRun) {
            console.log(`[${key}] DRY RUN: send ${amount} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
            setTestStatus(state, 'arbitrum', dst, { status: 'skipped' })
            saveState(state)
            continue
        }

        setTestStatus(state, 'arbitrum', dst, { status: 'running' })
        saveState(state)

        try {
            const cmd = getSendCommand('arbitrum', dst, amount)
            const result = await run({
                command: cmd.command,
                args: cmd.args,
                env: cmd.env,
                label: key,
                timeout: 120_000,
            })

            if (result.exitCode === 0) {
                const txHash = extractTxHash(result.stdout)
                if (txHash) {
                    txHashes.set(key, txHash)
                    setTestStatus(state, 'arbitrum', dst, { status: 'running', txHash })
                } else {
                    setTestStatus(state, 'arbitrum', dst, { status: 'complete' })
                }
            } else {
                setTestStatus(state, 'arbitrum', dst, {
                    status: 'failed',
                    error: `Exit code ${result.exitCode}`,
                })
            }
        } catch (err: any) {
            setTestStatus(state, 'arbitrum', dst, {
                status: 'failed',
                error: err.message?.slice(0, 100),
            })
        }
        saveState(state)
    }

    return txHashes
}

async function phase2_pollDelivery(
    txHashes: Map<string, string>,
    state: OrchestratorState
): Promise<void> {
    if (txHashes.size === 0) return

    console.log('\n--- Phase 2: Polling delivery status ---')

    const polls = Array.from(txHashes.entries()).map(async ([key, txHash]) => {
        console.log(`[${key}] Polling ${txHash.slice(0, 16)}...`)
        const status = await pollDelivery(txHash)
        console.log(`[${key}] ${status}`)

        // Parse key back to src-dst
        const [, dst] = key.split('-')
        const dstChain = Object.values(CHAINS).find((c) => c.shortName === dst)
        if (dstChain) {
            const dstName = Object.keys(CHAINS).find((k) => CHAINS[k].shortName === dst) || dst
            setTestStatus(state, 'arbitrum', dstName, {
                status: status === 'DELIVERED' ? 'complete' : 'failed',
                lzStatus: status,
            })
        }
    })

    await Promise.allSettled(polls)
    saveState(state)
}

async function phase3_sendReturn(
    destinations: ChainName[],
    amount: string,
    state: OrchestratorState,
    dryRun: boolean
): Promise<Map<string, string>> {
    console.log('\n--- Phase 3: Send return transfers → Arbitrum ---')
    const txHashes = new Map<string, string>()

    // Return sends can be parallel (different signers per chain)
    const sends = destinations.map(async (src) => {
        const key = `${CHAINS[src]?.shortName || src}-arb`
        const status = getPathwayStatus(src, 'arbitrum')
        if (status === 'blocked') {
            console.log(`[${key}] Pathway blocked. Skipping.`)
            setTestStatus(state, src, 'arbitrum', { status: 'skipped' })
            return
        }

        if (dryRun) {
            console.log(`[${key}] DRY RUN: send ${amount} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
            setTestStatus(state, src, 'arbitrum', { status: 'skipped' })
            return
        }

        setTestStatus(state, src, 'arbitrum', { status: 'running' })
        saveState(state)

        try {
            const cmd = getSendCommand(src, 'arbitrum', amount)
            const result = await run({
                command: cmd.command,
                args: cmd.args,
                env: cmd.env,
                label: key,
                timeout: 120_000,
            })

            if (result.exitCode === 0) {
                const txHash = extractTxHash(result.stdout)
                if (txHash) {
                    txHashes.set(key, txHash)
                    setTestStatus(state, src, 'arbitrum', { status: 'running', txHash })
                } else {
                    setTestStatus(state, src, 'arbitrum', { status: 'complete' })
                }
            } else {
                setTestStatus(state, src, 'arbitrum', {
                    status: 'failed',
                    error: `Exit code ${result.exitCode}`,
                })
            }
        } catch (err: any) {
            setTestStatus(state, src, 'arbitrum', {
                status: 'failed',
                error: err.message?.slice(0, 100),
            })
        }
        saveState(state)
    })

    await Promise.allSettled(sends)
    return txHashes
}

async function phase5_balances(): Promise<void> {
    console.log('\n--- Phase 5: Final balance check ---')
    try {
        await run({
            command: 'npx',
            args: ['tsx', 'toolkit/balances.ts'],
            label: 'balances',
            timeout: 120_000,
        })
    } catch (err: any) {
        console.error(`Balance check failed: ${err.message}`)
    }
}

// ============ Main Entry Point ============

export async function testAll(opts: TestOptions = {}): Promise<void> {
    const rawChains = opts.chains?.map((c) => c.toLowerCase()) || [...ALL_CHAINS]
    // Validate chain names
    const invalid = rawChains.filter((c) => !ALL_CHAINS.includes(c as any))
    if (invalid.length > 0) {
        throw new Error(`Unknown chain(s): ${invalid.join(', ')}. Valid: ${ALL_CHAINS.join(', ')}`)
    }
    const requestedChains = [...new Set(rawChains)] as ChainName[]  // Deduplicate
    const dryRun = opts.dryRun || false
    const amount = opts.amount || '1'
    const skipReturn = opts.skipReturn || false

    // Destinations are all requested chains except arbitrum (which is the hub)
    const destinations = requestedChains.filter((c) => c !== 'arbitrum')

    const tokenSymbol = process.env.TOKEN_SYMBOL || 'OFT'

    console.log('\n=== OFT Test Orchestrator ===')
    console.log(`Destinations: ${destinations.join(', ')}`)
    console.log(`Amount: ${amount} ${tokenSymbol} per transfer`)
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)

    const state = loadState()
    const startTime = Date.now()

    // Phase 1: Send from Arb → destinations (sequential)
    const outboundTxs = await phase1_sendFromArb(destinations, amount, state, dryRun)

    // Phase 2: Poll delivery
    if (!dryRun && outboundTxs.size > 0) {
        await phase2_pollDelivery(outboundTxs, state)
    }

    // Phase 3+4: Return transfers (optional)
    if (!skipReturn) {
        const returnTxs = await phase3_sendReturn(destinations, amount, state, dryRun)
        if (!dryRun && returnTxs.size > 0) {
            console.log('\n--- Phase 4: Polling return delivery status ---')
            // Reuse phase 2 logic for return sends
            const returnPolls = Array.from(returnTxs.entries()).map(async ([key, txHash]) => {
                console.log(`[${key}] Polling ${txHash.slice(0, 16)}...`)
                const status = await pollDelivery(txHash)
                console.log(`[${key}] ${status}`)
            })
            await Promise.allSettled(returnPolls)
        }
    }

    // Phase 5: Balance check
    if (!dryRun) {
        await phase5_balances()
    }

    // Summary
    const duration = Date.now() - startTime
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Test complete in ${formatDuration(duration)}`)
    console.log('='.repeat(50))

    let complete = 0
    let failed = 0
    for (const key of Object.keys(state.test)) {
        if (state.test[key].status === 'complete') complete++
        else if (state.test[key].status === 'failed') failed++
    }
    console.log(`  Transfers complete: ${complete}`)
    console.log(`  Transfers failed:   ${failed}`)

    if (failed > 0) {
        console.error('\nSome transfers failed. Run `npx tsx toolkit/oft.ts status` for details.')
    }

    saveState(state)
}
