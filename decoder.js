/*
Copyright (c) 2023 Firmware Modules Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/* Measurement{Earth} (Enhanced/Earth) Low Power Protocol (ELPP)
 * 
 * This protocol is designed to meet multiple objectives:
 *   - minimize payload sizes by supporting bitfields
 *   - transport agnostic (LoRaWAN, satellite, IP)
 *   - cloud platform agnostic
 *   - support for blockchain ABIs (in particular, Antelope, on which the Measurement{Earth} IoT platform is built)
 *   - firmware update protocol that works with any transport
 */

/* Notes:
 *   - This decoder is meant to work with all javascript engines 
 *     embedded inside cloud platforms.
 *     Some of these engines don't support 'let' or 'const' or have basic Node
 *     classes available like 'Buffer'.
 *     
 *   - Type decoders consume input data in multiples of bits, but the the channel byte
 *     must exist on a byte boundary.  The type decoders are packed to fit mutiples of whole bytes.
 *     
 *   - Decoders can be layered, i.e. decoders can reference other type decoders not
 *     just primitive decoder functions, effectively forming an 'ABI' made from subtypes.
 *     
 *   - This is LITTLE ENDIAN protocol.  The lowest byte of a (u)int16, (var)(u)int32 appears first in the payload buffer.
 *     Bitfields are exempt, however, and are stored in 'natural bit order' with the left-most bit being the most significant bit.
 *     
 * How to use:
 * 
 *   1. Select a platform decoder (e.g. decoder_datacake.js) and copy and paste it into the
 *      first half of your platform's 'payload decoder' section.
 *   2. Copy and paste everything below this up until the ---- CUT ----- line into
 *      the bottom half of your platforms 'payload decoder' section.
 *   3. Embed a call to the 'decoder' function within the platform's 'payloader decoder' 
 *      main function call, extracting the actual payload bytes as necessary 
 *      and passing them to decoder(bytes, map, platform).
 */

var DO_DEBUG = true
var DO_TRACE = true

function TRACE(msg) {
    if (DO_TRACE) {
        console.log(msg)
    }
}

function TRACE_D(msg) {
    if (DO_DEBUG) {
        console.log(msg)
    }
}


function ERROR(msg) {
    if (DO_DEBUG) {
        console.log('ERR: ' + msg)
    }
}

/* Primitive type decoders:
 * bitfield
 * name
 * fixed_array
 * 
 * 
 * Decoders accept a byte buffer, a bit index, an array to push decoded output data to which
 * is eventually passed to the user's decoder processor function, and an optional object
 * of arguments.
 * 
 * Decoders return number of bits consumed, or -1 on decoder error.
 * */

var RESULT_OK = 0
var RESULT_ERROR = -1
var RESULT_NOT_ALIGNED = -2
var RESULT_CHANNEL_NOT_FOUND = -3


/*--- Primitive Decoders ----------------------------------------------------*/

/* Set on_boundary to 1 to enforce bit_index being on a byte boundary */
function check_len(buf, bit_index, bitn, on_boundary) {
    return (buf.length << 3) >= (bit_index + bitn) && (!on_boundary || (on_boundary && ((bit_index & 0x7) == 0)))
}

function capture_bits(buf, start_bit, end_bit) {
    /* Setup indices */
    var nbits = end_bit - start_bit + 1
    var byte_start = (start_bit / 8) >> 0
    var bit_start = (start_bit % 8) >> 0
    var byte_end = (end_bit / 8) >> 0
    var bit_end = (end_bit % 8) >> 0

    TRACE_D('capture: ' + nbits + ' byte_start ' + byte_start + ' bit_start ' + bit_start + ' byte_end ' + byte_end + ' bit_end ' + bit_end)

    /* Case 1: start and end bit land within same byte */
    if (byte_start == byte_end) {
        var bits = buf[byte_start]
        bits <<= bit_start /* 0,1,2.. */
        bits &= 0xff
        bits >>= (bit_start + (7 - bit_end)) /* ..5,6,7 */
        TRACE_D('  B' + byte_start + ' bits ' + bits.toString(16))
        return bits
    } /* Case 2: start and end bits land on different bytes */
    else {
        /* Capture bits from first byte */
        var bits = buf[byte_start]
        bits <<= bit_start
        bits &= 0xff
        bits >>= bit_start
        /* 'consume' bits from total */
        nbits -= (8 - bit_start)
        /* Place bits into correct place in output word */
        var word = bits << (nbits)
        TRACE_D('  B' + byte_start + ' bits ' + bits.toString(16) + ' word ' + word.toString(16))
        /* Capture whole bytes between */
        for (var i = byte_start + 1; i < byte_end; i++) {
            nbits -= 8
            word |= (buf[i] << nbits)
            TRACE_D('  B' + i + ' word ' + word.toString(16))
        }
        /* Capture last byte */
        bits = buf[byte_end]
        bits &= 0xff
        bits >>= (7 - bit_end)
        /* 'consume' bits from total */
        nbits -= (bit_end + 1)
        /* Place bits into correct place in output word */
        word |= bits << (nbits)
        TRACE_D('  B' + byte_end + ' bits ' + bits.toString(16) + ' word ' + word.toString(16) + ' nbits ' + nbits)

        return word
    }
}

function bitfield_decoder(buf, bit_index, out, args) {
    if (args) {
        var bitn = args.i_bits + args.f_bits
        if (check_len(buf, bit_index, bitn, 0)) {
            var value = capture_bits(buf, bit_index, bit_index + bitn - 1)
            if (args.sign) {
                var shift = 32 - bitn
                value = value << shift >> shift
            }
            value /= (1 << args.f_bits)
            out.push(value)
            return bitn
        }
    }
    return -1
}

function varuint32_decoder(buf, bit_index, out) {
    var val = 0
    var bit = 0
    var bit_count = 0
    while (check_len(buf, bit_index, 8, 1)) {
        var b = buf[bit_index >> 3]
        val |= (b & 0x7f) << bit
        bit += 7

        bit_index += 8
        bit_count += 8

        if (!(b & 0x80)) {
            break
        }
    }
    out.push(val)
    return bit_count
}

function varint32_decoder(buf, bit_index, out) {
    var bit_count = varuint32_decoder(buf, bit_index, out)
    if (bit_count > 0) {
        var val = out[out.length - 1]
        TRACE_D('varint32 in : ' + val)
        if (val & 1) {
            val = ((~val) >> 1) | 0x80000000
        } else {
            val >>>= 1
        }
        TRACE_D('varint32 out : ' + val)
        out[out.length - 1] = val
    }
    return bit_count
}

/* Decode a 'name' from the byte-aligned 64-bits
 */
function name_decoder(buf, bit_index, out) {
    return 8 * 8
}

function uint8_decoder(buf, bit_index, out) {
    if (check_len(buf, bit_index, 8, 1)) {
        out.push(buf[bit_index >> 3] & 0xff)
        return 8
    }
    return -1
}

function uint16_decoder(buf, bit_index, out) {
    if (check_len(buf, bit_index, 16, 1)) {
        var index = bit_index >> 3
        var word =
            buf[index + 0] << 0 |
            buf[index + 1] << 8
        out.push(word & 0xffff)
        return 16
    }
    return -1
}

function uint32_decoder(buf, bit_index, out) {
    if (check_len(buf, bit_index, 32, 1)) {
        var index = bit_index >> 3
        var word =
            buf[index + 0] << 0 |
            buf[index + 1] << 8 |
            buf[index + 2] << 16 |
            buf[index + 3] << 24
        out.push(word & 0xffffffff)
        return 32
    }
    return -1
}



function array_decoder(buf, bit_index, out, args) {
    
}

/* Extracts the required number of bytes and returns them as a subarray
 added to the output
 */
function fixed_bytearray_decoder(buf, bit_index, out, args) {
    if (args) {
        var nbits = args.length * 8
        if (check_len(buf, bit_index, nbits, 1)) {
            var index = bit_index >> 3
            var arr = buf.slice(index, index + args.length)
            out.push(arr)
            return nbits;
        }
    }
    return -1
}


/* A varunit32 is in front of the byte array to provide the length of the array. */
function dynamic_bytearray_decoder(buf, bit_index, out, args) {
    var bits = varuint32_decoder(buf, bit_index, out)
    if (bits > 0) {
        args = { length: (out[out.length-1]) }
        var bits2 = fixed_bytearray_decoder(buf, bit_index + bits, out, args)
        if (bits2 < 0) {
            bits = -1;
        } else {
            bits += bits2
        }
    }
    return bits
}

/*--- Sensor type decoders ---------------------------------------------------*/
/* Note!
 * These are all designed to fit into an SF10 payload (max 11 bytes)
 */

/* temperature is stored in 16-bits s12q4 format. */
var temperature_decoder = [
    { fn: bitfield_decoder, args: { sign: 1, i_bits: 12, f_bits: 4 } },
]

var adc_decoder = [
    { fn: uint16_decoder },
]

/* packed into 10 bytes */
var location_decoder = [
    { fn: bitfield_decoder, args: { sign: 1, i_bits: 8, f_bits: 20 }, name: 'lat 0.000001' }, /* +/- 90 */
    { fn: bitfield_decoder, args: { sign: 1, i_bits: 9, f_bits: 20 }, name: 'lon 0.000001' }, /* +/- 180 */
    { fn: bitfield_decoder, args: { sign: 1, i_bits: 17, f_bits: 6 }, name: 'alt 0.015 m' }, /* max alt 131,072 m */
]

var humidity_decoder = [
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 7, f_bits: 1 }, name: 'rh 0.5%' },
]

var pressure_decoder = [
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 12, f_bits: 4 }, name:'hPa q4 %' },
]

var particle_decoder = [
    { fn: uint8_decoder, name: 'flags' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 }, name: 'pm1.0' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 }, name: 'pm2.5'  },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 }, name: 'pm4.0'  },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 }, name: 'pm10.0'  },
]

var accel_decoder = [
    { fn: varint32_decoder, name: 'x' },
    { fn: varint32_decoder, name: 'y' },
    { fn: varint32_decoder, name: 'z' }
]

var motion_decoder = [
    { fn : uint8_decoder, name: 'flags' },
    accel_decoder
]

var locmeta_decoder = [
    { fn: uint8_decoder, name: 'ttff_s' },
    { fn: uint8_decoder, name: 'nsats' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 4, f_bits: 4 }, name: 'dop_q4' },
    { fn: uint8_decoder, name: 'flags' },
]

var satcom_decoder = [
    { fn: uint8_decoder, name: 'rssi' },
    { fn: varuint32_decoder, name: 'energy' },
]

var satmeta_decoder = [
    { fn: varuint32_decoder, name: 'tx_counter' },
    { fn: uint8_decoder, name: 'tx_time_s' },
    { fn: uint8_decoder, name: 'tx_dropped_counter' },
    { fn: uint8_decoder, name: 'data_dropped_counter' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 4, f_bits: 0 }, name: 'retry_period_min' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 4, f_bits: 0 }, name: 'rssi_0_5' },
    { fn: varuint32_decoder, name: 'energy' },
]

var battery_decoder = [
    { fn: uint16_decoder, name: 'voltage_mv' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 24, f_bits: 0 }, name: 'current_ua' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 24, f_bits: 0 }, name: 'accum_current_uah' },
    temperature_decoder
]

/*--- System decoders ---------------------------------------------------*/

var time_decoder = [
    { fn: uint8_decoder, name: 'flags' },
    { fn: uint32_decoder, name: 'epoch' }
]

var devstartup_decoder = [
    { fn: uint8_decoder, name: 'fw_ver_major' }, 
    { fn: uint16_decoder, name: 'fw_ver_minor' },
    { fn: uint8_decoder, name: 'fw_ver_patch' },
    { fn: uint16_decoder, name: 'reset_flags' }
]

var faultinfo_decoder = [
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 24, f_bits: 0 }, name: 'pc' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 24, f_bits: 0 }, name: 'lr' },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 24, f_bits: 0 }, name: 'sp' },
]


/*--- Antelope protocol decoders -----------------------------*/

/* Format of actual TAPOS data encoded in a transaction.
 * If the decoding platform wanted to examine these fields directly, this could be used.
 * However this is not sent directly by ME-TSP modules (use antelope_message_tapos_decoder instead)
 */
var antelope_tapos_decoder = [
    { fn: uint32_decoder, name: 'expiration_sec' },
    { fn: uint16_decoder, name: 'ref_block_num' },
    { fn: uint32_decoder, name: 'ref_block_prefix' },
    { fn: varuint32_decoder, name: 'max_net_usage_words' },
    { fn: uint8_decoder, name: 'max_cpu_usage_ms' },
    { fn: varuint32_decoder, name: 'delay_sec' },
]


/* To transport specific Antelope transaction elements, these decoders are defined to demark the
 already-encoded binary data in the payload.
 */



/* We have the option of sending a compressed representation of the tapos, action and permission elements,
 * by omitting certain fields that are fixed like max_net, max_cpu and delay_sec in the TAPOS.
 */

/* The transaction re-assembler can be built as a 'platform'.  A reference implementation
 * is provided in decoder-antelope.js
 * 
 * The message content handled by fixed_array_decoders can be inserted directly
 * into the re-assembled transaction.
 */

var antelope_message_header_decoder = [
    /*
     * bits 0-2: a transaction ID (0-7) to aid in element re-assembly 
     *   Only transaction elements marked with the same trx ID can be reassembled together.
     * bits 3-5: 
     * 
     * */
    { fn: uint8_decoder, name: 'flags' } 
]

/* The Measurement{Earth} Trusted Sensor Platform modules signs with 
 *  max_net, max_cpu and delay_sec set to 0.
 */
var antelope_message_tapos_decoder = [
    antelope_message_header_decoder,
    { fn: uint8_decoder, name: 'chain' }, /* chain id. 0 - TELOS testnet 1 - TELOS mainnet 2,3,4,5,6,7 reserved. */
    /* uint32 expiration, uint16 ref block, uint32 ref block prefix */
    { fn: fixed_bytearray_decoder, args: { length: 10 }, name: 'tapos' }
    /* max_net, max_cpu and delay_sec set to 0. */
]

/* The Measurement{Earth} Trusted Sensor Platform modules signs with
 *  num_actions and num_permissions set to 1.
 */
var antelope_message_action_decoder = [
    antelope_message_header_decoder,
    /* names: account (dapp), action */
    { fn: fixed_bytearray_decoder, args: { length: 16 }, name: 'dapp info' },
    /* */
    /* names: actor, perm */
    { fn: fixed_bytearray_decoder, args: { length: 16 }, name: 'actor info' }
]

/* The Measurement{Earth} Trusted Sensor Platform modules signs with
 *  num_actions and num_permissions set to 1.
 */
var antelope_message_serialized_action_decoder = [
    antelope_message_header_decoder,
    { fn: dynamic_bytearray_decoder, name: 'action data' },
]

/* Contains
 *  Signature i(1), R(32) and S(32)
 */
var antelope_message_signature_decoder = [
    antelope_message_header_decoder,
    { fn: fixed_bytearray_decoder, args: { length: 65 }, name: 'signature' },
]

var antelope_message_tapos_req_decoder = [
    { fn: uint8_decoder, name: 'chain' }, /* chain id. 0 - TELOS testnet 1 - TELOS mainnet 2,3,4,5,6,7 reserved. */
]

/* --- Measurement{Earth} Antelope action decoders */



/*------------------------------------------------------------*/



/*--- Decoder Engine ---------------------------------------------------------*/


/* Run the decoders to consume input bits */
function decoder_run(buf, bit_index, out, decoder) {
    var decoded_bits = 0
    TRACE('Executing ' + decoder.length + ' decoders...')
    for (var i = 0; i < decoder.length; i++) {
        var field_decoder = decoder[i]
        if (field_decoder.length) {
            /* follow the heirarchy */
            var res = decoder_run(buf, bit_index + decoded_bits, out, field_decoder)
            if (res < 0) {
                return res
            } else {
                decoded_bits += res
            }
        } else {
            /* run decoder now */
            if (field_decoder.fn) {                
//                TRACE(field_decoder.fn.name + ' decoding at bit_index ' + (bit_index + decoded_bits) + ' ' + field_decoder.name)
                TRACE('decoding ' + (field_decoder.name ? field_decoder.name : '') + ' with ' + field_decoder.fn.name + ' at bit_index ' + (bit_index + decoded_bits))
                var res = field_decoder.fn(buf, bit_index + decoded_bits, out, field_decoder.args)
                if (res < 0) {
                    return res
                } else {
                    decoded_bits += res
                }
            }
        }
    }
    return decoded_bits
}


/* Decoder engine
 * 
 *   Accepts array of bytes, a channel map and a platform object.
 *   The output from each data type decoder is a naturalized data format,
 *   e.g. temperature bitfield decoder returns a floating-point temperature value.
 *   This output is funneled into a cloud-platform-specific processing function.
 *
 *  The decoder will need to return something that makes sense to the cloud platform it is embedded in.
 *  In one example, the processors would build a list of cloud-specific data structures and this
 *  function is require to return it.  Procesors get an object to which they can add keys or add to keys
 *  based on the the decoded data.
 *
*/
function decoder(bytes, map, platform) {

    var processor_data = {}
    var result = RESULT_OK
    var bit_index = 0
    var bit_count = bytes.length << 3

    platform.pre_process(processor_data)
    TRACE('Decoding ' + bytes.length + ' bytes')

    while (bit_index < bit_count && result >= 0) {
        var chan = bytes[bit_index >> 3]
        TRACE('Decode channel ' + chan + ' @ ' + bit_index)
        bit_index += 8
        if (chan in map) {
            var decoder = map[chan]
            var decoder_out = []
            var res = decoder_run(bytes, bit_index, decoder_out, decoder.decoder)
            if (res < 0) {
                result = res
                ERROR('decoding ' + res)
                break
            } else {
                if (decoder.processor) {
                    decoder.processor(decoder_out, processor_data)
                }
                bit_index += res
            }
        } else {
            ERROR('Unknown channel (' + chan + ') in input at bit offset ' + (bit_index))
            result = RESULT_CHANNEL_NOT_FOUND
            break
        }
        /* At the end of this, we must jump to the next byte boundary, if not there already. */
        if (bit_index & 0x7) {
            TRACE('WARNING: non-byte-aligned after decoder at bit ' + bit_index)
            bit_index += 8
            bit_index &= ~(0x7)
        }
    }

    if (result == RESULT_OK) {
        TRACE('Decoder success!')
    } else {
        ERROR('Decoder FAILED!')
    }

    /* Return the data to the cloud platform */
    return platform.post_process(processor_data)
}




/*--- CUT -------------------------------------------------------*/
/* Exported functions for testing */

module.exports = {
    /* core engine */
    decoder,

    /* primitive decoders */
    bitfield_decoder,
    //int8_decoder,
    uint8_decoder,
    //int16_decoder,
    //uint16_decoder,
    //int32_decoder,
    uint32_decoder,
    //varint32_decoder,
    varuint32_decoder,
    //array_decoder, /* array size is specified by a varuint32 up front */
    //fixed_array_decoder,
    name_decoder,

    /* Sensor data decoders */
    temperature_decoder,
    adc_decoder,
    location_decoder,
    humidity_decoder,
    pressure_decoder,
    particle_decoder,
    accel_decoder,
    motion_decoder,
    locmeta_decoder,
    satcom_decoder,
    satmeta_decoder,
    battery_decoder,


    time_decoder,
    devstartup_decoder,
    faultinfo_decoder,

    /* Antelope */
    antelope_message_header_decoder,
    antelope_message_tapos_decoder,
    antelope_message_action_decoder,
    antelope_message_serialized_action_decoder,
    antelope_message_signature_decoder,
    antelope_message_tapos_req_decoder,

    
}

