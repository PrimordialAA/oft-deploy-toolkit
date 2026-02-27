import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core'
import {
    oftAdapterNew,
    mdDeployNew,
    mdMdAddressNew,
    mdSetPeerNew,
    mdOptionsExtendedNew,
    mdOptionsV1New,
    mdOftSendNew,
    clNullObject,
} from './classlib'

/**
 * FunC CRC32 opcodes — computed from the string constants in FunC source.
 * "string"c in FunC = CRC32(utf8_bytes(string))
 */
export const OPS = {
    INITIALIZE: 0xf65ce988,       // "BaseInterface::OP::INITIALIZE"c
    SET_PEER: 0x5df77d23,         // "OP::SetPeer"c
    DEPLOY_CHANNEL: 0x70ead753,   // "OP::DeployChannel"c
    SET_ENFORCED_OPTIONS: 0x0075a62d, // "OP::SetEnforcedOptions"c
    SEND_OFT: 0x73b696eb,        // "OftAdapter::OP::SEND_OFT"c
    DEPLOY_CONNECTION: 0xdd1fdfdb, // "OP::DeployConnection"c
    SET_LZ_CONFIG: 0x82801010,    // "OP::SetLzConfig"c
} as const

/**
 * OftAdapter TypeScript wrapper for deployment and interaction.
 *
 * The FunC++ OApp uses classlib storage format. Initial data is built
 * via the classlib.ts encoder (replicates cl::declare in TypeScript).
 *
 * Deployment: single TX with stateInit + INITIALIZE body.
 */
export class OftAdapter implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {}

    static createFromAddress(address: Address) {
        return new OftAdapter(address)
    }

    /**
     * Create a new OftAdapter for deployment with proper classlib storage.
     */
    static createFromConfig(
        code: Cell,
        owner: bigint,
        controllerAddress: bigint,
        eid: number,
        jettonMasterAddress: bigint,
        endpointCode: Cell,
        channelCode: Cell,
        workchain = 0
    ) {
        const data = oftAdapterNew(owner, controllerAddress, eid, jettonMasterAddress, endpointCode, channelCode)
        const init = { code, data }
        return new OftAdapter(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    /**
     * Send INITIALIZE message.
     * Can be combined with deploy (stateInit) in one TX.
     * Format: [opcode:32][queryId:64][donationNanos:coins]
     */
    async sendInitialize(
        provider: ContractProvider,
        via: Sender,
        value: bigint
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.INITIALIZE, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .endCell(),
        })
    }

    /**
     * Set peer address for a remote chain.
     * md = classlib md::SetPeer {eid: uint32, peer: uint256}
     */
    async sendSetPeer(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            eid: number
            peerAddress: bigint
        }
    ) {
        const md = mdSetPeerNew(opts.eid, opts.peerAddress)

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.SET_PEER, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })
    }

    /**
     * Deploy a channel for a remote chain.
     * md = classlib md::Deploy {initialDeposit: coins, dstEid: uint32, dstOApp: uint256, extraInfo: objRef}
     */
    async sendDeployChannel(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            dstEid: number
        }
    ) {
        const md = mdDeployNew(0n, opts.dstEid, 0n)

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.DEPLOY_CHANNEL, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })
    }

    /**
     * Deploy a connection (ULN) for a channel.
     * md = classlib md::MdAddress {md: objRef(Deploy), address: uint256}
     * The address is the MsglibManager address.
     */
    async sendDeployConnection(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            dstEid: number
            msglibManagerAddress: bigint
        }
    ) {
        const deploy = mdDeployNew(0n, opts.dstEid, 0n)
        const md = mdMdAddressNew(deploy, opts.msglibManagerAddress)

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.DEPLOY_CONNECTION, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })
    }

    /**
     * Set enforced options for a destination.
     * md = classlib md::OptionsExtended {eid: uint32, msgType: uint32, options: objRef(OptionsV1)}
     */
    async sendSetEnforcedOptions(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            eid: number
            msgType: number
            lzReceiveGas: bigint
            lzReceiveValue: bigint
        }
    ) {
        const options = mdOptionsV1New(
            opts.lzReceiveGas,
            opts.lzReceiveValue,
            0n, // nativeDropAddress
            0n  // nativeDropAmount
        )
        const md = mdOptionsExtendedNew(opts.eid, opts.msgType, options)

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.SET_ENFORCED_OPTIONS, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })
    }

    /**
     * Send OFT tokens to a remote chain.
     * md = classlib md::OftSend {dstEid, recipientBytes32, amountSD, nativeFee, zroFee, extraOptions}
     */
    async sendSendOft(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            dstEid: number
            recipientBytes32: bigint
            amountSD: bigint
            nativeFee: bigint
            zroFee?: bigint
        }
    ) {
        const md = mdOftSendNew(
            opts.dstEid,
            opts.recipientBytes32,
            opts.amountSD,
            opts.nativeFee,
            opts.zroFee ?? 0n,
            clNullObject() // empty extra options
        )

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPS.SEND_OFT, 32)
                .storeUint(0, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })
    }
}
