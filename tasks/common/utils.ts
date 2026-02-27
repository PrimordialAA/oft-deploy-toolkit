import { safeFetchMetadataFromSeeds } from '@metaplex-foundation/mpl-token-metadata'
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'

import { OmniPoint } from '@layerzerolabs/devtools'
import { createConnectedContractFactory } from '@layerzerolabs/devtools-evm-hardhat'
import { createSolanaConnectionFactory, createSolanaSignerFactory } from '@layerzerolabs/devtools-solana'
import { createLogger } from '@layerzerolabs/io-devtools'
import { ChainType, EndpointId, endpointIdToChainType, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2'
import { toWeb3Connection } from '@layerzerolabs/lz-solana-sdk-v2/umi'
import { Options } from '@layerzerolabs/lz-v2-utilities'
import { IOApp } from '@layerzerolabs/ua-devtools'
import { createOAppFactory } from '@layerzerolabs/ua-devtools-evm'
import { createOFTFactory } from '@layerzerolabs/ua-devtools-solana'

import type { Umi, PublicKey as UmiPublicKey } from '@metaplex-foundation/umi'

export { createSolanaConnectionFactory }

const logger = createLogger()

type DeploymentMetadata = {
    blockExplorers?: Array<{ url?: string }>
    [key: string]: unknown
}

export const deploymentMetadataUrl = 'https://metadata.layerzero-api.com/v1/metadata/deployments'

export enum MSG_TYPE {
    SEND = 1,
    SEND_AND_CALL = 2,
}

export async function getBlockExplorerLink(srcEid: number, txHash: string): Promise<string | undefined> {
    const network = endpointIdToNetwork(srcEid)
    const res = await fetch(deploymentMetadataUrl)
    if (!res.ok) return
    const all = (await res.json()) as Record<string, DeploymentMetadata>
    const meta = all[network]
    const explorer = meta?.blockExplorers?.[0]?.url
    if (explorer) {
        return `${explorer.replace(/\/+$/, '')}/tx/${txHash}`
    }
    return
}

export const createSdkFactory = (
    userAccount: PublicKey,
    programId: PublicKey,
    connectionFactory = createSolanaConnectionFactory()
) => {
    const evmSdkFactory = createOAppFactory(createConnectedContractFactory())
    const solanaSdkFactory = createOFTFactory(
        () => userAccount,
        () => programId,
        connectionFactory
    )

    return async (point: OmniPoint): Promise<IOApp> => {
        if (endpointIdToChainType(point.eid) === ChainType.SOLANA) {
            return solanaSdkFactory(point)
        } else if (endpointIdToChainType(point.eid) === ChainType.EVM) {
            return evmSdkFactory(point)
        } else {
            logger.error(`Unsupported chain type for EID ${point.eid}`)
            throw new Error(`Unsupported chain type for EID ${point.eid}`)
        }
    }
}

export { createSolanaSignerFactory }

export function uint8ArrayToHex(uint8Array: Uint8Array, prefix = false): string {
    const hexString = Buffer.from(uint8Array).toString('hex')
    return prefix ? `0x${hexString}` : hexString
}

function formatBigIntForDisplay(n: bigint) {
    return n.toLocaleString().replace(/,/g, '_')
}

export function isEmptyOptionsEvm(optionsHex?: string): boolean {
    return !optionsHex || optionsHex === '0x' || optionsHex === '0x0003'
}

export function isEmptyOptionsSolana(optionsBytes?: Uint8Array): boolean {
    if (!optionsBytes) {
        return true
    }
    return Buffer.from(optionsBytes).toString('hex') === '0003'
}

export function decodeLzReceiveOptions(hex: string): string {
    try {
        if (!hex || hex === '0x') return 'No options set'
        const options = Options.fromOptions(hex)
        const lzReceiveOpt = options.decodeExecutorLzReceiveOption()
        return lzReceiveOpt
            ? `gas: ${formatBigIntForDisplay(lzReceiveOpt.gas)} , value: ${formatBigIntForDisplay(lzReceiveOpt.value)} wei`
            : 'No executor options'
    } catch (e) {
        return `Invalid options (${hex.slice(0, 12)}...)`
    }
}

export async function getSolanaUlnConfigPDAs(
    remote: EndpointId,
    connection: Connection,
    ulnAddress: PublicKey,
    oftStore: PublicKey
) {
    const uln = new UlnProgram.Uln(new PublicKey(ulnAddress))
    const sendConfig = uln.getSendConfigState(connection, new PublicKey(oftStore), remote)
    const receiveConfig = uln.getReceiveConfigState(connection, new PublicKey(oftStore), remote)
    return await Promise.all([sendConfig, receiveConfig])
}

export enum SolanaTokenProgramType {
    SPL = 'SPL',
    Token2022 = 'Token2022',
}

type TokenMetadata = {
    updateAuthority?: UmiPublicKey
    isMutable?: boolean
    name?: string
    symbol?: string
}

export async function getSolanaTokenMetadata(
    umi: Umi,
    mint: UmiPublicKey,
    tokenProgramType: SolanaTokenProgramType
): Promise<TokenMetadata> {
    let response
    switch (tokenProgramType) {
        case SolanaTokenProgramType.SPL:
            response = await safeFetchMetadataFromSeeds(umi, { mint })
            return {
                updateAuthority: response?.updateAuthority,
                isMutable: response?.isMutable,
                name: response?.name,
                symbol: response?.symbol,
            }
        case SolanaTokenProgramType.Token2022:
            response = await getTokenMetadata(
                toWeb3Connection(umi.rpc),
                toWeb3JsPublicKey(mint),
                'confirmed',
                TOKEN_2022_PROGRAM_ID
            )
            return {
                updateAuthority: response?.updateAuthority ? fromWeb3JsPublicKey(response?.updateAuthority) : undefined,
                isMutable: response?.updateAuthority != PublicKey.default,
                name: response?.name,
                symbol: response?.symbol,
            }
        default:
            throw new Error(`Unsupported token program type: ${tokenProgramType}`)
    }
}

export { createLogger, DebugLogger, KnownErrors, KnownOutputs, KnownWarnings } from '@layerzerolabs/io-devtools'
