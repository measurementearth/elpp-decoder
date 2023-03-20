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
 * The 'Antelope' platform is a blockchain system described at https://antelope.io/
 * 
 * In a nutshell, applications are built and deployed onto the blockchain and these present
 * a callable API in the form of 'Actions'.  The Actions are defined as familiar function calls
 * with standard arguments like integers, floating points values, arrays of bytes and other types,
 * and so on.  
 * 
 * Being blockchain, though, means that such Actions can only be called by verified entities,
 * that is, entities that possess the required private key.  These entities must digitally 'sign' the Action's
 * arguments plus details about themselves, the time, and information about the particular 
 * Antelope blockchain instance the Action is being called on, with this key.  The entire signed data 
 * blob, including the signature, is called a Transaction.
 * 
 * A suitably constructed Action will prevent the invocation of this Action by anyone except those
 * in the possession of the secret key. Measurement{Earth} Trusted Sensor Platform (ME-TSP) hardware 
 * modules securely embed a secret key that allows the device to invoke an Action to send
 * measured environmental sensor data to the application hosted on an Antelope blockchain.
 * 
 * An ME-TSP module is often located remotely and unable to access the internet directly.
 * In these cases, wireless data transports such as LoRaWAN and satellite are utilized.
 * These transports impose certain restrictions on the amount of data that can be transferred,
 * and transferred at one time.  The Measurement{Earth} Low Power Protocol is designed to 
 * send an Antelope blockchain's transction in smaller chunks.  It is the job of this
 * Antelope platform decoder to piece together these chunks into a complete Transaction, 
 * filling in any missing gaps, and then to submit this Transaction to a normal blockchain API endpoint.
 * 
 * The benefit to sending in smaller chunks is that smaller payloads can be used (albeit more of them).
 * 
 */

/* The goal of this platform processor is to create the transaction JSON object
 * that can be pushed to the '/send_transaction' API from the data sent through the ELPP protocol.
 * 
     {
        "signatures": [
            "SIG_K1_KozSvCUNwYXCPPoEK59qfvuPsBqLPMAdRJbKi3NLKrP6qXeyhKLTMJCUwzReo97KRJeSD6jHDom8vKMXey6C6hLhyvXpap"
        ],
        "compression": false,
        "packed_context_free_data": "",
        "packed_trx": "e5f23660ec64123a7f1d000000000180b1ba1967ea30550000000064278fc601a0129d2164ea3055000000004887337526a0129d2164ea30550b4d452d5453502d524649442d0200000d636238636564642d646972747900"
 */

/* A dispatcher list handles in-flight transactions 
 * This is outside the scope of this module.
 */
dispatcher_queue = {
    0: [],
    1: []
}



/* The decoder is called multiple times to gather all necessary transaction components
 * therefore state must persist outside the scope of the decoder's 'object'.
 * A trx_map tracks components for the same transaction ID.
 * A trx_map must exist independently for each device seen.
 */

var trx_map = {}

function new_trx() {
    return {
        chain : 0,
        signature : null, /* 'SIG_K1...' */
        tapos: null,  /* raw bytes */
        action: null,
        data : null
    }
}

function get_trx(id) {
    var trx
    if (id in trx_map) {
        trx = trx_map[id]
    } else {
        trx = trx_map[id] = new_trx()
    }
    return trx
}

function check_dispatch(trx_id, trx) {
    /* If have all componenents, can convert to JSON and dispatch it to the appropropriate
     * chain dispatcher.  The dispatcher should handle selection of API endpoint, retries, etc.
     */
    log('checking for trx id ' + trx_id + ' complete...')
    if (trx.signature && trx.tapos && trx.action && trx.data) {
        var transaction = {
            signatures: [trx.signature],
            compression: false,
            packed_context_free_data: '',
            packed_trx: Buffer.concat([trx.tapos, trx.action, trx.data]).toString('hex')
        }

        log('transaction complete:')

        let json = JSON.stringify(transaction, null, 2)
        log(json)
        /* Move it to the dispatcher queue for the chain */
        dispatcher_queue[trx.chain].push(json)

        /* Remove the transaction from the map */
        delete trx_map[trx_id]
    }
}

/* Because the Antelope decoder state must persist across invocations of 'decoder()' we don't
 * use the per-decoder-invocation object instance.
 */
var platform = {
    /* Setup the object in a platform specific way */
    pre_process: function (obj) {
        
        
    },
    /* Post process and return the data specific to the platform */
    post_process: function (obj) {

        return obj
    }
}

/* In each of these 'processor' functions, the decoder's decoded output
 * stored in the 'out' array is captured and processed accordingly.
 * The elements of the 'out' array correspond to output from each primitive decoder
 * composing the top-level decoder.  For these Antelope decoders, there are at least
 * two: the header (uint8) is available as out[0], and subsequent data as out[1], out[2], etc.
 * 
 */

function antelope_message_tapos_processor(out, obj) {
    var header = out[0]
    var trx_id = header & 0x7 
    var chain_id = out[1] & 0x7

    var trx = get_trx(trx_id)
    if (trx.tapos == null) {
        trx.chain = chain_id
        trx.tapos = Buffer.from(out[2])
    }
    log('have tapos: ')
    log_obj(trx.tapos)
    check_dispatch(trx_id, trx)
}

function antelope_message_action_processor(out, obj) {
    var header = out[0]
    var trx_id = header & 0x7
    var trx = get_trx(trx_id)
    if (trx.action === null) {
        /* Re-encode the action by inserting the array length fields */
        /* 1 action, dapp name, action name, 1 perm, perm name, actor name */
        var action = []
        action.push(1) /* varuint32 -> encodes '1' as simply 0x1 */
        action = action.concat(out[1])
        action.push(1)
        action = action.concat(out[2])

        trx.action = Buffer.from(action)
    }
    log('have action: ')
    log_obj(trx.action)
    check_dispatch(trx_id, trx)

}

function antelope_message_serialized_action_processor(out, obj) {
    var header = out[0]
    var trx_id = header & 0x7

    var trx = get_trx(trx_id)
    if (trx.data === null) {
        /*  */
        trx.data = Buffer.from(out[2])
    }
    log('have action data: ')
    log_obj(trx.data)
    check_dispatch(trx_id, trx)

}

function antelope_message_signature_processor(out, obj) {

    /* This message provides all signature data so we can generate
     * the string representation now.
     */
    /* The output is a fixed array of bytes containing i, r, s.
     * We can process the array as-is.
     */
    var header = out[0]
    var trx_id = header & 0x7

    var trx = get_trx(trx_id)
    if (trx.signature === null) {
        
        var sig_k1 = check_encode_k1(Buffer.from(out[1]))
        trx.signature = sig_k1
    }
    log('have signature: ')
    log_obj(trx.signature)

    check_dispatch(trx_id, trx)
}

/*------ CUT ------------------------*/
/* Testing */
var crypto = require('crypto');
const elpp = require('./decoder')
const encoder = require('./encoder')
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

    //10: { encoder: encoder.time_encoder, provider: time_provider }
}

var test_vec1 = encoder.encoder([0, 1], encoder_map)
log(Buffer.from(test_vec1).toString('hex'))
var test_vec2 = encoder.encoder([2], encoder_map)
log(Buffer.from(test_vec2).toString('hex'))
var test_vec3 = encoder.encoder([3], encoder_map)
log(Buffer.from(test_vec3).toString('hex'))

var test_vec4 = encoder.encoder([3,2,1,0], encoder_map)
log(Buffer.from(test_vec4).toString('hex'))


var channel_map = {
    0: { decoder: elpp.antelope_message_tapos_decoder, processor: antelope_message_tapos_processor },
    1: { decoder: elpp.antelope_message_action_decoder, processor: antelope_message_action_processor },
    2: { decoder: elpp.antelope_message_serialized_action_decoder, processor: antelope_message_serialized_action_processor },
    3: { decoder: elpp.antelope_message_signature_decoder, processor: antelope_message_signature_processor },
    //10: { decoder: elpp.time_decoder, processor: time_processor }
}


var result1 = elpp.decoder(test_vec1, channel_map, platform)
log_obj(result1)
var result2 = elpp.decoder(test_vec2, channel_map, platform)
log_obj(result2)
var result3 = elpp.decoder(test_vec3, channel_map, platform)
log_obj(result3)

var result4 = elpp.decoder(test_vec4, channel_map, platform)
log_obj(result4)



/*
 * The signature bytes must be processed and base58 encoded into string prepended with "SIG_K1_".
 * The functions below do that.
 */

function check_encode_k1(key_buf) {
    var hash_ripemd = crypto.createHash('ripemd160')
    var buf = Buffer.concat([key_buf, Buffer.from('K1')])
    hash_ripemd.update(buf)
    var checksum = hash_ripemd.digest().slice(0, 4)
    var result = Buffer.concat([key_buf, checksum])
    return 'SIG_K1_' + to_b58(result)
}


/* https://gist.github.com/diafygi/90a3e80ca1c2793220e5/ */
function to_b58(B) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    var d = [], s = "", i, j, c, n; for (var i = 0; i < B.length; i++) { j = 0, c = B[i]; s += c || s.length ^ i ? "" : 1; while (j in d || c) { n = d[j]; n = n ? n * 256 + c : c; c = n / 58 | 0; d[j] = n % 58; j++ } } while (j--) s += A[d[j]]; return s
};



