#!/usr/bin/env npx tsx
/**
 * OFT Deployment Orchestrator — CLI Entry Point
 *
 * Usage:
 *   npx tsx toolkit/oft.ts deploy [--chains=arb,sol] [--dry-run]
 *   npx tsx toolkit/oft.ts wire   [--chains=arb,sol] [--dry-run]
 *   npx tsx toolkit/oft.ts test   [--chains=arb,sol] [--dry-run] [--amount=1]
 *   npx tsx toolkit/oft.ts full   [--chains=arb,sol] [--dry-run]
 *   npx tsx toolkit/oft.ts status
 */

import * as fs from 'fs'
import * as path from 'path'
import { deployAll } from './orchestrator/deploy'
import { wireAll } from './orchestrator/wire'
import { testAll } from './orchestrator/test'
import { loadState, printState } from './orchestrator/state'

// ============ Arg Parsing ============

function parseArgs() {
    const args = process.argv.slice(2)
    const command = args[0] || 'help'
    const flags: Record<string, string> = {}

    for (const arg of args.slice(1)) {
        if (arg.startsWith('--')) {
            const [key, val] = arg.slice(2).split('=')
            flags[key] = val ?? 'true'
        }
    }

    return { command, flags }
}

/** Resolve chain name aliases to full names */
const ALIASES: Record<string, string> = {
    arb: 'arbitrum',
    sol: 'solana',
    stk: 'starknet',
    sui: 'sui',
    ton: 'ton',
}

function resolveChains(raw?: string): string[] | undefined {
    if (!raw) return undefined
    const resolved = raw.split(',')
        .map((c) => {
            const trimmed = c.trim().toLowerCase()
            return ALIASES[trimmed] || trimmed
        })
        .filter((c) => c.length > 0)
    // Deduplicate while preserving order
    return [...new Set(resolved)]
}

// ============ Commands ============

async function main() {
    const { command, flags } = parseArgs()
    const chains = resolveChains(flags.chains)
    const dryRun = flags['dry-run'] === 'true'

    switch (command) {
        case 'deploy':
            await deployAll({ chains, dryRun })
            break

        case 'wire':
            await wireAll({ chains, dryRun })
            break

        case 'test': {
            const amount = flags.amount || '1'
            if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
                throw new Error(`--amount must be a positive number (got "${amount}")`)
            }
            await testAll({
                chains,
                dryRun,
                amount,
                skipReturn: flags['skip-return'] === 'true',
            })
            break
        }

        case 'full': {
            const startTime = Date.now()
            if (flags.reset === 'true') {
                const statePath = path.resolve(__dirname, 'state.json')
                if (fs.existsSync(statePath)) {
                    fs.unlinkSync(statePath)
                    console.log('State reset for fresh run.\n')
                }
            }
            console.log('=== Full OFT Deployment Pipeline ===\n')
            console.log('Phase 1/3: Deploy')
            await deployAll({ chains, dryRun })
            console.log('\nPhase 2/3: Wire')
            await wireAll({ chains, dryRun })
            console.log('\nPhase 3/3: Test')
            const testAmount = flags.amount || '1'
            if (isNaN(parseFloat(testAmount)) || parseFloat(testAmount) <= 0) {
                throw new Error(`--amount must be a positive number (got "${testAmount}")`)
            }
            await testAll({
                chains,
                dryRun,
                amount: testAmount,
                skipReturn: flags['skip-return'] === 'true',
            })
            const elapsed = Date.now() - startTime
            console.log(`\n=== Pipeline complete in ${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s ===`)
            break
        }

        case 'status':
            printState(loadState())
            break

        case 'help':
        default:
            console.log(`
OFT Deployment Orchestrator

Commands:
  deploy  [--chains=arb,sol] [--dry-run]   Deploy contracts
  wire    [--chains=arb,sol] [--dry-run]   Wire all pathways
  test    [--chains=arb,sol] [--dry-run]   Test transfers
  full    [--chains=arb,sol] [--dry-run]   Deploy + wire + test
  status                                   Show current state

Options:
  --chains=arb,sol,stk,sui,ton   Comma-separated chain list (default: all)
  --dry-run                       Print plan without executing
  --reset                         Clear state.json for a fresh run (use with full)
  --amount=N                      Tokens per test transfer (default: 1)
  --skip-return                   Skip return transfers in test

Examples:
  npx tsx toolkit/oft.ts deploy                   # Deploy all 5 chains
  npx tsx toolkit/oft.ts deploy --dry-run         # Preview deploy plan
  npx tsx toolkit/oft.ts wire --chains=arb,sol    # Wire only Arb + Sol
  npx tsx toolkit/oft.ts full                     # Full pipeline
  npx tsx toolkit/oft.ts full --reset             # Full pipeline (fresh start)
  npx tsx toolkit/oft.ts status                   # Check progress

Required env vars: TOKEN_NAME, TOKEN_SYMBOL, plus chain-specific keys.
See .env.example for all variables. Full docs: docs/deployment-guide.md
`)
            break
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err.message || err)
    process.exit(1)
})
