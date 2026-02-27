/**
 * OFT Orchestrator — .env read/write/update
 *
 * Preserves comments, ordering, and section headers from .env.example.
 * Atomic writes via .env.tmp + rename.
 */

import * as fs from 'fs'
import * as path from 'path'

const DEFAULT_ENV_PATH = path.resolve(__dirname, '../../.env')

/**
 * Read .env file into key-value map.
 * Ignores comments and blank lines.
 */
export function readEnv(envPath = DEFAULT_ENV_PATH): Record<string, string> {
    if (!fs.existsSync(envPath)) return {}
    const content = fs.readFileSync(envPath, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) continue
        const key = trimmed.slice(0, eqIdx).trim()
        let val = trimmed.slice(eqIdx + 1).trim()
        // Strip surrounding quotes (single or double) — matches dotenv behavior
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        if (key) result[key] = val
    }
    return result
}

/**
 * Update .env file with new key-value pairs.
 * - If a key exists, replaces its value in-place.
 * - If a key doesn't exist, appends it at the end.
 * - Preserves all comments, blank lines, and ordering.
 * - Atomic write via tmp + rename.
 */
export function updateEnv(updates: Record<string, string>, envPath = DEFAULT_ENV_PATH): void {
    if (Object.keys(updates).length === 0) return

    let lines: string[] = []
    if (fs.existsSync(envPath)) {
        lines = fs.readFileSync(envPath, 'utf-8').split('\n')
    }

    const remaining = new Set(Object.keys(updates))

    // Update existing lines in-place
    const updatedLines = lines.map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) return line
        const key = trimmed.slice(0, eqIdx).trim()
        if (remaining.has(key)) {
            remaining.delete(key)
            return `${key}=${updates[key]}`
        }
        return line
    })

    // Append any new keys that weren't found
    if (remaining.size > 0) {
        updatedLines.push('')
        for (const key of remaining) {
            updatedLines.push(`${key}=${updates[key]}`)
        }
    }

    // Atomic write
    const tmpPath = envPath + '.tmp'
    fs.writeFileSync(tmpPath, updatedLines.join('\n'))
    fs.renameSync(tmpPath, envPath)
}

/**
 * Check if required env vars are set (non-empty).
 * Returns list of missing var names.
 */
export function checkEnvVars(required: string[], envPath = DEFAULT_ENV_PATH): string[] {
    const env = readEnv(envPath)
    return required.filter((key) => !env[key])
}
