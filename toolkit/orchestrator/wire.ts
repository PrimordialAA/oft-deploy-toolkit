/**
 * OFT Orchestrator — Wire all pathways
 *
 * Wires all 20 pathway directions (minus blocked ones).
 * Strategy: 5 parallel "lanes" (one per source chain), each wires sequentially
 * to its destinations.
 */

import { run, formatDuration } from './runner'
import { loadState, saveState, setWireStatus, type OrchestratorState } from './state'
import { CHAINS, getPathwayStatus } from '../constants'

const ALL_CHAINS = ['arbitrum', 'solana', 'starknet', 'sui', 'ton'] as const
type ChainName = typeof ALL_CHAINS[number]

interface WireOptions {
    chains?: string[]
    dryRun?: boolean
}

// ============ Wire Configuration ============

interface WireConfig {
    src: ChainName
    dst: ChainName
    command: string
    args: string[]
    env?: Record<string, string>
}

function getWireCommand(src: ChainName, dst: ChainName): WireConfig {
    const dstShort = CHAINS[dst]?.shortName || dst
    const env = { DST: dstShort, SET_DVN: 'true' }

    if (src === 'arbitrum') {
        // EVM source uses Hardhat runner
        return {
            src, dst,
            command: 'npx',
            args: ['hardhat', 'run', 'toolkit/templates/wire-from-evm.ts', '--network', 'arbitrum'],
            env,
        }
    }

    // Non-EVM sources use tsx
    const srcShort = src === 'starknet' ? 'starknet' : src
    return {
        src, dst,
        command: 'npx',
        args: ['tsx', `toolkit/templates/wire-from-${srcShort}.ts`],
        env,
    }
}

function getPathways(chains: ChainName[]): WireConfig[] {
    const pathways: WireConfig[] = []

    for (const src of chains) {
        for (const dst of chains) {
            if (src === dst) continue

            // Check if pathway is blocked
            const status = getPathwayStatus(src, dst)
            if (status === 'blocked') continue

            pathways.push(getWireCommand(src, dst))
        }
    }

    return pathways
}

// ============ Lane Runner ============

/**
 * Run all wire commands for a single source chain, sequentially.
 * (Same signer can't do concurrent TXs on most chains.)
 */
async function runLane(
    src: ChainName,
    pathways: WireConfig[],
    state: OrchestratorState,
    dryRun: boolean
): Promise<void> {
    const lane = pathways.filter((p) => p.src === src)
    if (lane.length === 0) return

    console.log(`\n--- Lane: ${src} (${lane.length} destinations) ---`)

    for (const pw of lane) {
        const key = `${pw.src}-${pw.dst}`
        const existing = state.wire[key]

        // Skip already-complete pathways
        if (existing?.status === 'complete') {
            console.log(`[${key}] Already wired. Skipping.`)
            continue
        }

        if (dryRun) {
            console.log(`[${key}] DRY RUN: ${pw.command} ${pw.args.join(' ')}`)
            setWireStatus(state, pw.src, pw.dst, { status: 'skipped' })
            saveState(state)
            continue
        }

        setWireStatus(state, pw.src, pw.dst, { status: 'running' })
        saveState(state)

        try {
            const result = await run({
                command: pw.command,
                args: pw.args,
                env: pw.env,
                label: key,
                timeout: 300_000,
            })

            if (result.exitCode === 0) {
                setWireStatus(state, pw.src, pw.dst, { status: 'complete' })
            } else {
                setWireStatus(state, pw.src, pw.dst, {
                    status: 'failed',
                    error: `Exit code ${result.exitCode}`,
                })
            }
        } catch (err: any) {
            setWireStatus(state, pw.src, pw.dst, {
                status: 'failed',
                error: err.message?.slice(0, 100),
            })
        }
        saveState(state)
    }
}

// ============ Main Entry Point ============

export async function wireAll(opts: WireOptions = {}): Promise<void> {
    const rawChains = opts.chains?.map((c) => c.toLowerCase()) || [...ALL_CHAINS]
    // Validate chain names
    const invalid = rawChains.filter((c) => !ALL_CHAINS.includes(c as any))
    if (invalid.length > 0) {
        throw new Error(`Unknown chain(s): ${invalid.join(', ')}. Valid: ${ALL_CHAINS.join(', ')}`)
    }
    const chains = [...new Set(rawChains)] as ChainName[]  // Deduplicate
    const dryRun = opts.dryRun || false

    console.log('\n=== OFT Wire Orchestrator ===')
    console.log(`Chains: ${chains.join(', ')}`)
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)

    const pathways = getPathways(chains)

    // Report blocked pathways
    const blockedCount = chains.length * (chains.length - 1) - pathways.length
    if (blockedCount > 0) {
        console.log(`\nSkipping ${blockedCount} blocked pathway(s) (no LZ endpoint)`)
    }
    console.log(`Wiring ${pathways.length} pathway(s)\n`)

    const state = loadState()
    const startTime = Date.now()

    // Group by source chain for parallel lanes
    const sources = [...new Set(pathways.map((p) => p.src))]

    // Run all lanes in parallel
    const results = await Promise.allSettled(
        sources.map((src) => runLane(src, pathways, state, dryRun))
    )

    // Summary
    const duration = Date.now() - startTime
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Wire complete in ${formatDuration(duration)}`)
    console.log('='.repeat(50))

    let complete = 0
    let failed = 0
    let skipped = 0

    for (const pw of pathways) {
        const key = `${pw.src}-${pw.dst}`
        const ws = state.wire[key]
        if (ws?.status === 'complete') complete++
        else if (ws?.status === 'failed') failed++
        else if (ws?.status === 'skipped') skipped++
    }

    console.log(`  Complete: ${complete}`)
    console.log(`  Failed:   ${failed}`)
    console.log(`  Skipped:  ${skipped}`)

    if (failed > 0) {
        console.error('\nSome pathways failed. Run `npx tsx toolkit/oft.ts status` to check.')
        console.error('Re-run `npx tsx toolkit/oft.ts wire` to retry failed pathways.')
    }
}
