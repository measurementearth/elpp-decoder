const elpp = require('./decoder')
const encoder = require('./encoder')

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

function time_processor(out, data) {
    data['time'] = {
        'flags': out[0],
        'epoch': out[1]
    }
}

function accel_processor(out, data) {
    data['accel'] = {
        'x' : out[0],
        'y' : out[1],
        'z' : out[2],
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
    1: { decoder: elpp.pm_decoder, processor: pm_processor },
    2: { decoder: elpp.accel_decoder, processor: accel_processor },
    10: { decoder: elpp.time_decoder, processor: time_processor }
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



function temp_provider() {
    return [-12.7]
}

function pm_provider() {
    var data = [
        1023,//36,
        1023,//18,
        1024,//76,
        1023,//557,
        0,
        -2090.8,
        '111111111111'
    ]
    return data
}

function time_provider() {
    return [0x1, (Date.now() / 1000)]
}

function accel_provider() {
    return [12,-1234,12345678]
}

var encoder_map = {
    0: { encoder: encoder.temp_encoder, provider: temp_provider },
    1: { encoder: encoder.pm_encoder, provider: pm_provider },
    2: { encoder: encoder.accel_encoder, provider: accel_provider },
    10: {encoder : encoder.time_encoder, provider: time_provider}
}

var test_vec = encoder.encoder([10, 0, 1, 2], encoder_map)

log('== encoded ==')
log(Buffer.from(test_vec).toString('hex'))

log('== decoded ==')
var result = elpp.decoder(test_vec, channel_map, platform)
log_obj(result)

