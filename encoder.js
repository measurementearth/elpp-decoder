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

/*
 * The encoder is used to create test inputs for the decoder.
 */

var DEBUG = true

function TRACE_D(msg) {
    if (DEBUG) {
        console.log(msg)
    }
}

const log = console.log

function emplace_bits(buf, start_bit, end_bit, bits) {
    /* Setup indices */
    var nbits = end_bit - start_bit + 1
    var byte_start = (start_bit / 8) >> 0
    var bit_start = (start_bit % 8) >> 0
    var byte_end = (end_bit / 8) >> 0
    var bit_end = (end_bit % 8) >> 0

    TRACE_D('emplace ' + bits.toString(16) + ' : ' + nbits + ' byte_start ' + byte_start + ' bit_start ' + bit_start + ' byte_end ' + byte_end + ' bit_end ' + bit_end)

    /* Case 1: start and end bit land within same byte */
    if (byte_start == byte_end) {
        /* move bits into position */
        bits <<= (7 - bit_start)
        bits &= 0xff
        if (byte_start < buf.length) {
            buf[byte_start] |= bits
        } else {
            buf.push(bits)
        }
    }
    /* Case 2: start and end bits land on different bytes */
    else {
        /* Emplace bits into first byte */
        nbits -= (8 - bit_start)
        var byte = bits >> (nbits)
        byte &= 0xff
        if (byte_start < buf.length) {
            buf[byte_start] |= byte
        } else {
            buf.push(byte)
        }
        TRACE_D('  B' + byte_start + ' byte ' + byte.toString(16))
        /* Emplace whole bytes between */
        for (var i = byte_start + 1; i < byte_end; i++) {
            nbits -= 8
            byte = bits >> (nbits)
            byte &= 0xff
            buf.push(byte)
            TRACE_D('  B' + i + ' byte ' + byte.toString(16))
        }
        /* Emplace last byte */
        nbits -= (bit_end + 1)
        byte = bits << (7 - bit_end)
        byte &= 0xff
        buf.push(byte)
        TRACE_D('  B' + byte_end + ' byte ' + byte.toString(16) + ' nbits ' + nbits)

    }
}

/* input data is a signed integer or floating point number */
function bitfield_encoder(buf, bit_index, data, args) {
    if (args) {
        var bitn = args.i_bits + args.f_bits
        /* perfrom a ceil function in case data overflows bitfield */
        if (data >= (1 << (args.i_bits - args.sign))) {
            log('positive overflow detected: ' + data + ' > ' + ((1 << (args.i_bits - args.sign)) - 1))
            data = (1 << args.i_bits) - 1
        } else if (args.sign && data < -(1 << (args.i_bits - 1))) {
            log('negative overflow detected: ' + data + ' < ' + (-(1 << (args.i_bits - 1))))
            data = -(1 << (args.i_bits - 1))
        }

        /* convert to scaled integer */
        data = (data * (1 << args.f_bits)) >> 0
        /* mask off unused bits */
        data <<= 32 - bitn
        data >>>= 32 - bitn
        /* inject into byte array */
        emplace_bits(buf, bit_index, bit_index + bitn - 1, data)
        return bitn
    }
}

function varuint32_encoder(buf, bit_index, data, args) {
    var n = 0
    while (true) {
        n++
        if (data >>> 7) {
            buf.push(0x80 | (data & 0x7f))
            data >>>= 7
        } else {
            buf.push(data)
            break
        }
    }
    return n * 8
}

function varint32_encoder(buf, bit_index, data, args) {
    return varuint32_encoder(buf, bit_index, (data << 1) ^ (data >> 31), args)
}

function name_encoder(buf, bit_index, data, args) {
    for (var i = 0; i < 8; i++) {
        buf.push(0)
    }
    return 8 * 8
}

function uint8_encoder(buf, bit_index, data, args) {
    buf.push(data & 0xff)
    return 8
}

function uint32_encoder(buf, bit_index, data, args) {
    buf.push((data >> 24) & 0xff)
    buf.push((data >> 16) & 0xff)
    buf.push((data >> 8) & 0xff)
    buf.push((data >> 0) & 0xff)
    return 32
}


var temp_encoder = [
    { fn: bitfield_encoder, args: { sign: 1, i_bits: 12, f_bits: 4 } },
]

var pm_encoder = [
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: varuint32_encoder },
    temp_encoder,
    { fn: name_encoder }
]

var time_encoder = [
    { fn: uint8_encoder },
    { fn: uint32_encoder },
]

var accel_encoder = [
    { fn: varint32_encoder, name: 'x' },
    { fn: varint32_encoder, name: 'y' },
    { fn: varint32_encoder, name: 'z' }
]


function encoder_run(buf, bit_index, encoder, provider) {
    var encoded_bits = 0
    for (var i = 0; i < encoder.length; i++) {
        var field_encoder = encoder[i]
        if (field_encoder.length) {
            /* follow the heirarchy */
            var res = encoder_run(buf, bit_index + encoded_bits, field_encoder, provider)
            if (res < 0) {
                return res
            } else {
                encoded_bits += res
            }
        } else {
            /* run encoder now */
            if (field_encoder.fn) {
                var data = provider.shift()
                log(field_encoder.fn.name + ' encoding ' + data)
                var res = field_encoder.fn(buf, bit_index + encoded_bits, data, field_encoder.args)
                if (res < 0) {
                    return res
                } else {
                    encoded_bits += res
                }
            }
        }
    }
    return encoded_bits
}

/* This encoder gets the input data from the 'providers' assigned to each channel in the map,
 * which must return an array of values that are consumed by each primitive encoder composing the type.
 * 
 * The order of encoding is defined by the list of channel numbers.
 */
function encoder(channel_list, encoder_map) {
    var buf = [] /* simple array of 8-bit values */
    var bit_index = 0
    /* consume values in the encoders */
    for (c in channel_list) {
        var chan = channel_list[c]
        log('encoding channel ' + chan)
        if (chan in encoder_map) {
            var encoder = encoder_map[chan]
            /* encode the channel */
            buf.push(chan)
            bit_index += 8
            /* run the encoder heiarchy */
            var res = encoder_run(buf, bit_index, encoder.encoder, encoder.provider())
            if (res < 0) {
                log('ERROR encoding ' + encoder_map[chan].encoder.name)
            } else {
                bit_index += res
            }
        } else {
            log('ERROR: channel ' + chan + ' not found in map')
        }
    }

    return buf
}

module.exports = {

    encoder,

    /* primitive encoders */
    bitfield_encoder,
    //int8_encoder,
    uint8_encoder,
    //int16_encoder,
    //uint16_encoder,
    //int32_encoder,
    uint32_encoder,
    //varint32_encoder,
    varuint32_encoder,
    //array_encoder, /* array size is specified by a varuint32 up front */
    //fixed_array_encoder,
    name_encoder,

    /* Sensor data encoders */
    //batt_level_encoder,
    temp_encoder,
    pm_encoder,
    accel_encoder,
    time_encoder

}
