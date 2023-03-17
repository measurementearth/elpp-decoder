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
    if (DEBUG) {
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

function uint32_decoder(buf, bit_index, out) {
    if (check_len(buf, bit_index, 32, 1)) {
        var index = bit_index >> 3
        var word =
            buf[index + 0] << 24 |
            buf[index + 1] << 16 |
            buf[index + 2] << 8 |
            buf[index + 3] << 0
        out.push(word & 0xffffffff)
        return 32
    }
    return -1
}


/*--- Sensor type decoders ---------------------------------------------------*/
/* temperature is stored in 16-bits s12q4 format. */
var temp_decoder = [
    { fn: bitfield_decoder, args: { sign: 1, i_bits: 12, f_bits: 4 } },
]

var pm_decoder = [
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_decoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: varuint32_decoder },
    temp_decoder,
    { fn: name_decoder }
]

var accel_decoder = [
    { fn : varint32_decoder, name: 'x' },
    { fn : varint32_decoder, name: 'y' },
    { fn : varint32_decoder, name: 'z' }
]


/*--- System decoders ---------------------------------------------------*/

var time_decoder = [
    { fn: uint8_decoder, name: 'flags' },
    { fn: uint32_decoder, name: 'epoch' }
]


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
    //batt_level_decoder,
    temp_decoder,
    pm_decoder,
    accel_decoder,


    time_decoder
    
}

