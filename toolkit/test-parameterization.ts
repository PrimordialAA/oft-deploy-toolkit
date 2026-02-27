#!/usr/bin/env npx tsx
/**
 * Unit tests for token parameterization changes.
 * No on-chain transactions — pure logic tests.
 * Run: npx tsx toolkit/test-parameterization.ts
 */

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
    if (condition) {
        console.log(`  PASS: ${name}`)
        passed++
    } else {
        console.error(`  FAIL: ${name}`)
        failed++
    }
}

// ============ Test 1: TreasuryCap coin type extraction ============
console.log('\n--- Test 1: TreasuryCap coin type extraction ---')

const testCases = [
    ['0x2::coin::TreasuryCap<0xabc123::mytoken::MYTOKEN>', '0xabc123::mytoken::MYTOKEN'],
    ['0x2::coin::TreasuryCap<0x5c5a599c::token::TOKEN>', '0x5c5a599c::token::TOKEN'],
    ['0x2::coin::TreasuryCap<0x1234::a::A>', '0x1234::a::A'],
    ['0x2::coin::CoinMetadata<0xabc::foo::FOO>', null], // Not a TreasuryCap
]

for (const [input, expected] of testCases) {
    const match = (input as string).match(/TreasuryCap<(.+)>/)
    const actual = match ? match[1] : null
    assert(actual === expected, `${(input as string).slice(0, 50)}... → ${actual}`)
}

// ============ Test 2: Chain validation ============
console.log('\n--- Test 2: Chain name validation ---')

const ALL_CHAINS = ['arbitrum', 'solana', 'starknet', 'sui', 'ton'] as const

function validateChains(input: string[]): string[] {
    return input.filter(c => !(ALL_CHAINS as readonly string[]).includes(c))
}

assert(validateChains(['arbitrum', 'solana']).length === 0, 'Valid chains pass')
assert(validateChains(['arbitrum', 'fake']).join(',') === 'fake', 'Invalid "fake" caught')
assert(validateChains(['foo', 'bar']).length === 2, 'Multiple invalid chains caught')
assert(validateChains([...ALL_CHAINS]).length === 0, 'All 5 chains pass')

// ============ Test 3: TOKEN_NAME/TOKEN_SYMBOL env check ============
console.log('\n--- Test 3: TOKEN_NAME/TOKEN_SYMBOL env check ---')

// Simulate what preflight does
function checkTokenEnv(env: Record<string, string>, processEnv: Record<string, string>): string[] {
    const issues: string[] = []
    if (!env.TOKEN_NAME && !processEnv.TOKEN_NAME) {
        issues.push('Missing TOKEN_NAME')
    }
    if (!env.TOKEN_SYMBOL && !processEnv.TOKEN_SYMBOL) {
        issues.push('Missing TOKEN_SYMBOL')
    }
    return issues
}

assert(checkTokenEnv({}, {}).length === 2, 'Both missing → 2 issues')
assert(checkTokenEnv({ TOKEN_NAME: 'X', TOKEN_SYMBOL: 'Y' }, {}).length === 0, 'Both in .env → 0 issues')
assert(checkTokenEnv({}, { TOKEN_NAME: 'X', TOKEN_SYMBOL: 'Y' }).length === 0, 'Both in process.env → 0 issues')
assert(checkTokenEnv({ TOKEN_NAME: 'X' }, { TOKEN_SYMBOL: 'Y' }).length === 0, 'Split across env sources → 0 issues')
assert(checkTokenEnv({ TOKEN_NAME: 'X' }, {}).length === 1, 'Missing SYMBOL → 1 issue')

// ============ Test 4: SUI_COIN_TYPE env var reading ============
console.log('\n--- Test 4: SUI_COIN_TYPE env var pattern ---')

function getSuiCoinType(env: Record<string, string | undefined>): string | null {
    if (env.SUI_COIN_TYPE) return env.SUI_COIN_TYPE
    return null  // Would throw in real code
}

assert(getSuiCoinType({ SUI_COIN_TYPE: '0xabc::foo::FOO' }) === '0xabc::foo::FOO', 'Reads explicit SUI_COIN_TYPE')
assert(getSuiCoinType({}) === null, 'Returns null when not set')
assert(getSuiCoinType({ SUI_TOKEN_PACKAGE: '0xabc' }) === null, 'Package alone is not enough')

// ============ Test 5: Pathway blocking ============
console.log('\n--- Test 5: Blocked pathway detection ---')

const PATHWAY_STATUS: Record<string, string> = {
    'starknet-ton': 'blocked',
    'sui-ton': 'blocked',
    'arbitrum-solana': 'active',
}

function getStatus(c1: string, c2: string): string {
    return PATHWAY_STATUS[`${c1}-${c2}`] || PATHWAY_STATUS[`${c2}-${c1}`] || 'unknown'
}

assert(getStatus('starknet', 'ton') === 'blocked', 'stk-ton blocked')
assert(getStatus('ton', 'starknet') === 'blocked', 'ton-stk blocked (reverse)')
assert(getStatus('sui', 'ton') === 'blocked', 'sui-ton blocked')
assert(getStatus('arbitrum', 'solana') === 'active', 'arb-sol active')
assert(getStatus('arbitrum', 'starknet') === 'unknown', 'arb-stk unknown (not in table)')

// ============ Test 6: Chain deduplication ============
console.log('\n--- Test 6: Chain deduplication ---')

function dedup(input: string[]): string[] {
    return [...new Set(input)]
}

assert(dedup(['arbitrum', 'solana', 'arbitrum']).join(',') === 'arbitrum,solana', 'Dedup removes duplicate arb')
assert(dedup(['sui', 'sui', 'sui']).join(',') === 'sui', 'Dedup collapses all to 1')
assert(dedup(['arbitrum', 'solana']).join(',') === 'arbitrum,solana', 'No dupes → unchanged')
assert(dedup([]).length === 0, 'Empty input → empty output')

// ============ Test 7: Tilde expansion ============
console.log('\n--- Test 7: Tilde expansion ---')

function expandTilde(extraPath: string, home: string | undefined): string {
    const homeDir = home || '/root'
    return extraPath.replace(/~/g, homeDir)
}

assert(expandTilde('~/.cargo/bin', '/home/user') === '/home/user/.cargo/bin', 'Expands ~ to HOME')
assert(expandTilde('~/.cargo/bin:~/.local/bin', '/home/u') === '/home/u/.cargo/bin:/home/u/.local/bin', 'Expands multiple tildes')
assert(expandTilde('/usr/bin', '/home/u') === '/usr/bin', 'No tilde → unchanged')
assert(expandTilde('~/.cargo/bin', undefined) === '/root/.cargo/bin', 'Missing HOME → /root fallback')
assert(expandTilde('', '/home/u') === '', 'Empty string → empty string')

// ============ Test 8: Empty/malformed chain flag parsing ============
console.log('\n--- Test 8: Chain flag edge cases ---')

function parseChainFlag(raw: string): string[] {
    return raw.split(',')
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c.length > 0)
}

assert(parseChainFlag('arb,sol').join(',') === 'arb,sol', 'Normal input')
assert(parseChainFlag('arb, sol').join(',') === 'arb,sol', 'Spaces around comma')
assert(parseChainFlag('ARB,SOL').join(',') === 'arb,sol', 'Uppercase normalized')
assert(parseChainFlag(',').length === 0, 'Lone comma → empty')
assert(parseChainFlag('arb,,sol').join(',') === 'arb,sol', 'Double comma → filtered')
assert(parseChainFlag('').length === 0, 'Empty string → empty')
assert(parseChainFlag('  arb  ').join(',') === 'arb', 'Whitespace trimmed')

// ============ Test 9: General env var check (both sources) ============
console.log('\n--- Test 9: General env var check pattern ---')

function checkEnvVar(key: string, env: Record<string, string>, processEnv: Record<string, string | undefined>): boolean {
    return !!(env[key] || processEnv[key])
}

assert(checkEnvVar('PRIVATE_KEY', { PRIVATE_KEY: '0x123' }, {}) === true, 'Found in .env')
assert(checkEnvVar('PRIVATE_KEY', {}, { PRIVATE_KEY: '0x123' }) === true, 'Found in process.env')
assert(checkEnvVar('PRIVATE_KEY', {}, {}) === false, 'Missing from both')
assert(checkEnvVar('PRIVATE_KEY', { PRIVATE_KEY: '' }, {}) === false, 'Empty string is falsy')

// ============ Test 10: .env quote stripping ============
console.log('\n--- Test 10: .env value quote stripping ---')

function parseEnvLine(line: string): [string, string] | null {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) return null
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
    }
    return key ? [key, val] : null
}

assert(parseEnvLine('TOKEN_NAME=MyToken')![1] === 'MyToken', 'Unquoted value')
assert(parseEnvLine('TOKEN_NAME="MyToken"')![1] === 'MyToken', 'Double-quoted value stripped')
assert(parseEnvLine("TOKEN_NAME='MyToken'")![1] === 'MyToken', 'Single-quoted value stripped')
assert(parseEnvLine('TOKEN_NAME="My Token"')![1] === 'My Token', 'Quoted value with space')
assert(parseEnvLine('TOKEN_NAME=')![1] === '', 'Empty value')
assert(parseEnvLine('# comment') === null, 'Comment line returns null')
assert(parseEnvLine('') === null, 'Empty line returns null')
assert(parseEnvLine('KEY="value with = sign"')![1] === 'value with = sign', 'Quoted value with equals')
assert(parseEnvLine('PRIVATE_KEY=0xabc123')![1] === '0xabc123', 'Hex value preserved')

// ============ Test 11: updateEnv preserves existing lines ============
console.log('\n--- Test 11: updateEnv key replacement logic ---')

function simulateUpdateEnv(lines: string[], updates: Record<string, string>): string[] {
    const remaining = new Set(Object.keys(updates))
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
    if (remaining.size > 0) {
        updatedLines.push('')
        for (const key of remaining) {
            updatedLines.push(`${key}=${updates[key]}`)
        }
    }
    return updatedLines
}

const envLines = ['# Section', 'FOO=old', 'BAR=keep', '']
const updated = simulateUpdateEnv(envLines, { FOO: 'new', NEW_KEY: 'added' })
assert(updated[0] === '# Section', 'Comment preserved')
assert(updated[1] === 'FOO=new', 'Existing key updated')
assert(updated[2] === 'BAR=keep', 'Untouched key preserved')
assert(updated.includes('NEW_KEY=added'), 'New key appended')
assert(updated.length > envLines.length, 'Lines grew for new key')

// ============ Test 12: formatDuration edge cases ============
console.log('\n--- Test 12: formatDuration logic ---')

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return `${minutes}m ${remaining}s`
}

assert(formatDuration(0) === '0ms', 'Zero ms')
assert(formatDuration(500) === '500ms', 'Under 1s')
assert(formatDuration(1000) === '1s', 'Exactly 1s')
assert(formatDuration(59000) === '59s', '59s')
assert(formatDuration(60000) === '1m 0s', 'Exactly 1 minute')
assert(formatDuration(125000) === '2m 5s', '2m 5s')
assert(formatDuration(600000) === '10m 0s', '10 minutes')

// ============ Test 13: OFT_RESULT parsing ============
console.log('\n--- Test 13: OFT_RESULT tag parsing ---')

function parseResults(stdout: string): Record<string, string> {
    const results: Record<string, string> = {}
    const regex = /\[OFT_RESULT\]\s+(\w+)=([^\n]*)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(stdout)) !== null) {
        results[match[1]] = match[2].trim()
    }
    return results
}

assert(parseResults('[OFT_RESULT] TX_HASH=0xabc').TX_HASH === '0xabc', 'Simple result parsed')
assert(parseResults('[OFT_RESULT] FOO=bar\n[OFT_RESULT] BAZ=qux').FOO === 'bar', 'Multi-line: first parsed')
assert(parseResults('[OFT_RESULT] FOO=bar\n[OFT_RESULT] BAZ=qux').BAZ === 'qux', 'Multi-line: second parsed')
assert(parseResults('some output\n[OFT_RESULT] KEY=val\nmore output').KEY === 'val', 'Result in middle of output')
assert(Object.keys(parseResults('no results here')).length === 0, 'No results → empty')
assert(parseResults('[OFT_RESULT] KEY=value with spaces').KEY === 'value with spaces', 'Value with spaces')
assert(parseResults('[OFT_RESULT] KEY=a=b=c').KEY === 'a=b=c', 'Value with equals signs')

// ============ Test 14: Sui Move module name derivation ============
console.log('\n--- Test 14: Sui Move module name derivation ---')

function deriveModuleName(symbol: string): { module: string; struct: string } | null {
    const module = symbol.toLowerCase().replace(/[^a-z0-9_]/g, '')
    const struct = symbol.toUpperCase().replace(/[^A-Z0-9_]/g, '')
    if (!module || !struct || !/^[a-z]/.test(module)) return null
    return { module, struct }
}

assert(deriveModuleName('MTK')?.module === 'mtk', 'MTK → module mtk')
assert(deriveModuleName('MTK')?.struct === 'MTK', 'MTK → struct MTK')
assert(deriveModuleName('MYTKN')?.module === 'mytkn', 'MYTKN → module mytkn')
assert(deriveModuleName('My-Token')?.module === 'mytoken', 'Strips hyphens')
assert(deriveModuleName('OFT_V2')?.module === 'oft_v2', 'Preserves underscores')
assert(deriveModuleName('123bad') === null, 'Rejects leading digit')
assert(deriveModuleName('') === null, 'Rejects empty string')
assert(deriveModuleName('---') === null, 'Rejects all-invalid chars')

// ============ Summary ============
console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('='.repeat(40))

if (failed > 0) process.exit(1)
