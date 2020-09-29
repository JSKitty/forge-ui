/* 
    DATABASE FUNCTIONS
    ------------------
    This file hosts the database functionality of the Forge, allowing for synchronous disk I/O operations
*/
const fs = require('fs');

// System Application data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support/Zenzo/' : process.env.HOME + '/.zenzo/');
if (appdataZC === process.env.APPDATA) appdataZC += '/Zenzo/'; // Append '/Zenzo/' to the windows appdata directory
appdataZC = appdataZC.replace(/\\/g, '/');

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
// Funcs
exports.toDisk = toDisk;
exports.toDiskZC = toDiskZC;
exports.fromDisk = fromDisk;