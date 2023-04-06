/*------ CUT ------------------------*/
/* Testing */
var crypto = require('crypto')
const elpp = require('./decoder')
const encoder = require('./encoder')
const antelope = require('./decoder-antelope')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
log('starting decoder-antelope tests')

/* This could be a simple counter incrementing for each transaction */
var test_trx_id = 5
var test_chain_id = 1

function antelope_message_tapos_provider() {
    /* Provide flags (1) , chain_id (1), data (10 bytes)
     */

    /* Expiration one hour from now. */
    var chain_date = Date.now()
    var expiration = ((chain_date / 1000) >> 0) + 3600

    var tapos = Buffer.alloc(10)
    tapos.writeUInt32LE(expiration, 0)
    tapos.writeUInt16LE(0x1234, 4)
    tapos.writeUInt32LE(0xCAFEBABE, 6)
    var data = [
        test_trx_id & 0x7, /*header */
        test_chain_id,
        tapos
    ]

    return data
}

function antelope_message_action_provider() {

    /* Provide two arrays of 16 each:
     *  dapp, action names
     *  permission, actor names
     */
    var buf1 = []
    var bits1 = encoder.name_encoder(buf1, 0, 'airv11.meas')
    bits1 += encoder.name_encoder(buf1, bits1, 'submitv1')

    var buf2 = []
    var bits2 = encoder.name_encoder(buf2, 0, 'active')
    bits2 += encoder.name_encoder(buf2, bits2, 'a11111c.meas')

    return [
        test_trx_id & 0x7, /*header */
        buf1,
        buf2
    ]
}

function antelope_message_serialized_action_provider() {
    /* The action's arguments.  TSP-AIR submitv1 data is 82 bytes */

    var buf = crypto.randomBytes(82)
    return [
        test_trx_id & 0x7, /*header */
        buf
    ]
}

function antelope_message_signature_provider() {

    var buf = crypto.randomBytes(65)
    buf[0] = 1 /* i ranges from 0-3 */
    return [
        test_trx_id & 0x7, /*header */
        buf
    ]

}

function time_provider() {
    return [0x1, (Date.now() / 1000) >> 0]
}

var encoder_map = {
    0: { encoder: encoder.antelope_message_tapos_encoder, provider: antelope_message_tapos_provider },
    1: { encoder: encoder.antelope_message_action_encoder, provider: antelope_message_action_provider },
    2: { encoder: encoder.antelope_message_serialized_action_encoder, provider: antelope_message_serialized_action_provider },
    3: { encoder: encoder.antelope_message_signature_encoder, provider: antelope_message_signature_provider },
}

var test_vec1 = encoder.encoder([0, 1], encoder_map)
log('test 1 : ' + Buffer.from(test_vec1).toString('hex'))
var test_vec2 = encoder.encoder([2], encoder_map)
log('test 2 : ' + Buffer.from(test_vec2).toString('hex'))
var test_vec3 = encoder.encoder([3], encoder_map)
log('test 3 : ' + Buffer.from(test_vec3).toString('hex'))
var test_vec4 = encoder.encoder([3, 2, 1, 0], encoder_map)
log('test 4 : ' + Buffer.from(test_vec4).toString('hex'))


var decoder_state = antelope.new_state()

var result1 = antelope.decoder(test_vec1, decoder_state)
log_obj(result1)
var result2 = antelope.decoder(test_vec2, decoder_state)
log_obj(result2)
var result3 = antelope.decoder(test_vec3, decoder_state)
log_obj(result3)

var result4 = antelope.decoder(test_vec4, decoder_state)
log_obj(result4)

/* TAPOS + ACTION */
log('test 1 (b64) : ' + Buffer.from(test_vec1).toString('base64'))
/* SERIALIZED ACTION */
log('test 2 (b64) : ' + Buffer.from(test_vec2).toString('base64'))
/* SIGNATURE */
log('test 3 (b64) : ' + Buffer.from(test_vec3).toString('base64'))
/* All of above in one message */
log('test 4 (b64): ' + Buffer.from(test_vec4).toString('base64'))
