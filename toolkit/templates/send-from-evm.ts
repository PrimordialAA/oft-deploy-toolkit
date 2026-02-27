/**
 * Send OFT tokens from EVM (Arbitrum) → any destination.
 *
 * Usage:
 *   DST=sol AMOUNT=1 npx hardhat run toolkit/templates/send-from-evm.ts --network arbitrum
 *   DST=stk AMOUNT=10 npx hardhat run toolkit/templates/send-from-evm.ts --network arbitrum
 */

import 'dotenv/config'
import { ethers } from 'hardhat'
import { getChain, getPathwayStatus } from '../constants'
import { addressToBytes32Hex, getLzScanUrl } from '../encoding'

// ============ Config ============

const DST = (process.env.DST || '').toLowerCase()
const AMOUNT = process.env.AMOUNT || '1'
const OFT_ADDRESS = process.env.ARBITRUM_CONTRACT_ADDRESS || ''

async function main() {
    if (!DST) {
        console.log('Usage: DST=<chain> AMOUNT=<n> npx hardhat run toolkit/templates/send-from-evm.ts --network arbitrum')
        process.exit(1)
    }
    if (!OFT_ADDRESS) throw new Error('Set ARBITRUM_CONTRACT_ADDRESS in .env')

    const dstChain = getChain(DST)
    const recipientAddress = resolveRecipient(DST)
    if (!recipientAddress) throw new Error(`No recipient address for ${DST}. Set the appropriate env var.`)

    const pathwayStatus = getPathwayStatus('arbitrum', DST)
    if (pathwayStatus === 'blocked') {
        throw new Error(`Arb → ${dstChain.name} pathway is BLOCKED. Do NOT send tokens.`)
    }

    const recipientBytes32 = addressToBytes32Hex(recipientAddress)

    console.log(`=== Sending ${AMOUNT} ${process.env.TOKEN_SYMBOL || 'OFT'}: Arbitrum → ${dstChain.name} ===\n`)

    const [deployer] = await ethers.getSigners()
    console.log(`Deployer: ${deployer.address}`)

    const oft = await ethers.getContractAt('MyOFT', OFT_ADDRESS)
    const decimals = await oft.decimals()
    const balance = await oft.balanceOf(deployer.address)
    console.log(`Balance: ${ethers.utils.formatUnits(balance, decimals)} ${process.env.TOKEN_SYMBOL || 'OFT'}`)

    const amountLD = ethers.utils.parseUnits(AMOUNT, decimals)
    const minAmountLD = amountLD.mul(99).div(100) // 1% slippage

    console.log(`Recipient: ${recipientAddress}`)
    console.log(`Recipient (bytes32): ${recipientBytes32}`)

    const sendParam = {
        dstEid: dstChain.eid,
        to: recipientBytes32,
        amountLD,
        minAmountLD,
        extraOptions: '0x',
        composeMsg: '0x',
        oftCmd: '0x',
    }

    console.log('\nQuoting...')
    const [nativeFee, lzTokenFee] = await oft.quoteSend(sendParam, false)
    console.log(`Native fee: ${ethers.utils.formatEther(nativeFee)} ETH`)

    console.log('\nSending...')
    const tx = await oft.send(sendParam, { nativeFee, lzTokenFee }, deployer.address, { value: nativeFee })
    console.log(`TX: ${tx.hash}`)
    console.log(`https://arbiscan.io/tx/${tx.hash}`)

    const receipt = await tx.wait()
    console.log(`Gas used: ${receipt.gasUsed.toString()}`)

    const newBalance = await oft.balanceOf(deployer.address)
    console.log(`\nNew balance: ${ethers.utils.formatUnits(newBalance, decimals)} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`Burned: ${ethers.utils.formatUnits(balance.sub(newBalance), decimals)} ${process.env.TOKEN_SYMBOL || 'OFT'}`)
    console.log(`\nTrack: ${getLzScanUrl(tx.hash)}`)
}

function resolveRecipient(dst: string): string {
    switch (dst) {
        case 'sol': case 'solana': return process.env.SOLANA_DEPLOYER_ADDRESS || ''
        case 'stk': case 'starknet': return process.env.STARKNET_ACCOUNT_ADDRESS || ''
        case 'sui': return process.env.SUI_DEPLOYER_ADDRESS || ''
        case 'ton': return process.env.TON_OFT_ADAPTER_HASH || '' // TON uses raw hash as recipient
        default: return ''
    }
}

main().catch((err) => {
    console.error('\nFATAL:', err)
    process.exit(1)
})
