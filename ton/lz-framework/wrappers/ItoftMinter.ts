import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
} from '@ton/core'

export type ItoftMinterConfig = {
    totalSupply: bigint
    adminAddress: Address
    content: Cell
    jettonWalletCode: Cell
}

export function itoftMinterConfigToCell(config: ItoftMinterConfig): Cell {
    return beginCell()
        .storeCoins(config.totalSupply)
        .storeAddress(config.adminAddress)
        .storeRef(config.content)
        .storeRef(config.jettonWalletCode)
        .endCell()
}

/**
 * Build on-chain metadata content cell for ITOFT Jetton.
 * Uses TEP-64 on-chain format (tag = 0x00).
 */
/**
 * Build on-chain metadata content cell for Jetton.
 * Reads TOKEN_NAME, TOKEN_SYMBOL, TOKEN_METADATA_URI from env vars.
 *
 * If TOKEN_METADATA_URI is set, uses off-chain format (tag 0x01 + URI).
 * Otherwise, uses off-chain format with a placeholder URI.
 */
export function buildItoftContent(): Cell {
    const metadataUri = process.env.TOKEN_METADATA_URI
    if (metadataUri) {
        return beginCell()
            .storeUint(0x01, 8) // off-chain content tag
            .storeStringTail(metadataUri)
            .endCell()
    }

    // Fallback: off-chain format with placeholder
    const tokenName = process.env.TOKEN_NAME || 'OFT'
    return beginCell()
        .storeUint(0x01, 8) // off-chain content tag
        .storeStringTail(`https://example.com/metadata/${tokenName.toLowerCase()}.json`)
        .endCell()
}

export class ItoftMinter implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new ItoftMinter(address)
    }

    static createFromConfig(
        config: ItoftMinterConfig,
        code: Cell,
        workchain = 0
    ) {
        const data = itoftMinterConfigToCell(config)
        const init = { code, data }
        return new ItoftMinter(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    /**
     * Send a mint message (only admin can mint).
     * @param to - recipient address
     * @param jettonAmount - amount of ITOFT to mint (in shared decimals, 6 decimal places)
     * @param forwardTonAmount - TON to forward for wallet creation
     */
    async sendMint(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            queryId?: number
            toAddress: Address
            jettonAmount: bigint
            forwardTonAmount: bigint
        }
    ) {
        const masterMsg = beginCell()
            .storeUint(0x178d4519, 32) // internal_transfer
            .storeUint(opts.queryId ?? 0, 64)
            .storeCoins(opts.jettonAmount)
            .storeUint(0, 2) // from_address = addr_none
            .storeUint(0, 2) // response_address = addr_none
            .storeCoins(opts.forwardTonAmount)
            .storeUint(0, 1) // empty forward_payload
            .endCell()

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x642b7d07, 32) // op::mint
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.toAddress)
                .storeCoins(opts.forwardTonAmount)
                .storeRef(masterMsg)
                .endCell(),
        })
    }

    /**
     * Change admin (transfer minting authority to OFT adapter).
     */
    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            queryId?: number
            newAdmin: Address
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(3, 32) // op: change_admin
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.newAdmin)
                .endCell(),
        })
    }

    /**
     * Get Jetton master data.
     */
    async getJettonData(provider: ContractProvider) {
        const result = await provider.get('get_jetton_data', [])
        return {
            totalSupply: result.stack.readBigNumber(),
            mintable: result.stack.readBoolean(),
            adminAddress: result.stack.readAddress(),
            content: result.stack.readCell(),
            walletCode: result.stack.readCell(),
        }
    }

    /**
     * Get Jetton wallet address for an owner.
     */
    async getWalletAddress(
        provider: ContractProvider,
        ownerAddress: Address
    ) {
        const result = await provider.get('get_wallet_address', [
            {
                type: 'slice',
                cell: beginCell().storeAddress(ownerAddress).endCell(),
            },
        ])
        return result.stack.readAddress()
    }
}
