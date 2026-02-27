/**
 * OFT Orchestrator — State persistence (JSON)
 *
 * Tracks deploy/wire/test status for resume support.
 * Persisted at toolkit/state.json.
 */

import * as fs from 'fs'
import * as path from 'path'

const STATE_PATH = path.resolve(__dirname, '../state.json')

export type StepStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

export interface DeployState {
    status: StepStatus
    address?: string         // Primary contract/peer address
    extras?: Record<string, string>  // Additional addresses (e.g., SUI_OFT_OBJECT)
    error?: string
    timestamp?: string
}

export interface WireState {
    status: StepStatus
    error?: string
    timestamp?: string
}

export interface SendState {
    status: StepStatus
    txHash?: string
    lzStatus?: string       // DELIVERED, INFLIGHT, etc.
    error?: string
    timestamp?: string
}

export interface OrchestratorState {
    deploy: Record<string, DeployState>   // keyed by chain name
    wire: Record<string, WireState>       // keyed by "src-dst" (e.g., "arb-sol")
    test: Record<string, SendState>       // keyed by "src-dst"
    startedAt?: string
    updatedAt?: string
}

function defaultState(): OrchestratorState {
    return {
        deploy: {},
        wire: {},
        test: {},
    }
}

export function loadState(): OrchestratorState {
    if (!fs.existsSync(STATE_PATH)) return defaultState()
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'))
    } catch {
        console.warn('Warning: state.json is corrupt or unreadable — starting fresh')
        return defaultState()
    }
}

export function saveState(state: OrchestratorState): void {
    state.updatedAt = new Date().toISOString()
    const tmpPath = STATE_PATH + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    fs.renameSync(tmpPath, STATE_PATH)
}

/** Update deploy status for a chain */
export function setDeployStatus(
    state: OrchestratorState,
    chain: string,
    update: Partial<DeployState>
): void {
    if (!state.deploy[chain]) {
        state.deploy[chain] = { status: 'pending' }
    }
    Object.assign(state.deploy[chain], update, { timestamp: new Date().toISOString() })
}

/** Update wire status for a pathway */
export function setWireStatus(
    state: OrchestratorState,
    src: string,
    dst: string,
    update: Partial<WireState>
): void {
    const key = `${src}-${dst}`
    if (!state.wire[key]) {
        state.wire[key] = { status: 'pending' }
    }
    Object.assign(state.wire[key], update, { timestamp: new Date().toISOString() })
}

/** Update test/send status for a pathway */
export function setTestStatus(
    state: OrchestratorState,
    src: string,
    dst: string,
    update: Partial<SendState>
): void {
    const key = `${src}-${dst}`
    if (!state.test[key]) {
        state.test[key] = { status: 'pending' }
    }
    Object.assign(state.test[key], update, { timestamp: new Date().toISOString() })
}

/** Pretty-print state summary */
export function printState(state: OrchestratorState): void {
    console.log('\n=== OFT Orchestrator State ===\n')

    // Deploy
    console.log('Deploy:')
    const chains = Object.keys(state.deploy)
    if (chains.length === 0) {
        console.log('  (no deployments)')
    } else {
        for (const chain of chains) {
            const d = state.deploy[chain]
            const addr = d.address ? ` → ${d.address.slice(0, 20)}...` : ''
            const err = d.error ? ` (${d.error.slice(0, 40)})` : ''
            console.log(`  ${chain.padEnd(12)} ${d.status.padEnd(10)}${addr}${err}`)
        }
    }

    // Wire
    console.log('\nWire:')
    const pathways = Object.keys(state.wire)
    if (pathways.length === 0) {
        console.log('  (no wiring)')
    } else {
        for (const pw of pathways) {
            const w = state.wire[pw]
            const err = w.error ? ` (${w.error.slice(0, 40)})` : ''
            console.log(`  ${pw.padEnd(12)} ${w.status.padEnd(10)}${err}`)
        }
    }

    // Test
    console.log('\nTest:')
    const tests = Object.keys(state.test)
    if (tests.length === 0) {
        console.log('  (no tests)')
    } else {
        for (const t of tests) {
            const s = state.test[t]
            const lz = s.lzStatus ? ` [${s.lzStatus}]` : ''
            const err = s.error ? ` (${s.error.slice(0, 40)})` : ''
            console.log(`  ${t.padEnd(12)} ${s.status.padEnd(10)}${lz}${err}`)
        }
    }

    if (state.updatedAt) {
        console.log(`\nLast updated: ${state.updatedAt}`)
    }
    console.log()
}
