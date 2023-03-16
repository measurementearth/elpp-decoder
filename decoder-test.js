const elpp = require('./decoder')

const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }

log('starting decoder tests')

var DEBUG = true

function TRACE_D(msg) {
    if (DEBUG) {
        console.log(msg)
    }
}


function temp_processor(out, data) {
    /* do something with decoded temp data */

    data['temp'] = out[0]
}

function pm_processor(out, data) {
    data['pm'] = {
        '1.0': out[0],
        '2.5': out[1],
        '4.0': out[2],
        '10.0': out[3],
        'temp': out[4]
    }
}

/* The channel map defines the application's mapping of channels to data type decoders.
 * The data type decoders form a root of a possibly heirarch of decoders and primitive decoders.
 * A processor function is required to convert the output into something the cloud platform can
 * work with.  The processor gets a list of decoded output values.
 *
 * A Measurement{Earth} Trusted Sensor Platform module will specify this mapping.
 */

var channel_map = {
    0: { decoder: elpp.temp_decoder, processor: temp_processor },
    1: { decoder: elpp.pm_decoder, processor: pm_processor }
}

var platform = {
    /* Setup the object in a platform specific way */
    pre_process: function (obj) {

    },
    /* Post process and return the data specific to the platform */
    post_process: function (obj) {
        return obj
    }
}

/* temp is s12q4 */


function emplace_bits(buf, start_bit, end_bit, bits) {
    /* Setup indices */
    var nbits = end_bit - start_bit + 1
    var byte_start = (start_bit / 8) >> 0
    var bit_start = (start_bit % 8) >> 0
    var byte_end = (end_bit / 8) >> 0
    var bit_end = (end_bit % 8) >> 0

    TRACE_D('emplace '+ bits.toString(16) + ' : ' + nbits + ' byte_start ' + byte_start + ' bit_start ' + bit_start + ' byte_end ' + byte_end + ' bit_end ' + bit_end)

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
    buf.push(0)
    return 8
}

function name_encoder(buf, bit_index, data, args) {
    for (var i = 0; i < 8; i++) {
        buf.push(0)
    }
    return 8 * 8
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

/* Take a list of input values (appropriate for the encoders) and create an encoded byte buffer
 * that can be used to test the decoder.
 */
function encoder(encoder_map) {
    var buf = [] /* simple array of 8-bit values */
    var bit_index = 0
    var encoder_queue = []
    /* consume values in the encoders */
    for (chan in encoder_map) {
        log('encoding channel ' + chan)
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
    }

    return buf
}


function temp_provider() {
    return [-12.7]
}

function pm_provider() {
    var data = [
        36,
        18,
        76,
        557,
        0,
        -20.8,
        '111111111111'
    ]
    return data
}

var encoder_map = {
    0: { encoder: temp_encoder, provider: temp_provider },
    1: { encoder: pm_encoder, provider: pm_provider }
}

var test_vec = encoder(encoder_map)

log('== encoded ==')
log(Buffer.from(test_vec).toString('hex'))

log('== decoded ==')
var result = elpp.decoder(test_vec, channel_map, platform)
log_obj(result)

