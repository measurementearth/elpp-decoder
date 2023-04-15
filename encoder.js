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
 * The encoder is used to create test inputs for the decoder
 * and create downlink payloads.
 */

var DEBUG = true

function TRACE_D(msg) {
    if (DEBUG) {
        console.log(msg)
    }
}

const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }

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
        bits <<= (7 - bit_end)
        bits &= 0xff
        if (byte_start < buf.length) {
            buf[byte_start] |= bits
        } else {
            buf.push(bits)
        }
        TRACE_D('  B' + byte_start + ' bits ' + bits.toString(16))
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

/* data must be a 'name' string */
function name_encoder(buf, bit_index, data, args) {
    const regex = new RegExp(/^[.1-5a-z]{0,12}[.1-5a-j]?$/);
    if (!regex.test(data)) {
        throw new Error('Name should be less than 13 characters, or less than 14 if last character is between 1-5 or a-j, and only contain the following symbols .12345abcdefghijklmnopqrstuvwxyz')
    }
    const charToSymbol = function (c) {
        if (c >= 'a'.charCodeAt(0) && c <= 'z'.charCodeAt(0)) {
            return (c - 'a'.charCodeAt(0)) + 6;
        }
        if (c >= '1'.charCodeAt(0) && c <= '5'.charCodeAt(0)) {
            return (c - '1'.charCodeAt(0)) + 1;
        }
        return 0;
    };
    const a = new Uint8Array(8);
    let bit = 63;
    for (let i = 0; i < data.length; ++i) {
        let c = charToSymbol(data.charCodeAt(i));
        if (bit < 5) {
            c = c << 1;
        }
        for (let j = 4; j >= 0; --j) {
            if (bit >= 0) {
                a[Math.floor(bit / 8)] |= ((c >> j) & 1) << (bit % 8);
                --bit;
            }
        }
    }
    for (let i = 0; i < a.length; i++) {
        buf.push(a[i])
    }
    return 8 * 8
}

function uint8_encoder(buf, bit_index, data, args) {
    buf.push(data & 0xff)
    return 8
}

function uint16_encoder(buf, bit_index, data, args) {
    buf.push((data >> 0) & 0xff)
    buf.push((data >> 8) & 0xff)
    return 16
}

function uint32_encoder(buf, bit_index, data, args) {
    buf.push((data >> 0) & 0xff)
    buf.push((data >> 8) & 0xff)
    buf.push((data >> 16) & 0xff)
    buf.push((data >> 24) & 0xff)
    return 32
}


/* data will be an [array] */
function fixed_bytearray_encoder(buf, bit_index, data, args) {
    if (args) {
        if (data.length >= args.length) {
            for (var i = 0; i < args.length; i++) {
                buf.push(data[i])
            }
            return args.length << 3;
        }
    }
    return -1
}

/* data will be [array] */
function dynamic_bytearray_encoder(buf, bit_index, data, args) {
    var bits = varuint32_encoder(buf, bit_index, data.length)
    if (bits > 0) {
        args = { length: (data.length) }
        var bits2 = fixed_bytearray_encoder(buf, bit_index + bits, data, args)
        if (bits2 < 0) {
            bits = -1;
        } else {
            bits += bits2
        }

    }
    return bits
}

/*--- Sensor type encoders -----------------------------------*/

var temperature_encoder = [
    { fn: bitfield_encoder, args: { sign: 1, i_bits: 12, f_bits: 4 } },
]

var particle_encoder = [
    { fn: uint8_encoder, name: 'flags' },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
    { fn: bitfield_encoder, args: { sign: 0, i_bits: 10, f_bits: 0 } },
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


/*--- Antelope protocol encoders -----------------------------*/

var antelope_tapos_encoder = [
    { fn: uint32_encoder, name: 'expiration_sec' },
    { fn: uint16_encoder, name: 'ref_block_num' },
    { fn: uint32_encoder, name: 'ref_block_prefix' },
    { fn: varuint32_encoder, name: 'max_net_usage_words'},
    { fn: uint8_encoder, name: 'max_cpu_usage_ms' },
    { fn: varuint32_encoder, name: 'delay_sec' },
]


var antelope_message_header_encoder = [
    /*
     * bits 0-2: a transaction ID (0-7) to aid in element re-assembly 
     *   Only transaction elements marked with the same trx ID can be reassembled together.
     * 
     * */
    { fn: uint8_encoder, name: 'flags' }
]

var antelope_message_tapos_encoder = [
    antelope_message_header_encoder,
    { fn: uint8_encoder }, /* chain id. 0 - TELOS testnet 1 - TELOS mainnet 2,3,4,5,6,7 reserved. */
    /* uint32 expiration, uint16 ref block, uint32 ref block prefix */
    { fn: fixed_bytearray_encoder, args: { length: 10 } }
    /* max_net, max_cpu and delay_sec set to 0. */
]

var antelope_message_action_encoder = [
    antelope_message_header_encoder,
    /* names: account (dapp), action */
    { fn: fixed_bytearray_encoder, args: { length: 16 } },
    /* */
    /* names: actor, perm */
    { fn: fixed_bytearray_encoder, args: { length: 16 } }

]

var antelope_message_serialized_action_encoder = [
    antelope_message_header_encoder,
    { fn: dynamic_bytearray_encoder },
]

var antelope_message_signature_encoder = [
    antelope_message_header_encoder,
    { fn: fixed_bytearray_encoder, args: { length: 65 } },
]

/*------------------------------------------------------------*/


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
                log(field_encoder.fn.name + ' encoding: ')
                log_obj(data)
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
    temperature_encoder,
    particle_encoder,
    accel_encoder,
    time_encoder,

    /* Antelope */
    antelope_message_header_encoder,
    antelope_message_tapos_encoder,
    antelope_message_action_encoder,
    antelope_message_serialized_action_encoder,
    antelope_message_signature_encoder,

}
