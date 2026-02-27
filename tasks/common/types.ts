import { PublicKey } from '@solana/web3.js'
import { CLIArgumentType } from 'hardhat/types'

export const publicKey: CLIArgumentType<PublicKey> = {
    name: 'publicKey',
    parse(_name: string, value: string) {
        return new PublicKey(value)
    },
    validate() {},
}
