'use strict';
/* 
    DATABASE FUNCTIONS
    ------------------
    This file hosts the database functionality of the Forge, allowing for synchronous disk I/O operations
*/
const fs = require('fs');

// System Application data directory
let appdata = null;

// ZENZO Core data directory
let appdataZC = null;

function updatePaths(p1, p2) {
    appdata = p1;
    appdataZC = p2;
}

// Write data to a specified file
async function toDisk (file, data, isJson) {
    if (isJson) data = JSON.stringify(data);
    await fs.writeFileSync(appdata + 'data/' + file, data);
    return true;
}

// Write data to a ZENZO Core file
async function toDiskZC (file, data, isJson) {
    if (isJson) data = JSON.stringify(data);
    try {
        await fs.writeFileSync(appdataZC + file, data);
    } catch (e) {
        // This is *probably* due to the user not specifying the correct ZENZO Core datadir path...
        console.error("FILESYSTEM ERROR: Cannot write file '" + file + "' to ZENZO Core datadir...\n" +
                      "Please specify the correct datadir path in your Forge's config.json file!\n" +
                      "Current path: '" + appdataZC + "'");
        return false;
    }
    return true;
}

// Read data from a specified file
async function fromDisk (file, isJson) {
    if (!fs.existsSync(appdata + 'data/' + file)) return null;
    let data = await fs.readFileSync(appdata + 'data/' + file, "utf8");
    if (isJson) data = JSON.parse(data);
    return data;
}

// Params
exports.appdata = appdata;
exports.appdataZC = appdataZC;
exports.updatePaths = updatePaths;
// Funcs
exports.toDisk = toDisk;
exports.toDiskZC = toDiskZC;
exports.fromDisk = fromDisk;