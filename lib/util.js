/* 
    UTILITY FUNCTIONS
    -----------------
    This file hosts non-essential, independent utility functions.
*/

// Libraries
let script = require('./script.js');

// Ensure an object only contains keys that are considered valid. (E.g: For preventing property pollution)
function areKeysValid(validKeys, obj) {
    for (let [key] of Object.entries(obj)) {
        if (!validKeys.includes(key)) {
            return key;
        }
    }
    return true;
}

// Encode a given string into HEX (as native buffer or string)
function hexEncode(str, asBuffer) {
    let res = Buffer.from(str, "utf8").toString("hex");
    return asBuffer ? Buffer.from(res, "hex") : res;
}

// Decode a given HEX string into UTF-8
function hexDecode(str) {
    return Buffer.from(str, "hex").toString("utf8");
}

// Splices and decodes a string from a contract
function recoverContractString(script, pos) {
    let nScript = script.split(" ");
    return hexDecode(nScript.splice(pos, 1)[0]);
}

exports.areKeysValid = areKeysValid;
exports.hexEncode = hexEncode;
exports.hexDecode = hexDecode;
exports.recoverContractString = recoverContractString;