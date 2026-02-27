/**
 * OFT Orchestrator — Subprocess runner + output parser
 *
 * Spawns scripts as child processes, tees output to console,
 * and extracts [OFT_RESULT] KEY=VALUE tags from stdout.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { readEnv } from './env'

export interface RunOptions {
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number   // ms, default 600_000 (10 min)
    label?: string     // Display prefix for log lines
}

export interface RunResult {
    exitCode: number
    stdout: string
    stderr: string
    results: Record<string, string>  // Parsed [OFT_RESULT] key-value pairs
    duration: number                 // ms
}

export const PROJECT_ROOT = path.resolve(__dirname, '../..')

/**
 * Run a subprocess, tee output to console, parse [OFT_RESULT] tags.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
    const {
        command,
        args = [],
        cwd = PROJECT_ROOT,
        env: envOverrides = {},
        timeout = 600_000,
        label,
    } = opts

    // Merge current process env + .env file + overrides
    const dotEnv = readEnv()
    const mergedEnv = { ...process.env, ...dotEnv, ...envOverrides }
    // Prepend EXTRA_PATH to PATH (for solana, anchor, etc.)
    // Expand ~ to HOME — Node's spawn() does NOT expand tilde in env vars
    if (dotEnv.EXTRA_PATH) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/root'
        const expandedPath = dotEnv.EXTRA_PATH.replace(/~/g, homeDir)
        mergedEnv.PATH = `${expandedPath}:${process.env.PATH || ''}`
    }

    const prefix = label ? `[${label}] ` : ''
    const startTime = Date.now()

    return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: mergedEnv,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            stdout += text
            // Tee to console with prefix
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    process.stdout.write(`${prefix}${line}\n`)
                }
            }
        })

        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            stderr += text
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    process.stderr.write(`${prefix}${line}\n`)
                }
            }
        })

        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`${prefix}Timed out after ${timeout / 1000}s`))
        }, timeout)

        child.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
        })

        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({
                exitCode: code ?? 1,
                stdout,
                stderr,
                results: parseResults(stdout),
                duration: Date.now() - startTime,
            })
        })
    })
}

/**
 * Extract [OFT_RESULT] KEY=VALUE pairs from stdout.
 */
export function parseResults(stdout: string): Record<string, string> {
    const results: Record<string, string> = {}
    const regex = /\[OFT_RESULT\]\s+(\w+)=([^\n]*)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(stdout)) !== null) {
        results[match[1]] = match[2].trim()
    }
    return results
}

/**
 * Check if a CLI tool is available on PATH.
 */
export async function checkTool(name: string): Promise<boolean> {
    try {
        const result = await run({
            command: 'which',
            args: [name],
            timeout: 5_000,
        })
        return result.exitCode === 0
    } catch {
        return false
    }
}

/**
 * Format duration in human-readable form.
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return `${minutes}m ${remaining}s`
}

/**
 * Read a JSON file and flatten top-level string values into a Record.
 * Used for reading hardhat-deploy artifacts (deployments/arbitrum/MyOFT.json)
 * and Solana deployment outputs (deployments/solana-mainnet/OFT.json).
 */
export function readJsonOutput(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) return {}
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        const result: Record<string, string> = {}
        for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'string') {
                result[key] = value
            }
        }
        return result
    } catch {
        return {}
    }
}
