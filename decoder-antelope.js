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
     }
  
  To use this module, the user must supply to the decode function an object to record state for *each device* across messages.
  The object must have an empty object called 'trx_map'
  E.g.:

    var decoder_state = {
        trx_map: { }
    }

 */

const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
const crypto = require('crypto')
const elpp = require('./decoder')



function new_trx() {
    
    return {
        chain : 0,
        signature : null, /* 'SIG_K1...' */
        tapos: null,  /* raw bytes */
        action: null,
        data : null
    }
}

function get_trx(obj, id) {
    var trx
    if (id in obj.state.trx_map) {
        trx = obj.state.trx_map[id]
    } else {
        trx = obj.state.trx_map[id] = new_trx()
    }
    trx.last_epoch = Date.now() / 1000 >> 0
    return trx
}

function check_dispatch(obj, trx_id, trx) {
    /* If have all componenents, can convert to JSON and dispatch it to the appropropriate
     * chain dispatcher.  The dispatcher should handle selection of API endpoint, retries, etc.
     */
    log('checking for trx id ' + trx_id + ' complete...')
    if (trx.signature && trx.tapos && trx.action && trx.data) {
        var transaction = {
            signatures: [trx.signature],
            compression: false,
            packed_context_free_data: '',
            /* To note that there is also a 'context free array' that comes after TAPOS
             * and before ACTION in the serialized data section as well, this must be
             * set to 0.
             */
            packed_trx: Buffer.concat([trx.tapos, Buffer.from([0]), trx.action, trx.data]).toString('hex')
        }

        log('transaction complete:')

        let json = JSON.stringify(transaction, null, 2)
        log(json)


        if (0) {
            let epoch = Date.now() / 1000 >> 0
            /* Move it to the dispatcher queue for the chain */
            obj.state.dispatcher_queue[trx.chain].push({
                epoch: epoch,
                started: false,
                json: json
            })
        }

        /* Return the completed trx with some metadata */
        obj.trx = {
            chain: trx.chain,
            json: json
        }

        /* Remove the transaction from the map */
        delete obj.state.trx_map[trx_id]
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

    var trx = get_trx(obj, trx_id)
    if (trx.tapos == null) {
        trx.chain = chain_id
        var data = Buffer.from(out[2])
        trx.tapos = Buffer.alloc(13)
        /* max net, max cpu, delay sec all 0 */
        data.copy(trx.tapos)
    }
    log('have tapos: ')
    log_obj(trx.tapos)
    check_dispatch(obj, trx_id, trx)
}

function antelope_message_action_processor(out, obj) {
    var header = out[0]
    var trx_id = header & 0x7
    var trx = get_trx(obj, trx_id)
    if (trx.action === null) {
        /* Re-encode the action by inserting the array length fields */
        /* 1 action, dapp name, action name, 1 perm, perm name, actor name */
        trx.action = Buffer.alloc(34)
        trx.action.writeUInt8(1, 0) /* varuint32 -> encodes '1' as simply 0x1 */
        Buffer.from(out[1]).copy(trx.action, 1)
        trx.action.writeUInt8(1, 17) /* varuint32 -> encodes '1' as simply 0x1 */
        Buffer.from(out[2]).copy(trx.action, 18)
    }
    log('have action: ')
    log_obj(trx.action)
    check_dispatch(obj, trx_id, trx)

}

function antelope_message_serialized_action_processor(out, obj) {
    var header = out[0]
    var trx_id = header & 0x7

    var trx = get_trx(obj, trx_id)
    if (trx.data === null) {
        /*  */
        trx.data = Buffer.from(out[2])
    }
    log('have action data: ')
    log_obj(trx.data)
    check_dispatch(obj, trx_id, trx)

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

    var trx = get_trx(obj, trx_id)
    if (trx.signature === null) {
        
        var sig_k1 = check_encode_k1(Buffer.from(out[1]))
        trx.signature = sig_k1
    }
    log('have signature: ')
    log_obj(trx.signature)

    check_dispatch(obj, trx_id, trx)
}


function antelope_message_tapos_req_processor(out, obj) {
    log('need tapos')
    /* return request to the server */
    obj.tapos_req = {
        chain_id: out[0],
        req_id : out[1]
    }
}


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


var channel_map = {
    0: { decoder: elpp.antelope_message_tapos_decoder, processor: antelope_message_tapos_processor },
    1: { decoder: elpp.antelope_message_action_decoder, processor: antelope_message_action_processor },
    2: { decoder: elpp.antelope_message_serialized_action_decoder, processor: antelope_message_serialized_action_processor },
    3: { decoder: elpp.antelope_message_signature_decoder, processor: antelope_message_signature_processor },
    4: { decoder: elpp.antelope_message_tapos_req_decoder, processor: antelope_message_tapos_req_processor },
}

/* The antenlope decoder returns:
 *   trx : {}  This contains the complete JSON transaction (in json property) structure decoded from uplinked data.
 *             It can be pushed to the v1 chain APIs.
 *   tapos_req : { chain } If present this means a tapos request was decoded. Contains a 'chain' property.
 */
function decoder(payload, state) {
    /* Because the Antelope decoder state must persist across invocations of 'decoder()' we 
     * must setup the decoder's transient state object with our persistent decoder state.
     */
    var platform = {
        /* Setup the object in a platform specific way */
        pre_process: function (obj) {
            obj.state = state /* persistent state */

        },
        /* Post process and return the data specific to the platform */
        post_process: function (obj) {

            return obj
        }
    }

    return elpp.decoder(payload, channel_map, platform)
}

function get_status(trx_map) {
    /* print all active IDs and what they are waiting for */
    let str = ''
    for (i in trx_map) {
        let trx = trx_map[i]
        str += 'trx ' + i
        if (!trx.signature) {
            str += ' needs'
        } else {
            str += ' has'
        }
        str += ' signature'

        if (!trx.tapos) {
            str += ' needs'
        } else {
            str += ' has'
        }
        str += ' tapos'

        if (!trx.action) {
            str += ' needs'
        } else {
            str += ' has'
        }
        str += ' action'

        if (!trx.data) {
            str += ' needs'
        } else {
            str += ' has'
        }

        str += ' data\n'
    }
    return str
}

function new_state() {
    return {
        trx_map: {}
    }
}

module.exports = {
    decoder,
    get_status,
    new_state
}
