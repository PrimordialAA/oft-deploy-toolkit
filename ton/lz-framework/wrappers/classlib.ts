/**
 * TypeScript implementation of the FunC++ classlib storage encoder.
 *
 * Replicates the cl::declare() function from src/funC++/classlib.fc
 * to build properly formatted classlib storage cells for contract deployment.
 *
 * The classlib format stores typed fields with a header containing metadata
 * (type, cell index, data offset, ref offset) for each field, enabling
 * efficient field access by index.
 */
import { beginCell, Builder, Cell, Address, toNano, contractAddress } from '@ton/core'

// Re-export @ton/core types so deploy scripts use the SAME module instance.
// This avoids "Invalid argument" errors from Cell instanceof checks across
// different @ton/core installations (root vs ton/lz-framework).
export { beginCell, Cell, Address, toNano, contractAddress } from '@ton/core'
export { mnemonicToWalletKey } from '@ton/crypto'
export { TonClient, WalletContractV4, internal } from '@ton/ton'

// ===== Type constants (must match classlib.fc) =====
export const CL_TYPE = {
    BOOL: 0,
    UINT8: 3,
    UINT16: 4,
    UINT32: 5,
    UINT64: 6,
    COINS: 7,     // fixed-width uint128
    UINT256: 8,
    ADDRESS: 8,   // same as uint256
    CELL_REF: 9,
    DICT256: 9,   // same as cellRef
    OBJ_REF: 9,   // same as cellRef
} as const

// ===== Layout constants (must match classlib.fc) =====
const MAX_NAME_LEN = 10
const NAME_WIDTH = MAX_NAME_LEN * 8 // 80 bits
const FIELD_TYPE_WIDTH = 4
const CELL_ID_WIDTH = 2
const DATA_OFFSET_WIDTH = 10
const REF_OFFSET_WIDTH = 2
const FIELD_INFO_WIDTH = FIELD_TYPE_WIDTH + CELL_ID_WIDTH + DATA_OFFSET_WIDTH + REF_OFFSET_WIDTH // 18
const MAX_CLASS_FIELDS = 15
const HEADER_WIDTH = NAME_WIDTH + MAX_CLASS_FIELDS * FIELD_INFO_WIDTH // 350
const MAX_CELL_BITS = 1023
const MAX_CELL_REFS = 4

/** Field definition: [type, value] */
export type ClField =
    | { type: 0; value: boolean }          // bool
    | { type: 3; value: number | bigint }   // uint8
    | { type: 4; value: number | bigint }   // uint16
    | { type: 5; value: number | bigint }   // uint32
    | { type: 6; value: number | bigint }   // uint64
    | { type: 7; value: bigint }            // coins (uint128)
    | { type: 8; value: bigint }            // uint256/address
    | { type: 9; value: Cell }              // cellRef/dict256/objRef

/** Helper to get the bit width for a field type */
function getTypeWidth(clType: number): number {
    if (clType <= CL_TYPE.UINT256) {
        return 1 << clType // type values are set up so 2^type = width
    }
    return 0 // ref types have 0 data bits
}

/**
 * Convert a string name (up to 10 chars) to a BigInt for classlib name field.
 * Equivalent to FunC "string"u syntax.
 */
export function stringToName(name: string): bigint {
    if (name.length > MAX_NAME_LEN) {
        throw new Error(`Name "${name}" exceeds ${MAX_NAME_LEN} char limit`)
    }
    let result = 0n
    for (let i = 0; i < name.length; i++) {
        result = (result << 8n) | BigInt(name.charCodeAt(i))
    }
    return result
}

/**
 * Create an empty classlib null object (= empty cell).
 * Equivalent to cl::nullObject() in FunC.
 */
export function clNullObject(): Cell {
    return new Cell()
}

/**
 * Create an empty dict256 (= empty cell).
 * Equivalent to cl::dict256::New() in FunC.
 */
export function clNewDict256(): Cell {
    return new Cell()
}

/**
 * Build a classlib storage cell.
 * Replicates cl::declare(name, fields) from classlib.fc exactly.
 *
 * @param name - Class name as a string (e.g., "baseStore", "baseOApp", "oftAdapter")
 * @param fields - Array of field definitions
 * @returns The classlib storage cell
 */
export function clDeclare(name: string, fields: ClField[]): Cell {
    const nameInt = stringToName(name)
    const numFields = fields.length

    if (numFields > MAX_CLASS_FIELDS) {
        throw new Error(`Too many fields: ${numFields} > ${MAX_CLASS_FIELDS}`)
    }

    // Initialize cell builders: index 0 = unused, index 1 = root cell builder
    const cellBuilders: Builder[] = [beginCell(), beginCell()] // [unused, root]

    // Start building header
    let headerBits: { type: number; cellId: number; dataOffset: number; refOffset: number }[] = []

    // Tracking variables
    let curDataCell = 1
    let curRefCell = 1
    let curCellMaxRefs = 2 // Root cell allows only 2 refs
    let curDataOffset = HEADER_WIDTH // Data starts after header
    let curRefOffset = 0

    for (let i = 0; i < numFields; i++) {
        const field = fields[i]
        const fieldType = field.type
        const fieldBits = getTypeWidth(fieldType)

        if (fieldBits > 0) {
            // Data field: check if it fits in current cell
            if (curDataOffset + fieldBits > MAX_CELL_BITS) {
                curDataCell += 1
                curDataOffset = 0
                if (curDataCell >= cellBuilders.length) {
                    cellBuilders.push(beginCell())
                }
            }
        } else {
            // Ref field: check if current cell has space
            if (curRefOffset + 1 > curCellMaxRefs) {
                curRefCell += 1
                curRefOffset = 0
                curCellMaxRefs = MAX_CELL_REFS
                if (curRefCell >= cellBuilders.length) {
                    cellBuilders.push(beginCell())
                }
            }
        }

        // Store field value
        if (fieldType <= CL_TYPE.UINT256) {
            // Numeric type: store as uint
            const val = field.type === 0
                ? (field.value ? 1n : 0n)
                : BigInt(field.value as number | bigint)
            cellBuilders[curDataCell] = cellBuilders[curDataCell].storeUint(
                val < 0n ? -val : val,
                fieldBits
            )
        } else {
            // Ref type: store as cell reference
            cellBuilders[curRefCell] = cellBuilders[curRefCell].storeRef(
                field.value as Cell
            )
        }

        // Build field metadata
        if (fieldBits > 0) {
            headerBits.push({
                type: fieldType,
                cellId: curDataCell === 1 ? 0 : curDataCell,
                dataOffset: curDataOffset,
                refOffset: 3, // sentinel value for data fields
            })
            curDataOffset += fieldBits
        } else {
            headerBits.push({
                type: fieldType,
                cellId: curRefCell === 1 ? 0 : curRefCell,
                dataOffset: MAX_CELL_BITS, // sentinel for ref fields
                refOffset: curRefOffset,
            })
            curRefOffset += 1
        }
    }

    // Build the header cell
    let header = beginCell()
    header = header.storeUint(nameInt, NAME_WIDTH)

    // Store field metadata
    for (const info of headerBits) {
        header = header
            .storeUint(info.type, FIELD_TYPE_WIDTH)
            .storeUint(info.cellId, CELL_ID_WIDTH)
            .storeUint(info.dataOffset, DATA_OFFSET_WIDTH)
            .storeUint(info.refOffset, REF_OFFSET_WIDTH)
    }

    // Pad remaining field slots with 1s
    const headerBitsSoFar = NAME_WIDTH + numFields * FIELD_INFO_WIDTH
    const paddingBits = HEADER_WIDTH - headerBitsSoFar
    if (paddingBits > 0) {
        // Store all 1s for padding (unused field slots)
        // Each bit is 1
        for (let i = 0; i < paddingBits; i++) {
            header = header.storeBit(1)
        }
    }

    // Get root builder and count cells
    const rootBuilder = cellBuilders[1]
    const numCells = cellBuilders.length - 1

    // For multi-cell objects, pad root refs to exactly 2
    if (numCells > 1) {
        const rootRefs = rootBuilder.refs
        if (rootRefs === 0) {
            rootBuilder.storeRef(new Cell()).storeRef(new Cell())
        } else if (rootRefs === 1) {
            rootBuilder.storeRef(new Cell())
        }
    }

    // Combine header + root data/refs
    header = header.storeBuilder(rootBuilder)

    // Add overflow cells as refs
    if (numCells === 1) {
        return header.endCell()
    }
    if (numCells === 2) {
        return header.storeRef(cellBuilders[2].endCell()).endCell()
    }
    return header
        .storeRef(cellBuilders[2].endCell())
        .storeRef(cellBuilders[3].endCell())
        .endCell()
}

// ===== Pre-built storage constructors =====

/**
 * Build BaseStorage::New(owner) classlib cell.
 */
export function baseStorageNew(owner: bigint): Cell {
    return clDeclare('baseStore', [
        { type: CL_TYPE.ADDRESS, value: owner },           // owner
        { type: CL_TYPE.BOOL, value: false },               // authenticated
        { type: CL_TYPE.BOOL, value: false },               // initialized
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },   // initialStorage
    ])
}

/**
 * Build Endpoint::New(eid, dstEid, owner) classlib cell.
 */
export function endpointNew(eid: number, dstEid: number, owner: bigint): Cell {
    return clDeclare('endpoint', [
        { type: CL_TYPE.OBJ_REF, value: baseStorageNew(owner) }, // baseStorage
        { type: CL_TYPE.UINT32, value: eid },                     // eid
        { type: CL_TYPE.UINT32, value: dstEid },                  // dstEid
        { type: CL_TYPE.DICT256, value: clNewDict256() },          // msglibs
        { type: CL_TYPE.UINT8, value: 0 },                        // numMsglibs
        { type: CL_TYPE.CELL_REF, value: new Cell() },            // channelCode
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },         // channelStorageInit
        { type: CL_TYPE.ADDRESS, value: 0n },                     // defaultSendMsglibManager (NULLADDRESS)
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },         // defaultSendLibInfo
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },         // defaultReceiveLibInfo
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },         // defaultTimeoutReceiveLibInfo
        { type: CL_TYPE.UINT64, value: 0n },                      // defaultExpiry
    ])
}

const BASE_LZ_RECEIVE_GAS = 100000n

/**
 * Build BaseOApp::New(controllerAddress, eid, endpointCode, channelCode) classlib cell.
 */
export function baseOAppNew(
    controllerAddress: bigint,
    eid: number,
    endpointCode: Cell,
    channelCode: Cell
): Cell {
    return clDeclare('baseOApp', [
        { type: CL_TYPE.ADDRESS, value: controllerAddress },     // controllerAddress
        { type: CL_TYPE.UINT32, value: eid },                    // eid
        { type: CL_TYPE.DICT256, value: clNewDict256() },         // maxReceivedNonce
        { type: CL_TYPE.COINS, value: BASE_LZ_RECEIVE_GAS },     // baseLzReceiveGas
        { type: CL_TYPE.DICT256, value: clNewDict256() },         // peers
        { type: CL_TYPE.DICT256, value: clNewDict256() },         // enforcedOptions
        { type: CL_TYPE.ADDRESS, value: 0n },                    // tentativeOwner (NULLADDRESS)
        { type: CL_TYPE.CELL_REF, value: endpointCode },         // endpointCode
        { type: CL_TYPE.CELL_REF, value: channelCode },          // channelCode
        { type: CL_TYPE.OBJ_REF, value: endpointNew(eid, 0, controllerAddress) }, // endpointInitStorage
    ])
}

/**
 * Build OftAdapter::New(owner, controllerAddress, eid, jettonMasterAddress, endpointCode, channelCode)
 * classlib cell. This is the main storage for the OFT Adapter contract.
 */
export function oftAdapterNew(
    owner: bigint,
    controllerAddress: bigint,
    eid: number,
    jettonMasterAddress: bigint,
    endpointCode: Cell,
    channelCode: Cell
): Cell {
    return clDeclare('oftAdapter', [
        { type: CL_TYPE.OBJ_REF, value: baseStorageNew(owner) },
        { type: CL_TYPE.OBJ_REF, value: baseOAppNew(controllerAddress, eid, endpointCode, channelCode) },
        { type: CL_TYPE.ADDRESS, value: jettonMasterAddress },
    ])
}

// ===== Message data constructors =====

/**
 * Build md::Deploy::New(initialDeposit, dstEid, dstOApp).
 * FunC name: "deploy"u
 * Used for DeployChannel handler.
 */
export function mdDeployNew(initialDeposit: bigint, dstEid: number, dstOApp: bigint): Cell {
    return clDeclare('deploy', [
        { type: CL_TYPE.COINS, value: initialDeposit },   // initialDeposit
        { type: CL_TYPE.UINT32, value: dstEid },           // dstEid
        { type: CL_TYPE.ADDRESS, value: dstOApp },         // dstOApp
        { type: CL_TYPE.OBJ_REF, value: clNullObject() },  // extraInfo
    ])
}

/**
 * Build md::MdAddress::New($md, address).
 * FunC name: "MdAddr"u
 * Used for DeployConnection handler.
 */
export function mdMdAddressNew(md: Cell, address: bigint): Cell {
    return clDeclare('MdAddr', [
        { type: CL_TYPE.OBJ_REF, value: md },       // md
        { type: CL_TYPE.ADDRESS, value: address },   // address
    ])
}

/**
 * Build md::SetPeer::New(eid, peer).
 * FunC name: "setPeer"u
 */
export function mdSetPeerNew(eid: number, peer: bigint): Cell {
    return clDeclare('setPeer', [
        { type: CL_TYPE.UINT32, value: eid },    // eid
        { type: CL_TYPE.ADDRESS, value: peer },   // peer
    ])
}

/**
 * Build md::OptionsV1::New(lzReceiveGas, lzReceiveValue, nativeDropAddress, nativeDropAmount).
 * FunC name: "OptionsV1"u
 */
export function mdOptionsV1New(
    lzReceiveGas: bigint,
    lzReceiveValue: bigint,
    nativeDropAddress: bigint,
    nativeDropAmount: bigint
): Cell {
    return clDeclare('OptionsV1', [
        { type: CL_TYPE.UINT256, value: lzReceiveGas },        // lzReceiveGas
        { type: CL_TYPE.UINT256, value: lzReceiveValue },      // lzReceiveValue
        { type: CL_TYPE.ADDRESS, value: nativeDropAddress },    // nativeDropAddress
        { type: CL_TYPE.UINT256, value: nativeDropAmount },     // nativeDropAmount
    ])
}

/**
 * Build md::OptionsExtended::New(eid, msgType, $options).
 * FunC name: "OptionsExt"u
 */
export function mdOptionsExtendedNew(eid: number, msgType: number, options: Cell): Cell {
    return clDeclare('OptionsExt', [
        { type: CL_TYPE.UINT32, value: eid },        // eid
        { type: CL_TYPE.UINT32, value: msgType },     // msgType
        { type: CL_TYPE.OBJ_REF, value: options },    // options
    ])
}

/**
 * Build md::OftSend::New(dstEid, recipientBytes32, amountSD, nativeFee, zroFee, extraOptions).
 * FunC name: "oftSend"u
 */
export function mdOftSendNew(
    dstEid: number,
    recipientBytes32: bigint,
    amountSD: bigint,
    nativeFee: bigint,
    zroFee: bigint,
    extraOptions: Cell
): Cell {
    return clDeclare('oftSend', [
        { type: CL_TYPE.UINT32, value: dstEid },                  // dstEid
        { type: CL_TYPE.ADDRESS, value: recipientBytes32 },        // recipientBytes32
        { type: CL_TYPE.UINT64, value: amountSD },                 // amountSD
        { type: CL_TYPE.COINS, value: nativeFee },                 // nativeFee
        { type: CL_TYPE.COINS, value: zroFee },                    // zroFee
        { type: CL_TYPE.OBJ_REF, value: extraOptions },            // extraOptions
    ])
}
