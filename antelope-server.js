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

/* This rudementary server is designed to receive data from a Helium Console
 * instance.  The payload, coming from a suitably configured Measurement{Earth}
 * Blockchain sensor module, is passed through the Antelope decoder to reconstruct
 * the transaction in full.  Once reconstructed, the transaction can be
 * submitted to an Antelope blockchain API endpoint.
 */


const antelope = require('./decoder-antelope')
const elpp = require('./decoder')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
log('Starting Antelope server')

const http = require("http");
const host = '<your ip here>';
const port = 2000;


/* A dispatcher list handles in-flight transactions 
 * per chain.
 */
let dispatch_queue = {
    0: [], /* TELOS TESTNET */
    1: []  /* TELOS MAINNET */
}


/* This can be a result of an API request from the remote platform, in which case
 * 'res' will be available to possibly return the result of the blockchain API call.
 * This can also be called as a retry in which case 'res' will be null.
 */
function dispatch(json, host, res, chain_q, chain_q_index) {

    // An object of options to indicate where to post to
    var post_options = {
        host: host,
        port: '80',
        path: '/v1/chain/send_transaction',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json)
        }
    };

    /* Set up and execute the request */
    var post_req = http.request(post_options, function (hres) {
        hres.setEncoding('utf8')
        let data = ''
        hres.on('data', function (chunk) {
            data += chunk
        })
        hres.on('end', () => {
            log(data)
            if (res) {
                log('response ' + hres.statusCode)
                res.statusCode = hres.statusCode
                res.end(data)
            }

            /* remove the trx whether it succeeded or not (assuming that sending it again will not change the situation) */
            if (1 /* res.statusCode == 200 */) {
                chain_q.splice(chain_q_index, 1)
                log('trx removed from queue at ' + chain_q_index)
            }

        })
    })

    /* Ideally if timeouts can be differentiated from other errors - this is when we would want to try again */
    post_req.on('error', (err) => {
        log('POST error: ' + err.message)
        if (res) {
            res.statusCode = 500
            res.end('POST error: ' + err.message)
        }
        if (1 /* res.statusCode == 200 */) {
            chain_q.splice(chain_q_index, 1)
            log('trx removed from queue at ' + chain_q_index)
        }
    })

    log('write request: ')
    log_obj(post_options)

    // post the data
    post_req.write(json)
    post_req.end()

}

function hostFromChain(c) {
    switch (c) {
        case '0':
            return 'testnet.telos.net'
        case '1':
            return 'mainnet.telos.net'
        default:
            throw Error('unsupported chain: ' + c)
    }
}

function manage_dispatch_queue(res) {
    log('manage dispatch queue')
    for (c in dispatch_queue) {
        log('checking chain ' + c)
        let chain_q = dispatch_queue[c]
        /* for each chain, see what is not started and start them. */
        for (t in chain_q) {
            log('checking trx ' + t)
            let trx = chain_q[t]
            if (!trx.started) {
                log('dispatching pending trx at index ' + t)
                dispatch(trx.json, hostFromChain(c), res, chain_q, t)
                trx.started = true
            }
        }
    }
}

function push_trx(dresult, res) {
    log('push trx')

    if (dresult) {

        if (dresult.trx) {

            let epoch = Date.now() / 1000 >> 0
            /* Move it to the dispatcher queue for the chain */
            if (dresult.trx.chain in dispatch_queue) {
                log('posting trx to chain ' + dresult.trx.chain + ' dispatch queue at ' + dispatch_queue[dresult.trx.chain].length)
                dispatch_queue[dresult.trx.chain].push({
                    epoch: epoch,
                    started: false,
                    json: dresult.trx.json
                })

            } else {
                res.writeHead(500)
                res.end('decoder: unknown chain ' + dresult.trx.chain)
            }
        }
        else {
            /* Get the status */
            log('  - no trx')

            let status = antelope.get_status(dresult.state.trx_map)
            log(status)

            res.writeHead(200)
            res.end('decoder: need more data\n' + status)
        }
    }
    else {
        res.writeHead(500)
        res.end('decoder: no result')
    }
}

let device_states = {}


function get_device_state(key) {

    let state
    if (key in device_states) {
        log('existing state for ' + key)
        state = device_states[key]
    } else {
        log('new state for ' + key)
        state = device_states[key] = antelope.new_state()
    }
    /* Add a 'last used' epoch for possible garbage collection */
    state.last_epoch = Date.now() / 1000 >> 0
    return state
}

/* This arbitrarily assigned port is used for ELPP protocol on LORAWAN. */
const ELPP_PORT_LORAWAN           = 8

function decodeHelium(data, res) {
    log('Decode Helium')

    /* Expect key: 'port' */
    if (1 && data.port != ELPP_PORT_LORAWAN) {
        res.writeHead(500)
        let msg = 'Unsupported port: ' + data.port + '. Expect data on port ' + ELPP_PORT_LORAWAN + ' for ELPP.'
        res.end(msg)
        log(msg)
        return
    }

    /* Expect key: 'payload' */
    let payload = Buffer.from(data.payload, 'base64')
    log('Payload: ' + payload.toString('hex'))

    /* Expect key: "dev_eui": "ED2126B2424BF383" */
    let key = data.dev_eui
    log('DevEUI: ' + key)
    let state = get_device_state(key)

    let dresult = antelope.decoder(payload, state)

    push_trx(dresult, res)

    manage_dispatch_queue(res)
}

const requestListener = function (req, res) {

    let data = ''

    if (req.method === 'POST') {
        /* Collect POST data */
        req.on('data', (chunk) => {
            data += chunk
        })

        /* When there is no more data, deal with it */
        req.on('end', () => {
            log(req.url)
            log(req.method)

            log(data)

            try {
                /* The decoder is responsible for sending the response in success or error. */
                decodeHelium(JSON.parse(data), res)
            } catch (e) {
                /* Get a SyntaxError if JSON can't be parsed, for example */
                res.writeHead(500)
                let msg = 'Error: ' + ((e && ('message' in e)) ? e.message : 'unknown')
                log(msg)
                res.end(msg)
            }
        })
    } else {
        res.writeHead(500)
        res.end('Unsuported method ' + req.method)
    }

};

const server = http.createServer(requestListener);
server.listen(port, host, () => {
    console.log(`Server is running on http://${host}:${port}`);
});


