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
 * The Datacake platform requires decoder output to be an array of objects.
 * Each object contains data for one entry in the database, i.e. for temperature.
 * The object fields are:
 *  [
 *    {
 *        field : "TEMPERATURE",
 *        value : 22.75,
 *        device : "serialnumber",
 *        timestamp : 1679008886
 *    },
 *    ...
 *  ]
 *  
 * To use the ELPP decoder protocol, one must implement a platform object 'pre_process' and 'post_process'
 * to set and return this array, and then implement a decoder processor for each decoder type that is in use
 * on the platform.
 * 
 * This file contains the implementions of these functions.  What you need to do is copy and paste these
 * into the device configuration's Decoder section and modify the '_processor' functions to use the
 * database names you've chosen to store the values for your configuration.
 * You need to create/modify the channel map appropriately to use only the decoders that you application needs.
 */

/* For use with testing */
var elpp = require('./decoder')

var DO_TRACE = true

function TRACE(msg) {
    if (DO_TRACE) {
        console.log(msg)
    }
}

/* This arbitrarily assigned port is used for ELPP protocol on LORAWAN. */
var ELPP_PORT_LORAWAN = 8

/* State:
 *    timestamp - record time as it is found in the decoded output to be applied to subsequent data items.
 *    serial - extracted from the data provided by Datacake in a link-dependent way. 
 *
 */
var timestamp
var serial

var platform = {
    /* Setup the object in a platform specific way */
    pre_process: function (obj) {
        /* create an array to dump processed data into */
        obj.data = []
    },
    /* Post process and return the data specific to the platform */
    post_process: function (obj) {
        return obj.data
    }
}

function make_struct(field, value) {
    var struct = {}
    struct.field = field
    struct.value = value
    if (serial) {
        struct.device = serial
    }
    if (timestamp) {
        struct.timestamp = timestamp
    }
    return struct
}

/*  A temperature decoder returns one temperature value */
function temperature_processor(out, obj) {

    obj.data.push(make_struct('TEMPERATURE', out[0]))
}

function adc_processor(out, obj) {
    /* data provided in units of millivolts */
    var level = out[0] / 1000
    obj.data.push(make_struct('BATTERY_LEVEL', level))
}

function location_processor(out, obj) {
    var lat = out[0]
    var lon = out[1]
    obj.data.push(make_struct('LOCATION',
        '(' + lat + ',' + lon + ')'))
    /* altitude must be a separate field */
    TRACE('ALT: ' + out[2])
}

function humidity_processor(out, obj) {
    obj.data.push(make_struct('HUMIDITY', out[0]))
}

function pressure_processor(out, obj) {
    obj.data.push(make_struct('PRESSURE', out[0]))
}

function motion_processor(out, obj) {
    /* flags at out[0]:
     *   bit 0: activity detected
     */

    /* Integers */
    obj.data.push(make_struct('MOTION_FLAGS', out[0]))
    obj.data.push(make_struct('MOTION_ACCEL_X', out[1]))
    obj.data.push(make_struct('MOTION_ACCEL_Y', out[2]))
    obj.data.push(make_struct('MOTION_ACCEL_Z', out[3]))
}

function particle_processor(out, obj) {
    /* Integers */
    obj.data.push(make_struct('PARTICLE_FLAGS', out[0]))
    obj.data.push(make_struct('PM1_0', out[1]))
    obj.data.push(make_struct('PM2_5', out[2]))
    obj.data.push(make_struct('PM4_0', out[3]))
    obj.data.push(make_struct('PM10_0', out[4]))
}

function temperature_chassis_processor(out, obj) {

    obj.data.push(make_struct('TEMPERATURE_CHASSIS', out[0]))
}

function humidity_chassis_processor(out, obj) {
    obj.data.push(make_struct('HUMIDITY', out[0]))
}

function satcom_processor(out, obj) {
    obj.data.push(make_struct('SATCOM_RSSI', out[0]))
    obj.data.push(make_struct('SATCOM_ENERGY', out[1]))
}

/*  A time decoder returns an epoch time in seconds */
function time_processor(out, obj) {
    /* flags at out[0] */
    timestamp = out[1]
}

function devstartup_processor(out, obj) {
    /* FW VERSION is stored as a string in the database.
     * Build string here:
     */
    var fwver = 'v' + out[0] + '.' + out[1] + '.' + out[2]
    obj.data.push(make_struct('FW_VER', fwver))
    obj.data.push(make_struct('RESET_FLAGS', out[3]))
}

function faultinfo_processor(out, obj) {
    /* faultinfo is comprised of lowest 3 bytes of PC, LR and SP registers
     * recorded at the time of fault.
     * This can also be a string.
     */
    var faultinfo =
        'PC:0x08' + out[0].toString(16) +
        ' LR:0x08' + out[1].toString(16) +
        ' SP:0x20' + out[2].toString(16)

    obj.data.push(make_struct('FAULT_REGS', faultinfo))
}

function locmeta_processor(out, obj) {
    obj.data.push(make_struct('LOCATION_TTFF', out[0]))
    obj.data.push(make_struct('LOCATION_SATS', out[1]))
    obj.data.push(make_struct('LOCATION_DOP', out[2]))
    obj.data.push(make_struct('LOCATION_FLAGS', out[3]))
}

function satmeta_processor(out, obj) {
    obj.data.push(make_struct('SATCOM_TX_ATTEMPTS', out[0]))
    obj.data.push(make_struct('SATCOM_TX_TIME', out[1]))
    obj.data.push(make_struct('SATCOM_TX_DROPPED', out[2]))
    obj.data.push(make_struct('SATCOM_DATA_DROPPED', out[3]))
    obj.data.push(make_struct('SATCOM_RETRY_PERIOD', out[4]))
    obj.data.push(make_struct('SATCOM_RSSI', out[5]))
    obj.data.push(make_struct('SATCOM_ENERGY', out[6]))
}

function battery_processor(out, obj) {
    /* data provided in units of millivolts */
    var volt = out[0] / 1000
    /* current in units of uA and shown in mA */
    var current = out[1] / 1000
    var accum_current = out[2] / 1000
    obj.data.push(make_struct('BATTERY_VOLTAGE', volt))
    obj.data.push(make_struct('BATTERY_CURRENT', current))
    obj.data.push(make_struct('BATTERY_ACCUM_CURRENT', accum_current))
    obj.data.push(make_struct('BATTERY_TEMP', out[3]))
}



/* The ELPP channel map - this is a specification and cannot be
 * changed once deployed since the Measurement{Earth} devices
 * use the same channel mapping for encoding.
 */
var channel_map = {
    0: { decoder: elpp.temperature_decoder, processor: temperature_processor }, /* temp instance 0 => /dev/temp/0 */
    1: { decoder: elpp.adc_decoder, processor: adc_processor }, /* internal ADC connected to battery => /dev/adc/0 */
    2: { decoder: elpp.location_decoder, processor: location_processor }, /* full-res packed location data => /dev/loc/0*/
    3: { decoder: elpp.humidity_decoder, processor: humidity_processor }, /* humidity instance 0 => /dev/hum/0 */
    4: { decoder: elpp.pressure_decoder, processor: pressure_processor }, /* /dev/pres/0 */
    5: { decoder: elpp.motion_decoder, processor: motion_processor }, /* /dev/motion/0 */
    6: { decoder: elpp.particle_decoder, processor: particle_processor }, /* /dev/pm/0 */
    7: { decoder: elpp.temperature_decoder, processor: temperature_chassis_processor }, /* temp instance 1 => /dev/temp/1 */
    8: { decoder: elpp.humidity_decoder, processor: humidity_chassis_processor }, /* humidity instance 1 => /dev/hum/1 */
    9: { decoder: elpp.satcom_decoder, processor: satcom_processor }, /* satcom as a sensor (RSSI) /dev/satcom/0 */
    10: { decoder: elpp.time_decoder, processor: time_processor }, /* system time UTC => date */
    11: { decoder: elpp.battery_decoder, processor: battery_processor }, /* a battery fuel gauge /dev/batt/0 */
    //12: { decoder: elpp.atmos_decoder, processor: atmos_processor }, /* combined atmospheric sensor data: temp, pressure, humidity => /dev/atmos/0 */
    //13: reserved
    14: { decoder: elpp.locmeta_decoder, processor: locmeta_processor }, /* location (e.g. GPS) metadata */
    15: { decoder: elpp.satmeta_decoder, processor : satmeta_processor }, /* satcom metadata */

    /* system messages */
    30: { decoder: elpp.devstartup_decoder, processor: devstartup_processor },
    31: { decoder: elpp.faultinfo_decoder, processor: faultinfo_processor },
}


function decoder_lorawan(bytes, port) {

    if (port === ELPP_PORT_LORAWAN) {
        return elpp.decoder(bytes, channel_map, platform)
    } else {
        TRACE('Payload on unsupported port '+ port)
        return []
    }
}

/* Decoder for Helium integration */
function decoder_helium(bytes, port) {

    /* Set the timestamp according to time gateway received time.
     * Timestamp can be overriden by content in the payload, however
     * Measurement{Earth} sensor platforms typically do not send
     * timestamps (measurements are sent as they are made) over
     * lorawan transports.
     */
    var time
    if (rawPayload.reported_at) { /* Helium payload has "reported_at" field */
        time = (new Date(rawPayload.reported_at)).getTime()
    } else {
        time = Date.now()
    }
    timestamp = time / 1000 >> 0

    return decoder_lorawan(bytes, port)
}

/* Decoder for webhook integration from Senet lorawan source */
function decoder_webhook_senet(request) {

    /*
     * How to use:
     * 
     * function Decoder(request) {
     *     return decoder_webhook_senet(request)
     * }
     */

    var payload = JSON.parse(request.body)
    var bytes = hexToBytes(payload.pdu)
    var port = payload.port

    /* Set the serial for each measurement record */
    serial = payload.devEui

    /* Set the timestamp according to time gateway received time */
    var time
    if (payload.gwRxTime) { /* Senet webhook payload has "reported_at" field */
        time = (new Date(payload.gwRxTime)).getTime()
    } else {
        time = Date.now()
    }
    timestamp = time / 1000 >> 0

    TRACE('pdu: ' + payload.pdu + ' port: ' + port + ' serial: ' + serial + ' timestamp: ' + timestamp)

    return decoder_lorawan(bytes, port)
}

// Convert a hex string to a byte array
function hexToBytes(hex) {
    var bytes = [];
    for (var c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return bytes;
}

/*------ CUT ------------------------*/
/* Testing */
const encoder = require('./encoder')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
log('starting decoder-datacake tests')

function temperature_provider() {
    return [25.8]
}

function time_provider() {
    return [0x1, (Date.now() / 1000) >> 0]
}

function battery_provider() {
    return [
        3463,
        34203,
        12235351,
        49.7]
}

var encoder_map = {
    0: { encoder: encoder.temperature_encoder, provider: temperature_provider },
    10: { encoder: encoder.time_encoder, provider: time_provider },
    11: { encoder: encoder.battery_encoder, provider: battery_provider },

}

/* Time is applied to subsequent data only, so must be first in a the encoded payload */
var test_vec = encoder.encoder([10, 0, 11], encoder_map)


/* Extract serial number from the input to the Decoder function.
 * Only necessary if coming from an API endpoint.  Datacake automatically extracts the serial number from the DevEUI 
 * supplied by supported LoRaWAN endpoints 
 */
serial = '0123456789'

var result = elpp.decoder(test_vec, channel_map, platform)
log_obj(result)


var TEST_ENCODED = Buffer.from('0a01c80d2a6400ff360656ffffffffff05a518a3139c85e30b023313824c6ea3d401006d1f123456789abcdef1231e01030002bff60b0e0d005cb582831202f30eb710c54c0f840a78e808f5cdce8603090586afdc42', 'hex')
log('B67 ' + TEST_ENCODED[67])
var result2 = elpp.decoder(TEST_ENCODED, channel_map, platform)
log_obj(result2)

var TEST_REQUEST_SENET =
    { "body": '{ "ack": false, "channel": 8, "datarate": 0, "devClass": "A", "devEui": "1234567898765432", "devProfile": "Default - ABCDEFABEDEF1234", "devType": "Other", "freq": 903.9, "gwEui": "ABCDEFABCDEFABCD", "gwRxTime": "2023-02-20T15:02:17.141Z", "ismBand": "US915", "joinId": 5, "maxPayload": 242, "pdu": "0a01c80d2a6400ff360656ffffffffff05a518a3139c85e30b023313824c6ea3d401006d1f123456789abcdef1231e01030002bff60b0e0d005cb582831202f30eb710c54c0f840a78e808f5cdce8603090586afdc42", "port": 8, "rssi": -117, "seqno": 360, "snr": 1.5, "txtime": "2023-02-20T15:02:17.142Z" }' }
