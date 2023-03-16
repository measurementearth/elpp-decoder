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
 *   - minimize payload sizes
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
 *     must exist on a byte boundary - effectively limiting each entire type to a multiple
 *     of bytes.  The type decoders are packed to fit mutiples of whole bytes.
 *     
 *   - Decoders can be layered, i.e. decoders can reference other type decoders not
 *     just primitive decoder functions, effectively forming an 'ABI'.
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

function check_len(buf, bit_index, bitn) {
    return (buf.length << 3) >= (bit_index + bitn)
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
        if (check_len(buf, bit_index, bitn)) {
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
    return 8
}

/* Decode a 'name' from the byte-aligned 64-bits
 */
function name_decoder(buf, bit_index, out) {
    return 8 * 8
}


/*--- Sensor type decoders ---------------------------------------------------*/
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


/* Decoder queue has to accept an array of decoders only */
function elpp_decoder_queue_build(queue, decoder) {
    TRACE('Decoder queue adding ' + decoder.length + ' field elements at depth ' + queue.length)
    for (var i = 0; i < decoder.length; i++) {
        /* add decoder if it is a primitive function, i.e. has no length field. */
        var field_decoder = decoder[i]
        if (field_decoder.length) {
            /* dig deeper */
            elpp_decoder_queue_build(queue, field_decoder)
        } else {
            queue.push(field_decoder)
        }
    }
}


/*--- Sensor type decoders ---------------------------------------------------*/

/* Decoder engine
 *   Accepts array of bytes, a channel map and a platform object
 *   The output from each data type decoder is a naturalized data format,
 *   e.g. temperature bitfield decoder returns a float-point temperature.
 *   This output is funneled into a cloud-platform-specific processing function.
 *   
 *  The decoder may need to return something that makes sense to the cloud platform it is embedded in.
 *  In one example, the processors would build a list of cloud-specific data structures and this
 *  function is require to return it.  Procesors get an object to which they can add keys or add to keys,
 *  and finally the decoder return the post_processor output.
 *  
*/
function decoder(bytes, map, platform) {

    /* State for the decoder processor */
    var processor_data = {}
    /* The current processor for the decoder channel */
    var decoder_processor = null

    if (platform) {
        platform.pre_process(processor_data)
    }

    /* Use a bit-counter to process the data, but note that:
     *   - within data type fields, bits are consumed
     *   - data types as a whole consume a multiple of 8-bits (bytes).
     */
    var bit_index = 0
    var result = RESULT_OK
    /* push decoder primitive objects onto this queue: { fn, args } */
    var decoder_queue = []
    if (bytes && map) { 
        TRACE('Decoding ' + bytes.length + ' bytes')
        var bit_count = bytes.length << 3
        while (bit_index < bit_count && result >= 0) {
            if (decoder_queue.length) {
                /* If there are decoders in the queue, execute them all to consume bits. 
                 * Decoder output is written to this array
                 */
                var decoder_out = []
                TRACE('Executing ' + decoder_queue.length + ' decoders...')
                for (var i = 0; i < decoder_queue.length; i++) {
                    var decoder = decoder_queue[i]
                    /* { fn, args } => fn(buf, bit_index, out, args)  */
                    if (decoder.fn) {
                        var decoder_bits = decoder.fn(bytes, bit_index, decoder_out, decoder.args)
                        TRACE("Decoder " + decoder.fn.name + ' : bit_index ' + bit_index + ' consumed ' + decoder_bits)
                        if (decoder_bits < 0) {
                            ERROR('Decoder ' + decoder.fn.name + ' failed: ' + decoder_bits)
                            result = decoder_bits
                            break
                        } else {
                            bit_index += decoder_bits
                        }
                    }
                }
                /* reset decoder queue */
                decoder_queue = []

                /* Execute the processor on this decoder output */
                if (decoder_processor) {
                    decoder_processor(decoder_out, processor_data)
                    decoder_processor = null
                }
                /* At the end of this, we must jump to the next byte boundary, if not there already. */
                if (bit_index & 0x7) {
                    TRACE('WARNING: non-byte-aligned after decoder at bit ' + bit_index)
                    bit_index += 8
                    bit_index &= ~(0x7)
                }
            } else {
                /* If the stack is empty, we are in channel search mode */
                /* Get the channel */
                var chan = bytes[bit_index >> 3]
                TRACE('Search for channel ' + chan + ' @ ' + bit_index)
                if (chan in map) {
                    /* Build the stack of decoder functions to execute */
                    var channel_decoder = map[chan]
                    /* A channel decoder has a decoder entry point and a decoder output processor. */
                    elpp_decoder_queue_build(decoder_queue, channel_decoder.decoder)
                    /* install the decoder processor */
                    decoder_processor = channel_decoder.processor
                    /* increment past the channel control byte */
                    bit_index += 8
                } else {
                    ERROR('Unknown channel (' + chan + ') in input at byte offset ' + (bit_index >> 3))
                    result = RESULT_CHANNEL_NOT_FOUND
                    break;
                }
            }
        }
    }

    if (result == RESULT_OK) {
        TRACE('Decoder success!')
    } else {
        ERROR('Decoder FAILED!')
    }

    /* Return the data object or portion of it to the cloud platform */
    if (platform) {
        return platform.post_process(processor_data)
    } else {
        return processor_data
    }
}


/*--- CUT -------------------------------------------------------*/
/* Exported functions for testing */

module.exports = {
    /* core engine */
    decoder,

    /* cloud platform interface */


    /* primitive decoders */
    bitfield_decoder,
    //int8_decoder,
    //uint8_decoder,
    //int16_decoder,
    //uint16_decoder,
    //int32_decoder,
    //uint32_decoder,
    //varint32_decoder,
    varuint32_decoder,
    //array_decoder, /* array size is specified by a varuint32 up front */
    //fixed_array_decoder,
    name_decoder,

    /* Sensor data decoders */
    //batt_level_decoder,
    temp_decoder,
    pm_decoder,
    
}

