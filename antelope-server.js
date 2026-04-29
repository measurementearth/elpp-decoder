/*
Copyright (c) 2023-2026 Firmware Modules Inc.

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

/* Use 'request' instead of 'http' to handle redirects on endpoints such as Helium downlink URLs */
const { http, https } = require('follow-redirects')
const fs = require('fs')
const path = require('path')
//const http = require('http')

/* Setup server based on passed-in arguments:
 *   arg1: network interface name to search for ipv4 address, or if not found, ip-address to listen on
 *   arg2: server's port
 */
const os = require('os')
const networkInterfaces = os.networkInterfaces()

let host = 'localhost'
let port = 2000

const args = process.argv.slice(2);
if (args && args.length >= 2) {

    /* First arg is:
     *   (a) : the network interface name to look up for first ipv4 family address, or
     *   (b) : the host
     */
    let iface = args[0]
    if (iface in networkInterfaces) {
        let addrs = networkInterfaces[iface]
        for (i in addrs) {
            if (addrs[i].family && addrs[i].family.toLowerCase() === 'ipv4') {
                host = addrs[i].address
                log('found ' + host + ' in ' + iface)
                break
            }
        }
    } else {
        let ifaces = ''
        for (i in networkInterfaces) {
            ifaces += i + ', '
        }
        log('could not find ' + iface + ' in [' + ifaces + ']')
        host = iface
    }

    /* port is second arg */
    port = parseInt(args[1])

} else {
    log('need arguments: <iface-name|ip-addr> <port>')
    log('choose from:')
    for (iface in networkInterfaces) {
        log("  - " + "'" + iface + "'")
    }
    process.exit(1)
}

log('Starting ELPP Antelope server on ' + host + ':' + port)


/* Run a manager for each chain */
const KEY_TELOS_TESTNET = 'TELOS_TESTNET'
const KEY_TELOS_MAINNET = 'TELOS_MAINNET'

/* Map integer chain IDs to a keys in the chain state object
These IDs are defined and fixed protocol-wide and end-to-end, meaning the devices
themselves are transmitting data referencing these chain IDs */
const CHAIN_KEY_FROM_ID = {
    0: KEY_TELOS_TESTNET,
    1: KEY_TELOS_MAINNET
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
        "port": ELPP_PORT_EOS_LORAWAN,
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

function remove_trx(chain_q, chain_q_index) {
    log("trx for '" + chain_q[chain_q_index].key + "' removed from queue at " + chain_q_index)
    chain_q.splice(chain_q_index, 1)
}

/* This can be a result of an API request from the remote platform, in which case
 * 'res' will be available to possibly return the result of the blockchain API call.
 * This can also be called as a retry in which case 'res' will be null.
 */
/* dispatch_trx: send a transaction to the given API endpoint.
 * On HTTP 200 success the trx is removed from the queue.
 * On any failure the trx is left in the queue (started=false) so it can be retried.
 * Returns true if the request was initiated (does not mean it succeeded).
 */
function dispatch_trx(json, api, res, chain_q, chain_q_index) {

    const use_https = api.method === 'https://'
    const transport = use_https ? https : http

    // An object of options to indicate where to post to
    var post_options = {
        host: api.host,
        port: use_https ? '443' : '80',
        path: '/v1/chain/send_transaction',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json)
        }
    };

    /* Mark in-flight so manage_dispatch_queues won't re-dispatch while pending */
    chain_q[chain_q_index].started = true

    /* Set up and execute the request */
    var post_req = transport.request(post_options, function (hres) {
        hres.setEncoding('utf8')
        let data = ''
        hres.on('data', function (chunk) {
            data += chunk
        })
        hres.on('end', () => {
            log(data)
            if (hres.statusCode >= 200 && hres.statusCode < 300) {
                log('trx dispatch success (' + hres.statusCode + ') via ' + api.host)
                if (res) {
                    res.statusCode = hres.statusCode
                    res.end(data)
                }
                /* Only remove on confirmed success */
                remove_trx(chain_q, chain_q_index)
            } else {
                /* Check if the error is unrecoverable — if so, drop the trx immediately */
                let drop = false
                try {
                    let errBody = JSON.parse(data)
                    if (errBody && errBody.error && TRX_UNRECOVERABLE_ERROR_CODES.has(errBody.error.code)) {
                        log('trx unrecoverable error ' + errBody.error.code + ' (' + (errBody.error.name || '?') + ') via ' + api.host + ', dropping trx')
                        drop = true
                    }
                } catch (_) {}

                if (res) {
                    res.statusCode = hres.statusCode
                    res.end(data)
                }

                /* record unable to send as an error associated with the AP, whether dropped or scheduled for retry */
                api.errors++
                let _dev1 = chain_q[chain_q_index] && device_states[chain_q[chain_q_index].key]
                if (_dev1) _dev1.trx_errors++

                if (drop) {
                    if (chain_q[chain_q_index]) {
                        /* Increment unrecoverable drop counters for the correct chain */
                        let chain_key = chain_q[chain_q_index].chain_key
                        let cstats = (chain_key && server_stats[chain_key]) ? server_stats[chain_key] : null
                        if (cstats) {
                            cstats.trx_dropped_total++
                            cstats.trx_dropped_unrecoverable++
                            try {
                                let errBody = JSON.parse(data)
                                let code = errBody.error.code
                                cstats.unrecoverable_errors[code] = (cstats.unrecoverable_errors[code] || 0) + 1
                            } catch (_) {}
                        }
                        remove_trx(chain_q, chain_q_index)
                    }
                } else {

                    if (chain_q[chain_q_index]) {
                        chain_q[chain_q_index].attempts++
                        let attempts = chain_q[chain_q_index].attempts
                        if (attempts >= TRX_MAX_ATTEMPTS) {
                            log('trx dispatch failed (' + hres.statusCode + ') via ' + api.host + ', max attempts (' + TRX_MAX_ATTEMPTS + ') reached, dropping')
                            let chain_key = chain_q[chain_q_index].chain_key
                            let cstats = (chain_key && server_stats[chain_key]) ? server_stats[chain_key] : null
                            if (cstats) { cstats.trx_dropped_total++; cstats.trx_dropped_other++ }
                            remove_trx(chain_q, chain_q_index)
                        } else {
                            log('trx dispatch failed (' + hres.statusCode + ') via ' + api.host + ', attempt ' + attempts + '/' + TRX_MAX_ATTEMPTS + ', will retry')
                            chain_q[chain_q_index].started = false
                        }
                    }
                }
            }
        })
        hres.on('error', (err) => {
            api.errors++
            let _dev2 = chain_q[chain_q_index] && device_states[chain_q[chain_q_index].key]
            if (_dev2) _dev2.trx_errors++
            log('POST xfer error via ' + api.host + ': ' + err.message)
            if (res) {
                res.statusCode = 500
                res.end('POST xfer error: ' + err.message)
            }
            if (chain_q[chain_q_index]) {
                chain_q[chain_q_index].attempts++
                let attempts = chain_q[chain_q_index].attempts
                if (attempts >= TRX_MAX_ATTEMPTS) {
                    log('trx xfer error, max attempts (' + TRX_MAX_ATTEMPTS + ') reached, dropping')
                    let chain_key = chain_q[chain_q_index].chain_key
                    let cstats = (chain_key && server_stats[chain_key]) ? server_stats[chain_key] : null
                    if (cstats) { cstats.trx_dropped_total++; cstats.trx_dropped_other++ }
                    remove_trx(chain_q, chain_q_index)
                } else {
                    chain_q[chain_q_index].started = false
                }
            }
        })
    })

    /* Network-level error: leave trx in queue for retry (up to max attempts) */
    post_req.on('error', (err) => {
        api.errors++
        let _dev3 = chain_q[chain_q_index] && device_states[chain_q[chain_q_index].key]
        if (_dev3) _dev3.trx_errors++
        log('POST error via ' + api.host + ': ' + err.message)
        if (res) {
            res.statusCode = 500
            res.end('POST error: ' + err.message)
        }
        if (chain_q[chain_q_index]) {
            chain_q[chain_q_index].attempts++
            let attempts = chain_q[chain_q_index].attempts
            if (attempts >= TRX_MAX_ATTEMPTS) {
                log('trx POST error, max attempts (' + TRX_MAX_ATTEMPTS + ') reached, dropping')
                let chain_key = chain_q[chain_q_index].chain_key
                let cstats = (chain_key && server_stats[chain_key]) ? server_stats[chain_key] : null
                if (cstats) { cstats.trx_dropped_total++; cstats.trx_dropped_other++ }
                remove_trx(chain_q, chain_q_index)
            } else {
                chain_q[chain_q_index].started = false
            }
        }
    })

    log('write request to ' + api.method + api.host + ':')
    log_obj(post_options)

    // post the data
    post_req.write(json)
    post_req.end()

}


/* Try to send transactions pending in each chain's dispatch queue.
 * For each queued trx that is not in-flight, try every valid AP in the pool
 * until one accepts the dispatch (started=true while in-flight).
 * The trx is only removed from the queue on HTTP 200 success (inside dispatch_trx).
 */
function manage_dispatch_queues(res) {
    log('manage dispatch queues')
    for (let c in tapos_manager_state) {
        let state = tapos_manager_state[c]
        let chain_q = state.dispatch_queue
        log('checking chain state ' + c + ', queue has ' + chain_q.length + ' items')
        for (let t = 0; t < chain_q.length; t++) {
            let trx = chain_q[t]
            log('checking trx ' + t + ' started=' + trx.started)
            if (!trx.started) {
                /* Collect all valid APs, pick one at random, then try the rest in order on failure */
                let valid_aps = state.api_pool.filter(a => a.valid && a.enabled !== false)
                if (valid_aps.length > 0) {
                    /* Shuffle: pick a random starting index */
                    let start = Math.floor(Math.random() * valid_aps.length)
                    let api = valid_aps[start]
                    log("dispatching pending trx for '" + trx.key + "' at index " + t + " to '" + api.host + "' (randomly selected from " + valid_aps.length + " valid APs)")
                    api.trx_count++
                    dispatch_trx(trx.json, api, res, chain_q, t)
                } else {
                    log('warning: no valid AP available for dispatch')
                }
            }
        }
    }
}

function push_trx(trx, state, res) {
    log('push trx')

    if (trx) {

        let epoch = Date.now() / 1000 >> 0
        /* Move it to the dispatcher queue for the chain */
        let dispatch_queue = dispatch_get(trx.chain)
        if (dispatch_queue) {
            let chain_key = CHAIN_KEY_FROM_ID[trx.chain] || null
            log('posting trx to chain ' + trx.chain + ' (' + chain_key + ') dispatch queue at ' + dispatch_queue.length)
            dispatch_queue.push({
                epoch: epoch,
                started: false,
                attempts: 0,          /* number of dispatch attempts made so far */
                json: trx.json,
                key: state.key,       /* propagate device key */
                chain_key: chain_key  /* propagate chain key for per-chain stats */
            })

            state.trx_count++
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

/* Temporary state for each communicating device to manage transaction reconstruction */
let device_states = {}


function manage_device_state(state, key) {
    log('Managing device ['+ key +'] state:')
    if (state.trx_map) {
        for (i in state.trx_map) {
            let trx = state.trx_map[i]

            if (trx.last_epoch) {
                let trx_epoch = trx.last_epoch
                let now_epoch = Date.now() / 1000 >> 0

                let age = now_epoch - trx_epoch
                /* Period before purging is adjustable and depends on
                 * the frequency of device measurements and uplinks
                 * and the number of possible trx_ids.
                 */
                if ((age) > 300) {
                    delete state.trx_map[i]
                    log('  - Purging device state trx ' + i + ', age too old: ' + age)
                } else {
                    log('  - Device state trx ' + i + ' age ok: ' + age)
                }
            }
        }
    }
}

function get_device_state(key) {

    let state
    if (key in device_states) {
        log('existing state for ' + key)
        state = device_states[key]
        /* perform state maintenance like purging old/incomplete trx
         * before it is handed to the decoder
         * */
        manage_device_state(state, key)
    } else {
        log('new state for ' + key)
        state = device_states[key] = antelope.new_state()
        state.first_epoch = Date.now() / 1000 >> 0
        state.trx_count = 0
        state.trx_errors = 0
    }
    /* Add a 'last used' epoch for possible garbage collection */
    state.last_epoch = Date.now() / 1000 >> 0
    /* Record device eui for transaction tracing */
    state.key = key
    return state
}

/* This assigned port is used for Antelope ELPP protocol messages on LORAWAN.
The channel map associated with this port is fixed on both ends of the link and MUST NOT CHANGE. */
const ELPP_PORT_EOS_LORAWAN             = 8

function decodeHelium(data, res) {
    log('Decode Helium')

    /* Expect key: 'port' */
    if (1 && data.port != ELPP_PORT_EOS_LORAWAN) {
        res.writeHead(500)
        let msg = 'Unsupported port: ' + data.port + '. Expect data on port ' + ELPP_PORT_EOS_LORAWAN + ' for ELPP.'
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

    /* Record downlink URL for future forced dispatches (e.g. from dashboard) */
    state.downlink_url = data.downlink_url

    /* Decoder result may have:
     *   trx : {} transaction
     *   tapos_req : request for TAPOS for specified chain
     *   or nothing if waiting for more data
     */

    if (dresult && dresult.trx) {
        push_trx(dresult.trx, state, res)
    } else if (dresult && dresult.tapos_req) {
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
                state.last_tapos_dispatched = {
                    chain_id: dresult.tapos_req.chain_id,
                    req_id: dresult.tapos_req.req_id,
                    ref_block_num: tapos.ref_block_num,
                    ref_block_prefix: tapos.ref_block_prefix.toString(16),
                    acq_time_epoch: tapos.acq_time_epoch,
                    source_host: tapos.source_host || null,
                    dispatch_epoch: Date.now() / 1000 >> 0
                }
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

    } else if (dresult) {
        /* Get the status */
        log('  - no trx')

        let status = antelope.get_status(state.trx_map)
        log(status)

        res.writeHead(200)
        res.end('decoder: need more data\n' + status)
    }
    else {
        res.writeHead(500)
        let msg = 'decoder error: no result'
        res.end(msg)
    }

    manage_dispatch_queues(res)
}

/* Main HTTP listener: keep POST behavior for Helium console requests */
const requestListener = function (req, res) {
    if (req.method === 'POST') {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => {
            log(req.url)
            log(req.method)
            log(data)
            try {
                decodeHelium(JSON.parse(data), res)
            } catch (e) {
                res.writeHead(500)
                let msg = 'Error: ' + ((e && ('message' in e)) ? e.message : 'unknown')
                log(msg)
                res.end(msg)
            }
        })
        return
    }

    res.writeHead(500)
    res.end('Unsupported method ' + req.method)
};

/* Dashboard listener: serves static UI and JSON endpoints on a fixed port */
const DASHBOARD_PORT = 3000
const dashboardListener = function (req, res) {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
    const reqPath = req.url.split('?')[0]

    if (reqPath === '/' ) {
        res.writeHead(302, { 'Location': '/dashboard' })
        res.end()
        return
    }

    if (reqPath === '/api/device_states') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(device_states))
        return
    }

    if (reqPath === '/api/tapos_manager_state') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(tapos_manager_state))
        return
    }

    if (reqPath === '/api/tapos_refresh') {
        /* Reload AP config from file, then check ALL APs across ALL chains in parallel */
        log('Dashboard: immediate TAPOS refresh requested for all APs')
        load_antelope_config()
        tapos_refresh_all().then(() => {
            let summary = tapos_ap_status_summary()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(summary))
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
        })
        return
    }

    if (reqPath === '/api/server_stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(server_stats))
        return
    }

    if (reqPath === '/api/dispatch_tapos') {
        /* Dispatch current TAPOS to all devices on the specified chain that have a downlink URL.
         * Query param: chain=TELOS_TESTNET or chain=TELOS_MAINNET
         */
        const params = new URLSearchParams(req.url.split('?')[1] || '')
        const chain_key = params.get('chain')

        /* Resolve chain_key to integer chain_id */
        let chain_id = null
        for (let id in CHAIN_KEY_FROM_ID) {
            if (CHAIN_KEY_FROM_ID[id] === chain_key) { chain_id = parseInt(id); break }
        }

        if (chain_id === null || !(chain_key in tapos_manager_state)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unknown or missing chain parameter' }))
            return
        }

        let tapos = tapos_manager_state[chain_key].tapos
        if (!tapos || tapos.ref_block_num === 0) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'no valid TAPOS available for chain ' + chain_key }))
            return
        }

        /* Find all devices that have communicated on this chain and have a downlink URL */
        let dispatched = []
        let skipped = []
        for (let dev_key in device_states) {
            let dev = device_states[dev_key]
            if (dev.last_tapos_dispatched && dev.last_tapos_dispatched.chain_id === chain_id && dev.downlink_url) {
                try {
                    let url = new URL(dev.downlink_url)
                    let tapos_req = { chain_id: chain_id, req_id: 0 }
                    log('Dashboard: force-dispatching TAPOS to device ' + dev_key + ' on chain ' + chain_key)
                    dispatch_tapos(tapos_req, tapos, 0, url.pathname, null)
                    dispatched.push(dev_key)
                } catch (e) {
                    log('Dashboard: error dispatching TAPOS to device ' + dev_key + ': ' + e.message)
                    skipped.push({ key: dev_key, error: e.message })
                }
            } else if (dev.last_tapos_dispatched && dev.last_tapos_dispatched.chain_id === chain_id) {
                skipped.push({ key: dev_key, error: 'no downlink_url' })
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ chain: chain_key, dispatched: dispatched, skipped: skipped }))
        return
    }

    if (reqPath === '/api/ap_status') {
        /* Return a clean per-AP status summary for the dashboard */
        let summary = {}
        for (let c in tapos_manager_state) {
            let state = tapos_manager_state[c]
        summary[c] = state.api_pool.map(api => ({
            host: api.host,
            method: api.method,
            enabled: api.enabled !== false,
            valid: api.valid,
            errors: api.errors,
            use_count: api.use_count,
            trx_count: api.trx_count,
            version_found: api.version_found
        }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(summary))
        return
    }

    if (reqPath === '/dashboard' || reqPath.startsWith('/dashboard/')) {
        let relPath = reqPath === '/dashboard' ? '/index.html' : reqPath.replace('/dashboard', '')
        let filePath = path.join(__dirname, 'dashboard', relPath)
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404)
                res.end('Not found')
            } else {
                let ext = path.extname(filePath).toLowerCase()
                let type = 'text/plain'
                if (ext === '.html') type = 'text/html'
                else if (ext === '.js') type = 'application/javascript'
                else if (ext === '.css') type = 'text/css'
                else if (ext === '.json') type = 'application/json'
                res.writeHead(200, { 'Content-Type': type })
                res.end(data)
            }
        })
        return
    }

    res.writeHead(404)
    res.end('Not found')
}

if (1) {
    const server = http.createServer(requestListener);
    server.listen(port, host, () => {
        console.log(`Server is running on http://${host}:${port}`);
    });
    /* Start dashboard server on fixed port bound to same interface */
    const dashboardServer = http.createServer(dashboardListener)
    dashboardServer.listen(DASHBOARD_PORT, host, () => {
        console.log(`Dashboard is available on http://${host}:${DASHBOARD_PORT}/dashboard`)
    })
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

/* Per-chain statistics helper — returns a fresh stats object */
function make_chain_stats() {
    return {
        trx_dropped_total: 0,           /* total trx forcibly removed from queue without success */
        trx_dropped_unrecoverable: 0,   /* dropped due to a known unrecoverable Antelope error code */
        trx_dropped_other: 0,           /* dropped for other reasons (e.g. age/timeout expiry) */
        unrecoverable_errors: {}        /* per-error-code hit counts, e.g. { 3040007: 5 } */
    }
}

/* Global server statistics — one entry per chain, keyed by chain name */
const server_stats = {
    [KEY_TELOS_TESTNET]: make_chain_stats(),
    [KEY_TELOS_MAINNET]: make_chain_stats()
}

/* Maximum number of dispatch attempts before a retryable trx is dropped */
const TRX_MAX_ATTEMPTS = 5

/* Antelope error codes that indicate the transaction itself is permanently invalid.
 * Retrying against a different AP will not help — drop the trx immediately on these.
 * Reference: https://github.com/AntelopeIO/leap/blob/main/libraries/chain/include/eosio/chain/exceptions.hpp
 */
const TRX_UNRECOVERABLE_ERROR_CODES = new Set([
    // ---------------------------------------------
    // Transaction exceptions (304xxxx)
    // ---------------------------------------------
    3040000,  // transaction_exception
    3040001,  // tx_decompression_error
    3040002,  // tx_no_action
    3040003,  // tx_no_auths
    3040004,  // cfa_irrelevant_auth
    3040005,  // expired_tx_exception
    3040006,  // tx_exp_too_far_exception
    3040007,  // invalid_ref_block_exception
    3040008,  // tx_duplicate
    3040009,  // deferred_tx_duplicate
    3040010,  // cfa_inside_generated_tx
    3040011,  // tx_not_found
    3040012,  // too_many_tx_at_once
    3040013,  // tx_too_big
    3040014,  // unknown_transaction_compression
    3040015,  // invalid_transaction_extension
    3040016,  // ill_formed_deferred_transaction_generation_context
    3040017,  // disallowed_transaction_extensions_bad_block_exception
    3040018,  // tx_resource_exhaustion

    // ---------------------------------------------
    // Authorization exceptions (309xxxx)
    // ---------------------------------------------
    3090000,  // authorization_exception
    3090001,  // tx_duplicate_sig
    3090002,  // tx_irrelevant_sig
    3090003,  // unsatisfied_authorization
    3090004,  // missing_auth_exception
    3090005,  // irrelevant_auth_exception
    3090006,  // insufficient_delay_exception
    3090007,  // invalid_permission
    3090008,  // unlinkable_min_permission_action
    3090009,  // invalid_parent_permission

    // ---------------------------------------------
    // Action validation exceptions (305xxxx)
    // ---------------------------------------------
    3050000,  // action_validate_exception
    3050001,  // account_name_exists_exception
    3050002,  // invalid_action_args_exception
    3050003,  // eosio_assert_message_exception
    3050004,  // eosio_assert_code_exception
    3050005,  // action_not_found_exception
    3050006,  // action_data_and_struct_mismatch
    3050007,  // unaccessible_api
    3050008,  // abort_called
    3050009,  // inline_action_too_big
    3050010,  // unauthorized_ram_usage_increase
    3050011,  // restricted_error_code_exception
    3050014,  // action_return_value_exception
])


var tapos_manager_state = {
    [KEY_TELOS_TESTNET]: {
        name : KEY_TELOS_TESTNET,
        hash : '1eaa0824707c8c16bd25145493bf062aecddfeb56c736f6ba6397f3195f33c9f',
        tapos: {
            acq_time_epoch : 0, /* time of acquisition (not the expiry) */
            ref_block_num: 0,
            ref_block_prefix : 0
        },
        api_pool : [],
        pool_index : 0, /* round-robin index for TAPOS health checks */
        api_last : null, /* last API successfully used to acquire TAPOS */
        dispatch_queue : []
    },
    [KEY_TELOS_MAINNET]: {
        name: KEY_TELOS_MAINNET,
        hash : '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11',
        tapos: {
            acq_time_epoch: 0, /* time of acquisition (not the expiry) */
            ref_block_num: 0,
            ref_block_prefix: 0
        },
        api_pool: [],
        pool_index : 0, /* round-robin index for TAPOS health checks */
        api_last : null, /* last API successfully used to acquire TAPOS */
        dispatch_queue : []
    }
}

/* Get the TAPOS data associated with the given chain ID value */
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

/* Get the dispatch queue associated with the given chain ID value */
function dispatch_get(chain_id) {
    //log('lookup chain_id ' + chain_id)
    if (chain_id in CHAIN_KEY_FROM_ID) {
        let key = CHAIN_KEY_FROM_ID[chain_id]
        //log('lookup chain_key ' + key)
        if (key in tapos_manager_state) {
            let state = tapos_manager_state[key]
            //log('tapos for ' + state.name)
            return state.dispatch_queue
        }
    }
    return null
}

/* Get the last used API associated with the given chain ID value */
function api_get(chain_id) {
    //log('lookup chain_id ' + chain_id)
    if (chain_id in CHAIN_KEY_FROM_ID) {
        let key = CHAIN_KEY_FROM_ID[chain_id]
        //log('lookup chain_key ' + key)
        if (key in tapos_manager_state) {
            let state = tapos_manager_state[key]
            //log('tapos for ' + state.name)
            return state.api_last
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

/* Load AP pool definitions from antelope-config.json and merge into tapos_manager_state.
 * Existing APs (matched by host+method) retain their runtime stats; new APs get fresh defaults;
 * APs no longer in the file are removed.
 */
function load_antelope_config() {
    const config_path = path.join(__dirname, 'antelope-config.json')
    let config
    try {
        config = JSON.parse(fs.readFileSync(config_path, 'utf8'))
    } catch (e) {
        log('load_antelope_config: failed to read ' + config_path + ': ' + (e.message || e))
        return
    }
    for (let chain_key in config) {
        let state = tapos_manager_state[chain_key]
        if (!state) {
            log('load_antelope_config: unknown chain key "' + chain_key + '" in config, skipping')
            continue
        }
        let new_hosts = config[chain_key]
        let old_pool = state.api_pool

        /* Build updated pool: preserve existing AP objects, add new ones */
        let updated_pool = new_hosts.map(entry => {
            let enabled = entry.enabled !== false
            let existing = old_pool.find(a => a.host === entry.host && a.method === entry.method)
            if (existing) {
                existing.enabled = enabled
                return existing
            }
            return { method: entry.method, host: entry.host, enabled: enabled, valid: false, errors: 0, check_count: 0, use_count: 0, trx_count: 0, version_found: '' }
        })

        let removed = old_pool.filter(a => !new_hosts.some(e => e.host === a.host)).length
        state.api_pool = updated_pool
        log('load_antelope_config: ' + chain_key + ' pool updated — ' + updated_pool.length + ' APs (' + removed + ' removed)')
    }
}

/* On startup: load config, immediately refresh all APs in parallel, then start the periodic per-chain manager */
load_antelope_config()
tapos_refresh_all().then(() => {
    log('Startup AP refresh complete')
    for (let key in tapos_manager_state) {
        let manager_state = tapos_manager_state[key]
        setTimeout(tapos_manager_run, tapos_manager_next_run(manager_state.name), manager_state)
    }
})




/* Build the AP status summary object used by /api/ap_status and /api/tapos_refresh */
function tapos_ap_status_summary() {
    let summary = {}
    for (let c in tapos_manager_state) {
        let state = tapos_manager_state[c]
        summary[c] = state.api_pool.map(api => ({
            host: api.host,
            method: api.method,
            enabled: api.enabled !== false,
            valid: api.valid,
            errors: api.errors,
            use_count: api.use_count,
            trx_count: api.trx_count,
            version_found: api.version_found
        }))
    }
    return summary
}

/* Parse a get_info JSON response, validate the chain hash, update state.tapos and api fields.
 * Throws on hash mismatch or parse error so callers can handle the failure uniformly.
 */
function tapos_process_get_info(json, state, api) {
    const ref_block_num = json.last_irreversible_block_num & 0xFFFF
    const last_irr_block_id = Buffer.from(json.last_irreversible_block_id, 'hex')
    /* Interestingly, the ref_block_prefix is, converted to hex, embedded in the same
        * block ID at the 8th byte position in reversed byte order. Which means we can get the
        * prefix right from the block id in the get_info request without making an additional request to get_block.
        */
    const ref_block_prefix = last_irr_block_id.readUInt32LE(8)
    const hash = json.chain_id
    if (hash !== state.hash) {
        throw new Error("chain hash mismatch for '" + api.host + "'")
    }
    const acq_time_epoch = Date.now() / 1000 >> 0
    state.tapos.acq_time_epoch = acq_time_epoch
    state.tapos.ref_block_num = ref_block_num
    state.tapos.ref_block_prefix = ref_block_prefix
    api.version_found = json.server_version_string
    api.valid = true
    state.api_last = api
    /* Record which AP supplied the chain-level TAPOS */
    state.tapos.source_host = api.host
    /* Record the TAPOS obtained from this specific AP */
    api.tapos = {
        ref_block_num: ref_block_num,
        ref_block_prefix: ref_block_prefix.toString(16),
        acq_time_epoch: acq_time_epoch
    }
}

/* Check a single AP and update its state. Returns a Promise that always resolves (never rejects). */
function tapos_check_ap(state, api) {
    return new Promise(resolve => {
        const use_https = api.method === 'https://'
        const transport = use_https ? https : http
        const url = api.method + api.host + '/v1/chain/get_info'

        log("tapos_refresh: checking '" + api.host + "'")
        api.use_count++

        transport.get(url, response => {
            let info = ''
            response.on('data', chunk => { info += chunk })
            response.on('end', () => {
                try {
                    tapos_process_get_info(JSON.parse(info), state, api)
                    log("tapos_refresh: '" + api.host + "' valid, version=" + api.version_found)
                } catch (e) {
                    api.valid = false
                    api.errors++
                    log("tapos_refresh: '" + api.host + "' invalid: " + (e.message || e))
                }
                resolve()
            })
            response.on('error', err => {
                api.valid = false
                api.errors++
                log("tapos_refresh: '" + api.host + "' error: " + (err.message || err))
                resolve()
            })
        }).on('error', err => {
            api.valid = false
            api.errors++
            log("tapos_refresh: '" + api.host + "' error: " + (err.message || err))
            resolve()
        })
    })
}

/* Check ALL APs across ALL chains in parallel. Returns a Promise that resolves when all are done. */
function tapos_refresh_all() {
    let promises = []
    for (let c in tapos_manager_state) {
        let state = tapos_manager_state[c]
        for (let i = 0; i < state.api_pool.length; i++) {
            if (state.api_pool[i].enabled !== false) {
                promises.push(tapos_check_ap(state, state.api_pool[i]))
            }
        }
    }
    return Promise.all(promises)
}

/* Round-robin: select the next AP in the pool to health-check.
 * Advances pool_index each call so every AP is checked in turn each cycle.
 */
function tapos_manager_select_pool(state) {
    let pool = state.api_pool
    if (!pool || pool.length === 0) return null

    /* Advance round-robin index */
    let index = state.pool_index % pool.length
    state.pool_index = (index + 1) % pool.length

    let api = pool[index]
    if (api.enabled === false) {
        log("TAPOS Manager: skipping disabled api '" + api.host + "'")
        return null
    }
    api.use_count++
    log("TAPOS Manager: checking api '" + api.host + "' (index " + index + ') uses ' + api.use_count + ' errors ' + api.errors)
    return api
}

function tapos_manager_error(msg, state, api, timeout) {
    log('TAPOS Manager Error for ' + state.name + ' : ' + msg)

    if (api) {
        api.errors++
        api.valid = false
        log("TAPOS Manager: marked '" + api.host + "' invalid (errors=" + api.errors + ')')
    }

    clearTimeout(timeout)
    /* Schedule next check — use fast retry only if ALL APs are invalid */
    let anyValid = state.api_pool.some(a => a.valid)
    setTimeout(tapos_manager_run, tapos_manager_next_run(state.name, !anyValid), state)
}

function tapos_manager_finish(state, api) {
    if (api) {
        // /* Decrement error counter on a successful poll */
        // if (api.errors > 0) {
        //     api.errors--
        // }
        /* Mark this AP as valid and record it as the last successful AP */
        api.valid = true
        state.api_last = api
        log("TAPOS Manager: marked '" + api.host + "' valid")
    }
}

/* tapos_manager_run: called periodically for each chain.
 * Checks one AP per invocation (round-robin).  Each AP is independently
 * marked valid/invalid based on whether TAPOS can be acquired from it.
 * The next run is scheduled unconditionally so all APs are polled over time.
 */
function tapos_manager_run(state) {
    /* Schedule the next check for this chain regardless of outcome */
    let timeout = setTimeout(tapos_manager_run, tapos_manager_next_run(state.name), state)

    let api = tapos_manager_select_pool(state)
    if (!api) {
        log('TAPOS Manager: no APs in pool for ' + state.name)
        return
    }

    const use_https = api.method === 'https://'
    const transport = use_https ? https : http
    let url = api.method + api.host + '/v1/chain/get_info'

    transport.get(url, response => {
        let info = ''
        response.on('data', chunk => {
            info += chunk
        })
        response.on('end', () => {
            try {

                tapos_process_get_info(JSON.parse(info), state, api)

                log("Acquired TAPOS at " + (new Date(state.tapos.acq_time_epoch * 1000)).toISOString() + " for '" + state.name + "' from '" + url + "' '" + api.version_found + "' ref_block_num: " + state.tapos.ref_block_num.toString(16) + ' prefix: ' + state.tapos.ref_block_prefix.toString(16))

                tapos_manager_finish(state, api)

                /* Attempt to dispatch any queued transactions now that we have a valid AP */
                manage_dispatch_queues(null)

            } catch (e) {
                let msg = ((e && ('message' in e)) ? e.message : 'unknown')
                tapos_manager_error(msg, state, api, timeout)
            }
        })
        response.on('error', err => {
            tapos_manager_error(err.message || err, state, api, timeout)
        })
    }).on('error', err => {
        tapos_manager_error(err.message || err, state, api, timeout)
    })
}


