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
function temp_processor(out, obj) {

    obj.data.push(make_struct('TEMPERATURE', out[0]))
}

/*  A time decoder returns an epoch time in seconds */
function time_processor(out, obj) {
    timestamp = out[1]
}


/*------ CUT ------------------------*/
/* Testing */
const elpp = require('./decoder')
const encoder = require('./encoder')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
log('starting decoder-datacake tests')

function temp_provider() {
    return [25.8]
}

function time_provider() {
    return [0x1, (Date.now() / 1000) >> 0]
}

var encoder_map = {
    0: { encoder: encoder.temp_encoder, provider: temp_provider },
    10: { encoder: encoder.time_encoder, provider: time_provider }
}

/* Time is applied to subsequent data only, so must be first in a the encoded payload */
var test_vec = encoder.encoder([10, 0], encoder_map)

var channel_map = {
    0: { decoder: elpp.temp_decoder, processor: temp_processor },
    10: { decoder: elpp.time_decoder, processor: time_processor }
}

/* Extract serial number from the input to the Decoder function.
 * Only necessary if coming from an API endpoint.  Datacake automatically extracts the serial number from the DevEUI 
 * supplied by supported LoRaWAN endpoints 
 */
serial = '0123456789'

var result = elpp.decoder(test_vec, channel_map, platform)
log_obj(result)

