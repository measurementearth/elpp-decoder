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

require('log-timestamp')
const antelope = require('./decoder-antelope')
const elpp = require('./decoder')
const elpp_encoder = require('./encoder')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }
log('Starting Antelope server')

/* Use 'request' instead of 'http' to handle redirects on endpoints such as Helium downlink URLs */
const { http, https } = require('follow-redirects')
//const http = require('http')
const host = '<your ip here>'
const port = 2000


/* A dispatcher list handles in-flight transactions 
 * per chain.
 */
let dispatch_queue = {
    0: [], /* TELOS TESTNET */
    1: []  /* TELOS MAINNET */
}

/*
 * {
    "payload_raw": "SGVsbG8sIHdvcmxkIQ==",
    "port": 1,
    "confirmed": false
   }

Dispatch the tapos response downlink to the device
 */
function dispatch_tapos(tapos_req, tapos, time_ms, path, res) {


    function tapos_provider() {
        return [
            /* pass back the chain and req ids */
            tapos_req.chain_id,
            tapos_req.req_id,
            /* pass back the gateway time stamp of the request.
             * the device will have stored the timestamp of the transmission
             * along with the request id for lookup later to compute the actual time.
             */
            time_ms / 1000 >> 0,
            time_ms % 1000,
            /* Actual blockchain TAPOS data. */
            tapos.ref_block_num,
            tapos.ref_block_prefix
        ]
    }

    const encoder_map = {
        4: { encoder: elpp_encoder.antelope_message_tapos_resp_encoder, provider: tapos_provider }
    }

    var tapos_encoded = elpp_encoder.encoder([4], encoder_map)

    log('== tapos encoded ==')
    let tbuf = Buffer.from(tapos_encoded)
    log(tbuf.toString('hex'))

    let data = {
        "payload_raw": tbuf.toString('base64'),
        "port": ELPP_PORT_LORAWAN,
        "confirmed": false
    }

    let json = JSON.stringify(data)
    log(json)

    // An object of options to indicate where to post to
    var post_options = {
        host: 'console.helium.com',
        port: '80', /* http - this works */
        path: path,
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
                log('downlink response ' + hres.statusCode)
                res.statusCode = hres.statusCode
                res.end(data)
            }
        })
    })

    /* Ideally if timeouts can be differentiated from other errors - this is when we would want to try again */
    post_req.on('error', (err) => {
        log('downlink POST error: ' + err.message)
        if (res) {
            res.statusCode = 500
            res.end('downlinkn POST error: ' + err.message)
        }
    })

    log('write downlink request: ')
    log_obj(post_options)

    // post the data
    post_req.write(json)
    post_req.end()

}


/* This can be a result of an API request from the remote platform, in which case
 * 'res' will be available to possibly return the result of the blockchain API call.
 * This can also be called as a retry in which case 'res' will be null.
 */
function dispatch_trx(json, host, res, chain_q, chain_q_index) {

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
                dispatch_trx(trx.json, hostFromChain(c), res, chain_q, t)
                trx.started = true
            }
        }
    }
}

function push_trx(trx, state, res) {
    log('push trx')

    if (trx) {

        let epoch = Date.now() / 1000 >> 0
        /* Move it to the dispatcher queue for the chain */
        if (trx.chain in dispatch_queue) {
            log('posting trx to chain ' + trx.chain + ' dispatch queue at ' + dispatch_queue[trx.chain].length)
            dispatch_queue[trx.chain].push({
                epoch: epoch,
                started: false,
                json: trx.json
            })

        } else {
            res.writeHead(500)
            res.end('decoder: unknown chain ' + trx.chain)
        }
    }
    else {
        /* Get the status */
        log('  - no trx')

        let status = antelope.get_status(state.trx_map)
        log(status)

        res.writeHead(200)
        res.end('decoder: need more data\n' + status)
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

    /* Decoder result may have:
     *   trx : {} transaction
     *   tapos_req : request for TAPOS for specified chain
     */

    if (dresult.trx) {
        push_trx(dresult.trx, state, res)
    } else if (dresult.tapos_req) {
        /* get_tapos
         * expect key : "downlink_url" :"https://console.helium.com/api/v1/down/..."
         */
        if (data.downlink_url) {

            /* Expect key "reported_at": 1681833081694 */
            const gw_rx_time_ms = data.reported_at

            const url = new URL(data.downlink_url)

            /* tapos acquisition is a multi-step process 
             Ideally we have it ready to go and can be sent back, perhaps available for the 2nd downlink slot 
             */
            let tapos = tapos_get(dresult.tapos_req.chain_id)

            if (tapos) {
                dispatch_tapos(dresult.tapos_req, tapos, gw_rx_time_ms, url.pathname, res)
            } else {
                res.writeHead(500)
                let msg = 'decoder error: no tapos'
                res.end(msg)
            }
        } else {
            res.writeHead(500)
            let msg = 'decoder error: no downlink url'
            res.end(msg)
        }
    } else {
        res.writeHead(500)
        let msg = 'decoder error: no result'
        res.end(msg)
    }

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

if (1) {
    const server = http.createServer(requestListener);
    server.listen(port, host, () => {
        console.log(`Server is running on http://${host}:${port}`);
    });
} else {
    http.get('http://bit.ly/900913', response => {
        response.on('data', chunk => {
            console.log(chunk);
        });
    }).on('error', err => {
        console.error(err);
    });
}




/* Helium JSON example:
 * {"app_eui":"3454323456432543",
 * "dc":{"balance":111111,"nonce":7},
 * "dev_eui":"2646524545245245",
 * "devaddr":"01231231",
 * "downlink_url":"https://console.helium.com/api/v1/down/ab164223542094820948230482304820427a/a35425452354332221412414114141Oq/13fa3141412413434134134134134134159a","fcnt":209,"hotspots":[{"channel":0,"frequency":903.9,"hold_time":0,"id":"112c4ZLR1G721414141241231231231231235434342342323423","lat":55.462452452406855,"long":-115.24524545234556,"name":"fgsgggsdfggsdgsdfgg","reported_at":1681833081694,"rssi":-42.0,"snr":14.0,"spreading":"SF8BW125","status":"success"}],"id":"24543524524545243543534534534534523a","metadata":{"adr_allowed":false,"cf_list_enabled":false,"multi_buy":1,"organization_id":"45345454534524543545345345345345435f","preferred_hotspots":["452452452454545345345234534534543534523452345345245q"],"rx_delay":1,"rx_delay_actual":1,"rx_delay_state":"rx_delay_established"},"name":"254352543523523452455","payload":"BAA=","payload_size":2,"port":8,"raw_packet":"24545245454543523455","replay":false,"reported_at":1681833081694,"type":"uplink","uuid":"4253454354545345345435345345345345b2"}
 */


/*---- TAPOS manager -----*/


/* errors beyond which it is removed from service for CHECK_MAX
 * number of checks.
 */
const TAPOS_MANAGER_API_ERRORS_MAX = 5
const TAPOS_MANAGER_API_CHECK_MAX = 10

/* Run a manager for each chain */
const KEY_TELOS_TESTNET = 'TELOS_TESTNET'
const KEY_TELOS_MAINNET = 'TELOS_MAINNET'

const CHAIN_KEY_FROM_ID = {
    0: KEY_TELOS_TESTNET,
    1: KEY_TELOS_MAINNET
}

var tapos_manager_state = {
    [KEY_TELOS_TESTNET]: {
        name : KEY_TELOS_TESTNET,
        tapos: {
            acq_time_epoch : 0, /* time of acquisition (not the expiry) */
            ref_block_num: 0,
            ref_block_prefix : 0
        },
        api_pool : [
            { host: 'http://testnet.telos.net', errors: 0, check_count: 0, use_count : 0 }
        ]
    },
    [KEY_TELOS_MAINNET]: {
        name: KEY_TELOS_MAINNET,
        tapos: {
            acq_time_epoch: 0, /* time of acquisition (not the expiry) */
            ref_block_num: 0,
            ref_block_prefix: 0
        },
        api_pool: [
            { host: 'http://mainnet.telos.net', errors: 0, check_count: 0, use_count: 0 }
        ]
    }

}


function tapos_get(chain_id) {
    //log('lookup chain_id ' + chain_id)
    if (chain_id in CHAIN_KEY_FROM_ID) {
        let key = CHAIN_KEY_FROM_ID[chain_id]
        //log('lookup chain_key ' + key)
        if (key in tapos_manager_state) {
            let state = tapos_manager_state[key]
            //log('tapos for ' + state.name)
            return state.tapos
        }
    }
    return null
}

/* Check for tapos within a random window interval */
function tapos_manager_next_run(name, error) {
    let max = 10 * 60 * 1000
    let min = 5 * 60 * 1000
    if (error) {
        /* check again quickly for error */
        max = 30 * 1000
        min = 10 * 1000
    }
    let period = Math.floor(Math.random() * (max - min) + min)
    log('TAPOS manager for ' + name + ' next run in ' + ((period / 1000) >> 0))
    return period
}

/* Kick off */
for (key in tapos_manager_state) {
    let state = tapos_manager_state[key]
    tapos_manager_run(state)
}




function tapos_manager_select_pool(state) {
    /* Do some housekeeping first:
     * slowly decrease errors to allow trying again */
    for (i in state.api_pool) {
        let api = state.api_pool[i]
        if (api.errors >= TAPOS_MANAGER_API_ERRORS_MAX) {
            if (++api.check_count == TAPOS_MANAGER_API_CHECK_MAX) {
                api.errors--
                api.check_count = 0
            }
        }
    }

    let attempts = 10
    let api = null
    do {
        let index = Math.floor(Math.random() * state.api_pool.length)
        api = state.api_pool[index]
    } while (--attempts && api.errors >= TAPOS_MANAGER_API_ERRORS_MAX)

    if (api) {
        api.use_count++;
        log('TAPOS Manager: selected api ' + api.host + ' uses ' + api.use_count + ' errors ' + api.errors + '  check_count ' + api.check_count)
    }
    return api
}

function tapos_manager_error(msg, state, api, timeout) {
    log('TAPOS Manager Error for ' + state.name + ' : ' + msg)

    if (api) {
        api.errors++
    }

    clearTimeout(timeout)
    /* want to try again quickly */
    setTimeout(tapos_manager_run, tapos_manager_next_run(state.name, true), state)
}

function tapos_manager_finish(msg, state, api, timeout) {
    if (api) {
        /* decrement the error counter on a succesful poll */
        if (api.errors > 0) {
            api.errors--
        }
    }
}

function tapos_manager_run(state) {
    let timeout = setTimeout(tapos_manager_run, tapos_manager_next_run(state.name), state)

    let api = tapos_manager_select_pool(state)
    if (api) {
        let url = api.host + '/v1/chain/get_info'
        http.get(url, response => {
            let info = ''
            response.on('data', chunk => {
                info += chunk
            })
            response.on('end', () => {
                try {
                    let json = JSON.parse(info)

                    /* Interestingly, the ref_block_prefix is, converted to hex, embedded in the same
                     * block ID at the 8th byte position in reversed byte order. Which means we can get the 
                     * prefix right from the block id in the get_info request without making an additional request to get_block.
                     */
                    let ref_block_num = json.last_irreversible_block_num & 0xFFFF;
                    let last_irr_block_id = Buffer.from(json.last_irreversible_block_id, 'hex');
                    let ref_block_prefix = last_irr_block_id.readUInt32LE(8);

                    state.tapos.acq_time_epoch = Date().now / 1000 >> 0
                    state.tapos.ref_block_num = ref_block_num
                    state.tapos.ref_block_prefix = ref_block_prefix

                    log('Aquired TAPOS at ' + Date(state.tapos.acq_time_epoch).toString() + ' for ' + state.name + 'ref_block_num: ' + state.tapos.ref_block_num.toString(16) + ' prefix: ' + state.tapos.ref_block_prefix.toString(16))

                    tapos_manager_finish('success', state, api, timeout)

                } catch (e) {
                    let msg = ((e && ('message' in e)) ? e.message : 'unknown')
                    tapos_manager_error(msg, state, api, timeout)
                }

            })
            response.on('error', err => {
                let msg = err
                tapos_manager_error(msg, state, api, timeout)
            })
        }).on('error', err => {
            let msg = err
            tapos_manager_error(msg, state, api, timeout)
        })
    } else {
        tapos_manager_error(msg, state, api, timeout)
    }
}


