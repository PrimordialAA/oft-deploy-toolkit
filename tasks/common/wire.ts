import { PublicKey } from '@solana/web3.js'
import { subtask, task } from 'hardhat/config'

import { firstFactory } from '@layerzerolabs/devtools'
import { SUBTASK_LZ_SIGN_AND_SEND, types as devtoolsTypes } from '@layerzerolabs/devtools-evm-hardhat'
import { setTransactionSizeBuffer } from '@layerzerolabs/devtools-solana'
import { type LogLevel, createLogger } from '@layerzerolabs/io-devtools'
import { DebugLogger, KnownErrors } from '@layerzerolabs/io-devtools'
import { ChainType, endpointIdToChainType } from '@layerzerolabs/lz-definitions'
import { type IOApp, type OAppConfigurator, type OAppOmniGraph, configureOwnable } from '@layerzerolabs/ua-devtools'
import {
    SUBTASK_LZ_OAPP_WIRE_CONFIGURE,
    type SubtaskConfigureTaskArgs,
    TASK_LZ_OAPP_WIRE,
    TASK_LZ_OWNABLE_TRANSFER_OWNERSHIP,
} from '@layerzerolabs/ua-devtools-evm-hardhat'

import { deriveConnection, getSolanaDeployment, useWeb3Js } from '../solana'
import { findSolanaEndpointIdInGraph, validateSigningAuthority } from '../solana/utils'

import { publicKey as publicKeyType } from './types'
import {
    createSdkFactory,
    createSolanaConnectionFactory,
    createSolanaSignerFactory,
    getSolanaUlnConfigPDAs,
} from './utils'

import type { SignAndSendTaskArgs } from '@layerzerolabs/devtools-evm-hardhat/tasks'

interface Args {
    logLevel: LogLevel
    multisigKey?: PublicKey
    isSolanaInitConfig: boolean
    oappConfig: string
    internalConfigurator?: OAppConfigurator
    dryRun?: boolean
}

task(TASK_LZ_OAPP_WIRE)
    .addParam('multisigKey', 'The MultiSig key', undefined, publicKeyType, true)
    .addParam('internalConfigurator', 'FOR INTERNAL USE ONLY', undefined, devtoolsTypes.fn, true)
    .addParam('isSolanaInitConfig', 'FOR INTERNAL USE ONLY', undefined, devtoolsTypes.boolean, true)
    .setAction(async (args: Args, hre, runSuper) => {
        const logger = createLogger(args.logLevel)

        setTransactionSizeBuffer(192)

        const keypair = (await useWeb3Js()).web3JsKeypair
        const userAccount = keypair.publicKey

        const solanaEid = await findSolanaEndpointIdInGraph(hre, args.oappConfig)
        const solanaDeployment = getSolanaDeployment(solanaEid)

        const { umi, connection } = await deriveConnection(solanaEid, true)
        const { warnings } = await validateSigningAuthority(
            umi,
            connection,
            solanaDeployment.oftStore,
            userAccount,
            args.multisigKey
        )
        warnings.forEach((w) => logger.warn(w))

        const programId = new PublicKey(solanaDeployment.programId)

        if (!programId) {
            logger.error('Missing programId in solana deployment')
            return
        }
        const configurator = args.internalConfigurator

        const connectionFactory = createSolanaConnectionFactory()
        const sdkFactory = createSdkFactory(userAccount, programId, connectionFactory)
        const solanaSignerFactory = createSolanaSignerFactory(keypair, connectionFactory, args.multisigKey)

        subtask(
            SUBTASK_LZ_OAPP_WIRE_CONFIGURE,
            'Configure OFT',
            async (subtaskArgs: SubtaskConfigureTaskArgs<OAppOmniGraph, IOApp>, _hre, runSuper) => {
                if (!args.isSolanaInitConfig && !args.dryRun) {
                    logger.verbose('Running pre-wiring checks...')
                    const { graph } = subtaskArgs
                    for (const connection of graph.connections) {
                        if (endpointIdToChainType(connection.vector.from.eid) === ChainType.SOLANA) {
                            if (connection.config?.sendLibrary) {
                                const BLOCKED_MESSAGE_LIB_SOLANA_MAINNET =
                                    '2XrYqmhBMPJgDsb4SVbjV1PnJBprurd5bzRCkHwiFCJB'
                                const BLOCKED_MESSAGE_LIB_SOLANA_TESTNET =
                                    '2XrYqmhBMPJgDsb4SVbjV1PnJBprurd5bzRCkHwiFCJB'
                                const sendLibraryAddress = connection.config.sendLibrary

                                if (
                                    sendLibraryAddress === BLOCKED_MESSAGE_LIB_SOLANA_MAINNET ||
                                    sendLibraryAddress === BLOCKED_MESSAGE_LIB_SOLANA_TESTNET
                                ) {
                                    logger.verbose(
                                        `Skipping ULN config checks for BlockedMessageLib on ${connection.vector.from.eid}`
                                    )
                                    continue
                                }

                                logger.verbose('Send library found. Checking if ULN configs have been initialized...')

                                try {
                                    await getSolanaUlnConfigPDAs(
                                        connection.vector.to.eid,
                                        await connectionFactory(connection.vector.from.eid),
                                        new PublicKey(connection.config.sendLibrary),
                                        new PublicKey(connection.vector.from.address)
                                    )

                                    logger.verbose(
                                        `ULN configs checked successfully for ${connection.vector.from.eid} -> ${connection.vector.to.eid}`
                                    )
                                } catch (error) {
                                    logger.verbose(`Error checking ULN configs: ${error}`)
                                    DebugLogger.printErrorAndFixSuggestion(
                                        KnownErrors.ULN_INIT_CONFIG_SKIPPED,
                                        `ULN configs on ${connection.vector.from.eid} not initialized for remote ${connection.vector.to.eid}.`
                                    )
                                    throw new Error('ULN configs not initialized. Please run init-config task first.')
                                }
                            } else {
                                logger.debug(
                                    `No sendLibrary found in connection config for ${connection.vector.from.eid} -> ${connection.vector.to.eid}`
                                )
                            }
                        }
                    }
                }

                return runSuper({
                    ...subtaskArgs,
                    configurator: configurator ?? subtaskArgs.configurator,
                    sdkFactory,
                    graph: {
                        ...subtaskArgs.graph,
                        contracts: subtaskArgs.graph.contracts.filter((contract) => {
                            const chainType = endpointIdToChainType(contract.point.eid)
                            return chainType !== ChainType.APTOS && chainType !== ChainType.INITIA
                        }),
                        connections: subtaskArgs.graph.connections.filter((connection) => {
                            const fromChainType = endpointIdToChainType(connection.vector.from.eid)
                            return fromChainType !== ChainType.APTOS && fromChainType !== ChainType.INITIA
                        }),
                    },
                })
            }
        )

        subtask(SUBTASK_LZ_SIGN_AND_SEND, 'Sign OFT transactions', (args: SignAndSendTaskArgs, _hre, runSuper) =>
            runSuper({
                ...args,
                createSigner: firstFactory(solanaSignerFactory, args.createSigner),
            })
        )

        return runSuper(args)
    })

task(TASK_LZ_OWNABLE_TRANSFER_OWNERSHIP)
    .addParam('multisigKey', 'The MultiSig key', undefined, publicKeyType, true)
    .setAction(async (args: Args, hre) => {
        return hre.run(TASK_LZ_OAPP_WIRE, { ...args, internalConfigurator: configureOwnable })
    })
