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
