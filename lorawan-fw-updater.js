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
 * This firmware updater server uses the ELPP protocol to send small chunks
 * of a secure firmware binary patch update file (.sfbp) to a target device
 * running the stm32-secure-patching-bootloader and a lorawan-updater client firmware module.
 * 
 * It runs in the process that launches it, so on a desktop PC (nodejs) or in a browser.
 * The process has to remain running while the update proceeds, which could take 
 * hours or days, depending on factors such as size of update, mode of update (lazy/trickle or forced) and
 * reliability of downlinks.
 * 
 * This ELPP firmware update protocol is transport agnostic, but is designed with high-latency
 * asynchronous protocols in mind, such as LoRaWAN and Satellite (e.g. Iridium SBD).
 * 
 * There is an optional negotiation that happens at the start; without it the assumption is
 * "trickle" mode. Trickle mode means the uplink message and downlink chunks are delivered at the rate
 * of the device's natural uplink frequency, so has the effect of "running in the background". 
 * The uplink message is piggybacked with other data in the available uplink payload. 
 * 
 * The server has option to specify a "forced" mode and the interval to poll at, overriding
 * the device's natural uplink rate.  This is useful for speeding up a firmware update, at the
 * expense of increased energy consumption and network costs.
 * 
 * 
 * Updater Implementation
 * 
 * An ELPP server must be launched and this updater engine is bound
 * 
 * The transport protocol is LoRaWAN, and this updater implementation assumes the Helium network,
 * accessed through the Public Helium Console service.  The updater thus requires an API download
 * key
 * 
 * The download initializer
 */
const fs = require('fs')
const elpp = require('./decoder')
const elpp_encoder = require('./encoder')
const log = console.log
const log_obj = function (obj) { console.dir(obj, { depth: null }) }

/* Use 'request' instead of 'http' to handle redirects on endpoints such as Helium downlink URLs */
const { http, https } = require('follow-redirects')


let fd = null
let url = null

const args = process.argv.slice(2);
if (args && args.length >= 2) {

    /* First arg is:
     *   (a) : firmware update file path
     *   (b) : downlink URL
     */
    let path = args[0]
    if (path.endsWith('.sfbp')) {
        fd = fs.openSync(path)
        if (fd) {            
            url = new URL(args[1])
        }
        else {
            log('file ' + path + ' does not exist')
        }
    } else {
        log('file ' + path + ' is not an .sfbp (patch) file')
    }


} else {
    log('need arguments: <.sfbp update file> <downlink url>')
    process.exit(1)
}
