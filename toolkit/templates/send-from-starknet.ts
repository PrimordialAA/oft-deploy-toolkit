/**
 * Send OFT tokens from Starknet → any destination.
 * Uses STRK approval + send multicall (atomic).
 *
 * Usage:
 *   DST=arb AMOUNT=1 npx ts-node toolkit/templates/send-from-starknet.ts
 *   DST=sol AMOUNT=5 npx ts-node toolkit/templates/send-from-starknet.ts
 */

import 'dotenv/config'
import { Account, RpcProvider, Contract, CallData, uint256 } from 'starknet'

import { getChain, getPathwayStatus, STARKNET_CONSTANTS } from '../constants'
import { addressToBytes32BigInt, getLzScanUrl } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const AMOUNT = process.env.AMOUNT || '1'
const TOKEN_DECIMALS = 6

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> AMOUNT=<n> npx ts-node toolkit/templates/send-from-starknet.ts')
        process.exit(1)
    }

    const rpcUrl = process.env.STARKNET_RPC_URL || process.env.RPC_STARKNET
    const privateKey = process.env.STARKNET_PRIVATE_KEY
    const accountAddress = process.env.STARKNET_ACCOUNT_ADDRESS
    const adapterAddress = process.env.STARKNET_ADAPTER_ADDRESS
    const erc20Address = process.env.STARKNET_ERC20_ADDRESS

    if (!rpcUrl || !privateKey || !accountAddress) throw new Error('Missing STARKNET env vars')
    if (!adapterAddress || !erc20Address) throw new Error('Missing STARKNET_ADAPTER_ADDRESS or STARKNET_ERC20_ADDRESS')

    const dstChain = getChain(DST)
    const recipientAddress = resolveRecipient(DST)
    if (!recipientAddress) throw new Error(`No recipient for ${DST}`)

    const pathwayStatus = getPathwayStatus('starknet', DST)
    if (pathwayStatus === 'blocked') {
        throw new Error(`Stk → ${dstChain.name} pathway is BLOCKED. Do NOT send tokens.`)
    }

    const recipientBigInt = addressToBytes32BigInt(recipientAddress)

    console.log(`=== Sending ${AMOUNT} ${process.env.TOKEN_SYMBOL || 'OFT'}: Starknet → ${dstChain.name} ===\n`)

    const provider = new RpcProvider({ nodeUrl: rpcUrl })
    const account = new Account({ provider, address: accountAddress, signer: privateKey })

    console.log(`Deployer: ${account.address}`)
    console.log(`Adapter:  ${adapterAddress}`)
    console.log(`Token:    ${erc20Address}`)

    // Get ABIs
    const adapterClassAt = await provider.getClassAt(adapterAddress)
    const adapter = new Contract({ abi: adapterClassAt.abi, address: adapterAddress, providerOrAccount: account })
    const erc20ClassAt = await provider.getClassAt(erc20Address)
    const token = new Contract({ abi: erc20ClassAt.abi, address: erc20Address, providerOrAccount: account })

    // Check balance
    const rawBalance = await token.call('balance_of', [account.address])
    const balance = typeof rawBalance === 'bigint' ? rawBalance : uint256.uint256ToBN(rawBalance as any)
    console.log(`Balance: ${Number(balance) / 10 ** TOKEN_DECIMALS} ${process.env.TOKEN_SYMBOL || 'OFT'}`)

    // Build send params
    const amountLD = BigInt(AMOUNT) * BigInt(10 ** TOKEN_DECIMALS)
    const minAmountLD = (amountLD * 99n) / 100n

    console.log(`\nRecipient: ${recipientAddress}`)
    console.log(`Recipient (bytes32): 0x${recipientBigInt.toString(16).padStart(64, '0')}`)

    const sendParam = {
        dst_eid: dstChain.eid,
        to: { value: uint256.bnToUint256(recipientBigInt) },
        amount_ld: uint256.bnToUint256(amountLD),
        min_amount_ld: uint256.bnToUint256(minAmountLD),
        extra_options: '0x',
        compose_msg: '0x',
        oft_cmd: '0x',
    }

    // Quote
    console.log('\nQuoting...')
    const quoteResult = await adapter.call('quote_send', [sendParam, false])
    const qr = quoteResult as any
    const nativeFee = typeof qr.native_fee === 'bigint' ? qr.native_fee : uint256.uint256ToBN(qr.native_fee)
    console.log(`Native fee: ${Number(nativeFee) / 1e18} STRK`)

    // Build multicall: approve STRK + send
    console.log('\nSending (approve STRK + send multicall)...')
    const approvalAmount = (nativeFee * 110n) / 100n // 10% buffer

    const adapterCd = new CallData(adapterClassAt.abi)
    const sendCalldata = adapterCd.compile('send', {
        send_param: sendParam,
        fee: {
            native_fee: uint256.bnToUint256(nativeFee),
            lz_token_fee: uint256.bnToUint256(0n),
        },
        refund_address: account.address,
    })

    const calls = [
        {
            contractAddress: STARKNET_CONSTANTS.strkToken,
            entrypoint: 'approve',
            calldata: CallData.compile({
                spender: adapterAddress,
                amount: uint256.bnToUint256(approvalAmount),
            }),
        },
        {
            contractAddress: adapterAddress,
            entrypoint: 'send',
            calldata: sendCalldata,
        },
    ]

    const txResponse = await account.execute(calls)
    console.log(`TX: ${txResponse.transaction_hash}`)
    console.log(`https://starkscan.co/tx/${txResponse.transaction_hash}`)

    console.log('\nWaiting for confirmation...')
    await provider.waitForTransaction(txResponse.transaction_hash)

    // Check new balance
    const newRawBalance = await token.call('balance_of', [account.address])
    const newBalance = typeof newRawBalance === 'bigint' ? newRawBalance : uint256.uint256ToBN(newRawBalance as any)
    console.log(`\nNew balance: ${Number(newBalance) / 10 ** TOKEN_DECIMALS} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`Burned: ${Number(balance - newBalance) / 10 ** TOKEN_DECIMALS} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`\nTrack: ${getLzScanUrl(txResponse.transaction_hash)}`)
}

function resolveRecipient(dst: string): string {
    switch (dst) {
        case 'arb': case 'arbitrum': return process.env.EVM_DEPLOYER_ADDRESS || ''
        case 'sol': case 'solana': return process.env.SOLANA_DEPLOYER_ADDRESS || ''
        case 'sui': return process.env.SUI_DEPLOYER_ADDRESS || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || ''
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
