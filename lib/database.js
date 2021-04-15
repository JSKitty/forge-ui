'use strict';
/* 
    DATABASE FUNCTIONS
    ------------------
    This file hosts the database functionality of the Forge, allowing for synchronous disk I/O operations
*/
const fs = require('fs');

// The ZENZO Core config in keypairs
let CONFIG = null;

// System Application data directory
let appdata = null;

// ZENZO Core data directory
let appdataZC = null;

function updatePaths(p1, p2) {
    appdata = p1;
    appdataZC = p2;
}

// Returns a value from the ZENZO Core Config file, if one doesn't exist, returns the default
function getConfigValue(wantedValue, defaultValue) {
    // If we don't have a config at all, immediately return the default value
    if (CONFIG === null || (CONFIG && CONFIG.length <= 1)) return defaultValue;
    for (const keypair of CONFIG) {
        if (!keypair.startsWith(wantedValue)) continue;
        // Return the key's value
        return keypair.split("=")[1];
    }
    // No value, return the default (which might be nothing at all)!
    return defaultValue;
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

// Read data from a specified ZENZO Core file
async function fromDiskZC (file, isJson) {
    if (!fs.existsSync(appdataZC + file)) return null;
    let data = await fs.readFileSync(appdataZC + file, "utf8");
    if (isJson) data = JSON.parse(data);
    return data;
}

// Parses and loads the core config, returns true/false based on operation success
async function reloadConfigZC() {
    try {
        let rawConfig = await fromDiskZC("zenzo.conf", false);
        if (!rawConfig) return false; // failed to read config
        // Parse config via linebreaks
        CONFIG = rawConfig.trim().split(/[\r\n]+/gm);
        return true;
    } catch (e) {
        if (e) {
            console.error("Error reloading core config:");
            console.error(e);
        }
        return false;
    }
}

// Params
exports.appdata = appdata;
exports.appdataZC = appdataZC;
exports.updatePaths = updatePaths;
// Funcs
exports.getConfigValue = getConfigValue;
exports.toDisk = toDisk;
exports.toDiskZC = toDiskZC;
exports.fromDisk = fromDisk;
exports.fromDiskZC = fromDiskZC;
exports.reloadConfigZC = reloadConfigZC;