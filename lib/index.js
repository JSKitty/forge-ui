'use strict';
const crypto =     require('crypto');
const fs =         require('fs');
const superagent = require('superagent');
const express =    require('express');
const bodyParser = require('body-parser');
const RPC =        require('bitcoin-rpc-promise');
const nanoid =     require('nanoid');
let regedit =      require('regedit');
var _ =            require('lodash');

let npm_package;

let script;
let params;
let util;
let database;
let net;
let games_manager;
try {
// GUI
    script =        require('./lib/script.js');
    params =        require('./lib/params.js');
    util =          require('./lib/util.js');
    database =      require('./lib/database.js');
    net =           require('./lib/net.js');
    games_manager = require('./lib/games_manager.js');
    // It's more tricky to fetch the package.json file when GUI-packed, so... here's the workaround!
    try {
        // Unpacked
        npm_package = JSON.parse(fs.readFileSync("package.json", "utf8"));
    } catch (e) {
        // Packed
        npm_package = JSON.parse(fs.readFileSync(process.cwd() + "\\resources\\app\\package.json", "utf8"));
    }
} catch (e) {
// Terminal
    script =        require('./script.js');
    params =        require('./params.js');
    util =          require('./util.js');
    database =      require('./database.js');
    net =           require('./net.js');
    games_manager = require('./games_manager.js');
    npm_package =   JSON.parse(fs.readFileSync("../package.json", "utf8"));
}


// System Application data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support/Zenzo/' : process.env.HOME + '/.zenzo/');
if (appdataZC === process.env.APPDATA) appdataZC += '/Zenzo/'; // Append '/Zenzo/' to the windows appdata directory
appdataZC = appdataZC.replace(/\\/g, '/');

// Update the database paths
database.updatePaths(appdata, appdataZC);

// If we're on Windows; check the registry for ZENZO Core's data directory
if (process.platform === "win32") {
    const regPath = "HKCU\\Software\\Zenzo\\Zenzo-Qt";
    regedit.list(regPath, function(err, result) {
        if (err || !result[regPath] || _.isEmpty(result[regPath].values)) {
            console.warn("Registry: Unable to read Zenzo-Qt registry, defaulting to:\n" + appdataZC);
        }
        const res = result[regPath].values;
        // No errors; ensure the registries are available
        if (res && res.strDataDir && res.strDataDir.value && res.strDataDir.value.length > 1) {
            // We found the ZENZO Core datadir!
            appdataZC = res.strDataDir.value.replace(/\\/g, '/');;
            // Make sure the ending "/" isn't missing
            if (!appdataZC.endsWith("/"))
                appdataZC += "/";
            console.log("Registry: Detected data directory from registry!\n" + appdataZC);
            // Update the database paths
            database.updatePaths(appdata, appdataZC);
        }
    });
}

/* ------------------ GLOBAL SETTINGS ------------------ */
// The debugging mode, this allows the user to customize what the forge should log
// Debug types: all, none, validations, deepvalidations, me
let debugType = ["me","validations"];

// Return if the current debug mode includes the caller's debug type
function debug(type) {
    if (debugType.includes("all")) {
        net.setDebug(true);
        return true;
    }
    if (debugType.includes("none")) return false;

    if (debugType.includes("validations") && "validations" === type) return true;
    if (debugType.includes("deepvalidations") && "deepvalidations" === type) return true;
    if (debugType.includes("net") && "net" === type) {
        net.setDebug(true);
        return true;
    }
    if (debugType.includes("me") && "me" === type) return true;
}

// The port that the Forge communicates on via http
let forgePort = 80;

// The max invalidation score we're willing to put up with before classing an item as invalid
let maxInvalidScore = 25;

// Safe mode, this can be used if the RPC is missing or our peers are acting unstable
let safeMode = false;

// Full Node, this flag determines the level of processing we do for non-essential items,
// running as a full node entails a much higher amount of intensive processing, but as a light node
// we will only validated items relevent to us (E.g: Our items)
let fullNode = false;

// The ZENZO Core 'account' which is utilized by the ZENZO Forge for it's single-address operations.
// There should only (and always) be one address, which makes it very easy for the Forge to 'recover'
// it's operator address via it's label, incase of a config wipe.
const forgeAccountLabel = "Forge";

/* ------------------ NETWORK ------------------ */
// Item validity enum
const ValidityLevel = {
    VALID:    1,
    PENDING:  2,
    UNSIGNED: 3
}
Object.freeze(ValidityLevel);

// Item priority enum (The time interval, in seconds, that the item must be re-validated)
const Priority = {
    REALTIME: 1  * 1000, // Realtime (1 sec)
    FAST:     10 * 1000, // Fast (10 sec)
    NORMAL:   30 * 1000, // Normal (30 sec)

}
Object.freeze(Priority);

// ZENZO Forge Item (ZFI) class definition
class CItem {
    /* TX:         Required, String, the on-chain TX-ID of the ZFI's collateral
       Address:    Required, String, the on-chain receiving address of the ZFI's collateral
       Name:       Required, String, the human-readable display name of the ZFI
       Value:      Required, Float,  the ZNZ value acting as the ZFI's collateral
       Image:      Optional, String, the display image URL of the ZFI
       Sig:        Optional, String, the auth + integrity signature of the ZFI
       Prev:       Optional, Object, the previous ZFI input (only for ZFIs that have been 'transferred')
       Metadata:   Optional, Object, the customizable JSON metadata contents of the ZFI
       Contracts:  Optional, Object, the customizable smart contract scripts of the ZFI
       Version:    Optional, Int,    the version (nonce) of the ZFI, every change to the ZFI increments the version
       Validation: Optional, Object, the local validation cache */
    constructor (strTx, strAddress, strName, nValue, strImage = "default", nTimestamp = -1, strSig = "", objPrev = null, objMetadata = {}, objContracts = {}, nVersion = 0, objLastValidation = {}) {
        // Sanity checks
        if (strTx.length !== 64)                 throw "Invalid strTx (Length is " + strTx.length + ", must be 64!)";
        if (strAddress.length !== 34)            throw "Invalid strAddress (Length is " + strAddress.length + ", must be 34!)";
        if (strName.length <= 0)                 throw "Invalid strName (Length is " + strName.length + ", must be larger than 0!)";
        if (strName.length > 50)                 throw "Invalid strName (Length is " + strName.length + ", must be smaller than 50!)";
        if (nValue < 0)                          throw "Invalid nValue (Value is " + nValue + ", must be larger or equal to 0!)";
        if (strImage.length <= 0)                throw "Invalid strImage (Length is " + strImage.length + ", must be larger than 0!)";
        if (nTimestamp < 0 && nTimestamp !== -1) throw "Invalid nTimestamp (Timestamp is " + nTimestamp + ", cannot be negative unless unknown -1)";
        if (nVersion < 0)                        throw "Invalid nVersion (Version is " + nVersion + ", cannot be negative)";
        
        /* Required data */
        this.strTx        = strTx;
        this.strAddress   = strAddress;
        this.strName      = strName;
        this.nValue       = nValue;
        
        /* Optional data */
        this.strImage     = strImage;
        this.nTimestamp   = nTimestamp;   // Timestamp defaults to "unknown" until validated
        this.strSig       = strSig;
        this.objPrev      = objPrev;
        this.objMetadata  = objMetadata;
        this.objContracts = objContracts;
        this.nVersion     = nVersion;     // Version is incremented every time the item is updated
        
        /* Local data (NOT shared with peers) */
        this.objLastValidation = {
            timestamp: 0,           // Timestamp of the last validation
            successful: false,      // Status of the last validation
            consequtiveFailures: 0  // A counter of the last consequtive validation fails in-a-row (if any)
        }
        // If objLastValidation is specified, overwrite the default data!
        if (!_.isEmpty(objLastValidation))
            this.objLastValidation = objLastValidation;

        // By default; we use 'normal' priority, but if this item is owned by us, then we give it 'fast' priority
        this.priority = strAddress === addy ? Priority.FAST : Priority.NORMAL;
    }

    // (Priority INT) Returns the 'validity level' of the item, e.g; "valid", "pending", "unsigned"
    getValidityLevel() {
        if (this.strSig === "")
            return ValidityLevel.UNSIGNED;
        else if (!this.objLastValidation.successful)
            return ValidityLevel.PENDING;
        else
            return ValidityLevel.VALID;
    }

    // (Bool) Returns true if the item requires re-validation
    needsValidating() {
        // If the 'last validation' is 'this.priority' seconds old, we must signal a re-validation
        if (util.epoch() >= this.objLastValidation.timestamp + this.priority)
            return true;
        else
            return false;
    }

    // (Object) Returns the item in it's raw non-class form
    formatAsObject() {
        // This format removes the 'type' from the name to be compatible with pre-v1.0 DApps
        const objItem = _.cloneDeep({
            tx:        this.strTx,
            address:   this.strAddress,
            name:      this.strName,
            value:     this.nValue,
            image:     this.strImage,
            timestamp: this.nTimestamp,
            sig:       this.strSig,
            prev:      this.objPrev,
            metadata:  this.objMetadata,
            contracts: this.objContracts,
            version:   this.nVersion
        });
        return objItem;
    }
}

// (Bool) A quick check to know if a raw item us using the pre-ZFI-revamp format
function isOldItemFormat(objZFI) {
    // A quick way to identify this, is seeing if '.tx' exists and '.strTx' doesn't!
    return (objZFI.tx && !objZFI.strTx);
}

// (CItem) Return a parsed CItem from a raw object
function parseItem(objZFI) {
    let cZFI = null;
    if (isOldItemFormat(objZFI)) {
        // This item is old, let's attempt to upgrade it...
        cZFI = new CItem(objZFI.tx, objZFI.address, objZFI.name, objZFI.value,
                         objZFI.image, objZFI.timestamp, objZFI.sig, objZFI.prev,
                         objZFI.metadata, objZFI.contracts, objZFI.version);
    } else {
        // This item uses the expected format, yay!
        cZFI = new CItem(objZFI.strTx, objZFI.strAddress, objZFI.strName, objZFI.nValue,
                         objZFI.strImage, objZFI.nTimestamp, objZFI.strSig, objZFI.objPrev,
                         objZFI.objMetadata, objZFI.objContracts, objZFI.nVersion,
                         objZFI.objLastValidation);
    }
    return cZFI;
}

// (CItems Array) Returns a list of parsed CItems from a list of raw objects
function parseItems(objZFIs) {
    let i = 0, len = objZFIs.length;
    let cZFIs = [];
    for (i=0; i<len; i++) {
        cZFIs.push(parseItem(objZFIs[i]));
    }
    return cZFIs;
}

// The list of all known items on the Forge network
let items = [];

// (CItems Array) Returns a pointer list of VALID ONLY items
function getValidItems() {
    let retItems = [];
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        if (items[i].getValidityLevel() === ValidityLevel.VALID) retItems.push(items[i]);
    }
    return retItems;
}

// (CItems Array) Returns a pointer list of UNSIGNED ONLY items
function getUnsignedItems() {
    let retItems = [];
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        if (items[i].getValidityLevel() === ValidityLevel.UNSIGNED) retItems.push(items[i]);
    }
    return retItems;
}

// (CItems Array) Returns a pointer list of PENDING ONLY items
function getPendingItems() {
    let retItems = [];
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        if (items[i].getValidityLevel() === ValidityLevel.PENDING) retItems.push(items[i]);
    }
    return retItems;
}

// The list of items our node has locked previously
let lockedItems = [];

// The state and list of items in the validation queue
let validationQueue = {
    validating: false, // Returns true if the node is busy validating
    list: [],
    count: 0 // The count of total Validation locks performed
}

// The list of smelted items, this can be checked to ensure that a peer doesn't send us a smelted item, thus accidently accepting it due to being valid
let itemsSmelted = [];

// The list of messages that are in the processing queue
let messageQueue = [];



const authToken = nanoid();
console.info("PRIVATE: Your local auth token is '" + authToken + "'");

// Checks if a private HTTP request was authenticated
function isAuthed (req) {
    if (req.body.auth === authToken) return true;
    return false;
}

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

// Add an item to the validation queue if it passes light checks, and pre-compute the "type" of item to avoid double-validations
// Returns "true" if successful (valid item), "false" if unsuccessful (already-owned)
function addToValidationQueue(nItem, revalidate = false) {
    let isIgnored = false;
    let isInvalid = false;
    let isSmelted = false;
    let isUnsigned = true;

    // Enforce bare-minimum item requirements
    if (!isItemContentValid(nItem)) {
        isInvalid = true;
    }

    // Perform some simple maintenance / checks
    if (!isInvalid) {
        nItem.nValue = formatNum(nItem.nValue);
        if (nItem.getValidityLevel() !== ValidityLevel.UNSIGNED)
            isUnsigned = false;
    }

    // Check if the item was previously smelted
    if (!isInvalid && wasItemSmelted(nItem.strTx)) {
        isSmelted = true;
    }

    // Check if we already know the item
    // TODO: Add some hash-comparison checks, as this assumes far too much and could cause issues
    // ... when the ability to 'update' items is introduced, this check caused the implementation
    // ... of transfers to fail, for example.
    let cItemTest = getItem(nItem.strTx, true, true);
    if (fullNode && !revalidate && !isInvalid && !isSmelted && !isUnsigned && !_.isNil(cItemTest)) {
        // If the new item doesn't have an incremented version, ignore it
        if (nItem.nVersion <= cItemTest.nVersion)
            isIgnored = true;
    }

    if (!isInvalid && !revalidate && !isIgnored && !isSmelted && !isUnsigned || // Signed items
        !isInvalid && revalidate && !isSmelted && !isUnsigned ||                // Signed revalidating items
        !isInvalid && isUnsigned && !isSmelted) {                               // Unsigned items
        // Finally, ensure the item isn't already being validated
        if (!isItemValidating(nItem.strTx)) {
            // Push to the validation queue
            validationQueue.list.push(nItem);
            return {status: true, invalid: isInvalid, ignored: isIgnored, smelted: isSmelted, unsigned: isUnsigned};
        }
    }

    // Item was invalid/ignored/smelted
    return {status: false, invalid: isInvalid, ignored: isIgnored, smelted: isSmelted, unsigned: isUnsigned};
}

// Validates queued items in a lock-safe method
function runValidationQueue() {
    if (validationQueue.validating || validationQueue.list.length === 0) return;
    validationQueue.validating = true;

    // lockedList is an array of pointers, to allow post-validation mutation of the items
    validationQueue.lockedList = validationQueue.list;
    let lockedLen = validationQueue.lockedList.length;
    if (debug("validations")) {
        console.info("Starting item queue validation...");
        console.time("Batch validation for " + lockedLen + " items");
    }

    // Begin validation
    let i = 0;
    asyncForEach(validationQueue.lockedList, async (item) => {
        // Check if the item's contents are genuine
        let isUnsigned = item.getValidityLevel() === ValidityLevel.UNSIGNED;
        let valid = await isItemValid(item, isUnsigned, true);
        if (!valid) {
            if (debug("deepvalidations")) console.error("Forge: Received item is not genuine, rejected.");
        }
        if (i+1 === lockedLen) {
            // No more items in the queue
            if (debug("validations")) console.timeEnd("Batch validation for " + lockedLen + " items");
            while (validationQueue.lockedList.length) validationQueue.lockedList.pop();
            while (validationQueue.list.length) validationQueue.list.pop();
            validationQueue.validating = false;
            validationQueue.count++;
            return false;
        } else {
            i++;
        }
    });
}

// Gets a list of all requested item hashes, paired with their TXs, useful for lightweight comparisons of our DB with peers
async function getItemHashes (includePending = false, includeUnsigned = false) {
    let cList = [];
    // Deep clone item lists into cloned list
    cList.push(getValidItems());
    if (includePending) cList.push(getPendingItems());
    if (includeUnsigned) cList.push(getUnsignedItems());

    // Clean the item of any local-only information and flatten down one array
    cList = util.cleanItems(_.flatten(cList));

    // Loop cList, hash the stringified item data and push into hashed list
    let hashedList = [];
    await asyncForEach(cList, async (rawItem) => {
        hashedList.push({hash: crypto.createHash('md5').update(JSON.stringify(rawItem)).digest('hex'), tx: rawItem.strTx});
    });

    return hashedList;
}

// Validates if an item's contents complies with basic bare-bones requirements
function isItemContentValid (nItem = new CItem) {
    // Ensure this item is the latest format
    if (isOldItemFormat(nItem))
        nItem = parseItem(nItem);

    // If the item contains metadata, limit the amount of data it can store to prevent excessive network load
    if (!_.isEmpty(nItem.objMetadata)) {
        let nRaw;
        try {
            nRaw = JSON.stringify(nItem.objMetadata);
        } catch(e) {
            console.error("Forge: Received invalid item, metadata is not valid JSON.");
            return false;
        }
        const nBytes = nRaw.length;
        const nKBs = nBytes / 1024;
        // Limit metadata to 2 Kilobytes (KBs), equal to ~0.002 MB.
        if (nKBs > 2) {
            console.error("Forge: Received invalid item, metadata payload too large. (Has: " + nBytes + ", Max: " + params.maxMetadataBytes + ") ");
            return false;
        }
    } else {
        nItem.objMetadata = {};
    }

    // If the item contains any smart contracts, ensure they're collectively under 1 KB in size
    if (!_.isEmpty(nItem.objContracts)) {
        let nRaw;
        try {
            if (typeof nItem.objContracts !== "object") {
                nItem.objContracts = JSON.parse(nItem.objContracts);
            }
            nRaw = JSON.stringify(nItem.objContracts);
        } catch(e) {
            console.error("Forge: Received invalid item, cannot parse contracts.");
            return false;
        }
        const nBytes = nRaw.length;
        const nKBs = nBytes / 1024;
        // Limit metadata to 1 Kilobyte (KB), equal to ~0.001 MB.
        if (nKBs > 1) {
            console.error("Forge: Received invalid item, contracts payload too large. (Has: " + nBytes + ", Max: " + params.maxContractBytes + ") ");
            return false;
        }
    } else {
        nItem.objContracts = {};
    }

    // If an item is unsigned, ensure it has a "prev" input specified
    if (nItem.getValidityLevel() === ValidityLevel.UNSIGNED) {
        if (!nItem.objPrev || _.isEmpty(nItem.objPrev)) {
            console.error("Forge: Received invalid unsigned item, prev is missing.");
            return false;
        }
    }

    return true;
}


// Validates if an item is genuine
async function isItemValid (nItem, isUnsigned, approve = false) {
    try {
        // Soft local-node checks
        // Was the item smelted? (Prevents race-conditions where an item is smelted while inside the validation queue)
        if (wasItemSmelted(nItem.strTx)) {
            eraseItem(nItem, true);
            if (debug("validations")) console.warn("Forge: Item '" + nItem.strName + "' was previously smelted.");
            return false;
        }

        // Does the item meet bare-bones content requirements?
        if (!isItemContentValid(nItem)) {
            eraseItem(nItem, true);
            if (debug("validations")) console.error("Forge: Item '" + nItem.strName + "' doesn't meet content requirements.");
            return false;
        }

        // Execute the item's validation contract (If it has one)
        if (!_.isEmpty(nItem.objContracts) && !_.isEmpty(nItem.objContracts.validation)) {
            // Check if the validation contract requires any contextual data, if so, we inject it into the context
            const contexts = script.containsContextualCodes(nItem.objContracts.validation);
            const opcodes = script.getOpcodes();
            // To allow for easy self-contexts, we always inject our own item data
            let contextualData = {
                this: nItem.formatAsObject()
            };

            if (!_.isNil(contexts)) {
                if (contexts.includes(opcodes.GETBESTBLK)) {
                    // Retrieve the best block from our daemon
                    contextualData.bestBlock = await zenzo.call("getblockcount");
                } else
                if (contexts.includes(opcodes.ISNAMEUSED) ||
                    contexts.includes(opcodes.GETITEMEPOCH)) {
                    // Provide a deep clone of all existing signed items (to search for the desired name)
                    contextualData.signedItems = _.flatten(_.cloneDeep([getValidItems(), getPendingItems()]));
                }
            }
            let res = await script.execute(nItem.objContracts.validation, contextualData);
            // A "validation" script MUST return "1" AND execute successfully, otherwise the item is invalid
            if (res.result !== 1 || !res.success) {
                if (debug("validations")) console.error("Forge: Item '" + nItem.strName + "' validation contract " + (!res.success ? "failed" : "resulted in '" + res.result + "'") + ", invalid item.");
                eraseItem(nItem, true);
                return false;
            }
        }

        // Begin deep chain/mempool + signature validation
        //if (debug("deepvalidations")) console.info("Validating item: '" + nItem.strName + "' from " + nItem.strAddress);
        // Ensure the collateral TX exists either in the blockchain or mempool
        let rawTx;
        try {
            rawTx = await zenzo.call("getrawtransaction", nItem.strTx, 1);
            if (!rawTx.blockhash || rawTx.blockhash.length !== 64)
                nItem.nTimestamp = -1;              // Unknown timestamp, TX is off-chain
            else
                nItem.nTimestamp = rawTx.blocktime; // Set the on-chain timestamp
        } catch (e) {/* Silently catch getrawtransaction errors */}
        if (!rawTx || !rawTx.vout || !rawTx.vout[0]) {
            if (debug("deepvalidations")) console.warn('Forge: Item "' + nItem.strName + '" is not in the blockchain.');
            let testItem = getItem(nItem.strTx, true, true);
            // Case 1: We already have this item, so we keep it within our DB and simply add invalidation score
            if (!_.isNil(testItem)) {
                addInvalidationScore(nItem, 2);
            }
            // Case 2: We don't have any history of this item, so we add it to our pending or unsigned list
            else {
                if (isUnsigned) {
                    items.push(nItem);
                    if (debug("deepvalidations")) console.log("New untrusted unsigned item added to DB");
                } else {
                    items.push(nItem);
                    if (debug("deepvalidations")) console.log("New untrusted signed item added to DB");
                }
                // Add invalidation score to the newly-added item
                addInvalidationScore(nItem, 2);
            }
            return false;
        }
        for (let i=0; i<rawTx.vout.length; i++) {
            if (rawTx.vout[i].value === nItem.nValue) {
                if (rawTx.vout[i].scriptPubKey.addresses.includes(nItem.strAddress)) {
                    //if (debug("deepvalidations")) console.log("Found pubkey of item...");
                    let isSigGenuine = false;
                    if (nItem.strSig)
                        isSigGenuine = await zenzo.call("verifymessage", nItem.strAddress, nItem.strSig, nItem.strTx);
                    if (isSigGenuine || !isSigGenuine && isUnsigned) {
                        //if (debug("deepvalidations") && !isUnsigned) console.info("Sig is genuine...");
                        //if (debug("deepvalidations") && isUnsigned) console.info("Item is unsigned but valid...");
                        let res = await zenzo.call("gettxout", nItem.strTx, i); // i is the vout from the previous rawTx.vout[] forloop

                        // Ensure the collateral output hasn't been spent
                        if (res === null) {
                            if (debug("deepvalidations")) console.warn("UTXO couldn't be found, item '" + nItem.strName + "' has no UTXO");
                            // Be softer on our own items
                            if (doesItemInvolveMe(nItem)) {
                                addInvalidationScore(nItem, 2.5);
                            } else {
                                addInvalidationScore(nItem, 12.5);
                            }
                            return false; // UTXO has been spent (Or doesn't yet exist, so we give it a chance to appear in mempool/chain)
                        }

                        // Ensure UTXO data matches item data
                        if (res.value === nItem.nValue) {
                            if (res.scriptPubKey.addresses[0] === nItem.strAddress) {
                                //if (debug("deepvalidations")) console.info("Found unspent UTXO collateral...");
                                if (approve) approveItem(nItem);
                                return true; // Found unspent collateral UTXO on-chain
                            } else {
                                if (debug("deepvalidations")) console.warn("Item address (" + nItem.strAddress + ") doesn't match it's TX collateral address (" + ((res !== null) ? res : resSecondary).scriptPubKey.addresses[0] + ")");
                                addInvalidationScore(nItem, 12.5);
                                return false;
                            }
                        } else {
                            if (debug("deepvalidations")) console.warn("Item value (" + nItem.nValue + ") doesn't match it's TX collateral value (" + ((res !== null) ? res : resSecondary).value + ")");
                            addInvalidationScore(nItem, 25);
                            return false;
                        }
                    } else {
                        if (debug("deepvalidations")) console.warn("Sig is not genuine..." + JSON.stringify(nItem));
                        addInvalidationScore(nItem, 25);
                        return false;
                    }
                }
            }
        }
    } catch (err) {
        console.error("Item Validation error: " + err);
        return false;
    }
    console.error("UNEXPECTED VALIDATION ERROR!!! (REPORT BELOW TO DEV!)");
    console.error(nItem);
    return false;
}

async function validateItemBatch (res, nItems, reply) {
    let validationStats = {
        accepted: 0, // Valid items accepted by us
        ignored: 0, // May be valid, but we don't want it (Already have it?)
        rejected: 0 // Invalid or contains errors
    }

    await asyncForEach(nItems, async (nItem) => {
        let lightValidation = addToValidationQueue(nItem, false);

        if (lightValidation.ignored || lightValidation.smelted)
            validationStats.ignored++;
        else if (lightValidation.invalid)
            validationStats.rejected++;
        else
            validationStats.accepted++;

        // If this item was smelted, make sure to nuke it from our DB
        if (lightValidation.smelted) {
            eraseItem(nItem, true);
            if (debug("validations")) console.warn("Forge: Item '" + nItem.strName + "' was previously smelted.");
        }
    });

    runValidationQueue();

    if (reply) res.send("Thanks!");
    return validationStats;
}

// Validate new deterministic smelts
function validateSmelts(smelts) {
    asyncForEach(smelts, async (smelt) => {
        // Barebones security checks
        if (!_.isNil(smelt.strAddress) && !_.isNil(smelt.strTx) && !_.isNil(smelt.strSig)) {
            // Ensure we don't already have a copy of the smelt
            if (!wasItemSmelted(smelt.strTx)) {
                // Verify the signature and smelt is genuine
                console.info("Verifying smelt for item (" + smelt.strTx + ")");
                console.info(smelt);
                zenzo.call("verifymessage", smelt.strAddress, smelt.strSig, "smelt_" + smelt.strTx).then(isGenuine => {
                    if (isGenuine) {
                        console.info("- Signature verified! Smelt is genuine, performing smelt...");

                        // Begin the local smelt process for the item
                        smeltItem({strTx: smelt.strTx, strAddress: smelt.strAddress}, smelt.strSig).then(smelted => {
                            console.info("- Item smelted successfully!");
                        });
                    } else {
                        console.error("- Invalid signature, ignoring smelt request.");
                    }
                }).catch(function(){
                    console.error("- Malformed signature, ignoring smelt request.");
                });
            }
        }
    });
}

// Approve an item as valid, moving it to the main items DB and removing it from the pending list
function approveItem(nItem) {
    let hasLocally = false;
    // The local DB item pointer
    let prevItem = getItem(nItem.strTx, true, true);
    if (!_.isNil(prevItem)) hasLocally = true;

    // Mark the item's validation as successful, and reset failures counter to zero
    nItem.objLastValidation.successful = true;
    nItem.objLastValidation.consequtiveFailures = 0;

    // Check if the item is unsigned
    if (nItem.strSig && (hasLocally && prevItem.getValidityLevel() === ValidityLevel.UNSIGNED)) {
        if (nItem.strSig.length > 0) {
            nItem.signedByReceiver = true;
            console.info("An unsigned item has been signed by it's owner!\n - Item '" + nItem.strName + "' (" + nItem.strTx + ") removed from unsigned list");
        }
    }

    // If this item has a prev input, ensure it's prev item is gracefully removed
    if (!_.isEmpty(nItem.objPrev) && !_.isEmpty(nItem.objPrev[0]))
        eraseItem(nItem.objPrev[0], true);

    // If we don't have the item - Or if we do have the item, but it's an older version than the new one
    if (!hasLocally || (hasLocally && nItem.nVersion > prevItem.nVersion)) {
        // Add this item to all peer contexts
        let nPeers = net.getPeers();
        for (const peer of nPeers) {
            let nHeader = _.find(peer.syncedItems, {'strTx': nItem.strTx});
            if (nHeader) {
                // Update existing header
                nHeader.nVersion = nItem.nVersion;
            } else {
                // Add new header
                peer.syncedItems.push({strTx: nItem.strTx, nVersion: nItem.nVersion});
            }
        }
        if (!hasLocally && nItem.getValidityLevel() === ValidityLevel.VALID) {
            // Case 1: New valid signed item
            delete nItem.signedByReceiver;
            items.push(nItem);
            console.info("An item has been added and approved!\n - Item '" + nItem.strName + "' (" + nItem.strTx + ") is now a verified item.");
        } else if (!hasLocally && !nItem.signedByReceiver && nItem.getValidityLevel() === ValidityLevel.UNSIGNED) {
            // Case 2: New valid unsigned item
            delete nItem.signedByReceiver;
            console.info("An unsigned item has been approved!\n - Item '" + nItem.strName + "' (" + nItem.strTx + ") is now an unsigned item.");
            items.push(nItem);
        } else if (nItem.signedByReceiver && prevItem.getValidityLevel() === ValidityLevel.UNSIGNED) {
            // Case 3: Old unsigned item receiving an update
            delete nItem.signedByReceiver;
            console.info("An unsigned item has been updated!\n - Item '" + nItem.strName + "' (" + nItem.strTx + ") is now a verified item.");
            updateItem(nItem);
        } else if (hasLocally && !nItem.signedByReceiver) {
            // Case 4: This is a fully valid item with a new version, upgrade!
            updateItem(nItem);
        } else {
            // This shouldn't happen... but log errors just incase!
            console.warn(" --- UNEXPECTED ITEM VALIDATION ERROR ---");
            console.warn({hasLocally: hasLocally, prevItem: prevItem});
            console.warn(nItem);
            console.warn("WARNING: approveItem() for (" + nItem.strName + ", " + nItem.strTx + ") met no conditions, this item has unexpected properties!\n --- Please report this to the developer! ---");
        }
    }
}

// Disprove an item, moving it out of the main items DB and to the pending list, and removing it entirely if it gets disproven again
function disproveItem(item) {
    // If the item is in our pending list, remove it entirely from the node
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        // Find the specified item
        if (item.strTx === items[i].strTx) {
            // Pointer!
            let cItem = items[i];
            // Check if this is a PENDING or lower item
            if (cItem.getValidityLevel() >= ValidityLevel.PENDING) {
                // Increment the consequtive failures counter
                if (!cItem.objLastValidation.successful) cItem.objLastValidation.consequtiveFailures++;
                // If the item has failed validation three times, it gets erased
                if (cItem.objLastValidation.consequtiveFailures >= 3) {
                    eraseItem(cItem, true);
                    if (debug("validations")) console.warn("A bad item has been erased!\n - Item '" + cItem.strName + "' (" + cItem.strTx + ") has been erased from the local database.");
                }
            }
            // Mark the item's validation as unsuccessful
            cItem.objLastValidation.successful = false;
        }
    }
}

// Erase an item from all DB lists (minus smelt list)
function eraseItem(item = new CItem, includeUnsigned = false) {
    // Delete this item from all peer contexts
    net.eraseItemFromPeers(item);

    // Delete the item from the DB
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        // TX matches!
        if ((item.strTx || item.tx) === items[i].strTx) {
            // Skip unsigned items if we don't want to delete them
            if (!includeUnsigned && items[i].getValidityLevel() === ValidityLevel.UNSIGNED) continue;
            items.splice(i, 1);
            break;
        }
    }
}

// Check if an item TX was smelted
function wasItemSmelted(item) {
    if (_.find(itemsSmelted, {'tx': item}))
        return true;

    return false;
}

// Check if we have the item in our node
function hasItem(item) {
    if (_.find(items, {'strTx': item})) return true;
    return false;
}

// Check if we have the item in our validation queue
function isItemValidating(item) {
    if (_.find(validationQueue.lockedList, {'strTx': item})) return true;
    if (_.find(validationQueue.list, {'strTx': item})) return true;
    return false;
}

// Check if an item object is involved with our wallet (address)
function doesItemInvolveMe(item) {
    if (item.strAddress === addy ||
        !_.isNil(item.objPrev) && !_.isNil(item.objPrev[0]) && item.objPrev[0].strAddress === addy) return true;
    return false;
}

// Increments the invalidation score of an item, if this score reaches maxInvalidScore, the item is considered irreversibly invalid, and removed from the DB permanently
function addInvalidationScore(item, score) {
    for (let i=0; i<items.length; i++) {
        if (item.strTx === items[i].strTx) {
            if (!items[i].invalidScore) items[i].invalidScore = 0;
            items[i].invalidScore += score;
            item.invalidScore = items[i].invalidScore;
            if (debug("validations")) console.info("An invalidation score of '" + score + "' has been applied to '" + item.strName + "', now totalling '" + items[i].invalidScore + "' invalidation score.");
            if (item.invalidScore >= maxInvalidScore) {
                item.invalidScore = 0;
                disproveItem(item);
                if (debug("validations")) console.info(" - Item has been invalidated to Pending due to exceeding the invalidation score threshold.");
            }
        }
    }
}

// Format a number to 6 decimal places to remove any JS-buggy number changes
function formatNum(n) {
    return Number((Number(n)).toFixed(6));
}

// Get an item object from our list by it's hash
function getItem(itemArg, includePending = false, includeUnsigned = false) {
    for (let i=0; i<items.length; i++) {
        // TX matches!
        if (items[i].strTx === itemArg) {
            // Skip pending items if we don't include them
            if (!includePending && items[i].getValidityLevel() === ValidityLevel.PENDING) continue;
            // Skip unsigned items if we don't include them
            if (!includeUnsigned && items[i].getValidityLevel() === ValidityLevel.UNSIGNED) continue;

            return items[i];
        }
    }
    return null;
}

// Gets a list of all items with a specified name
function getItemsByName(itemArg, includePending = false, includeUnsigned = false) {
    let retItems = [];
    let i = 0, len = items.length;
    for (i=0; i<len; i++) {
        // Name matches!
        if (items[i].strName.includes(itemArg)) {
            // Skip pending items if we don't include them
            if (!includePending && items[i].getValidityLevel() === ValidityLevel.PENDING) continue;
            // Skip unsigned items if we don't include them
            if (!includeUnsigned && items[i].getValidityLevel() === ValidityLevel.UNSIGNED) continue;

            retItems.push(items[i]);
        }
    }
    return retItems;
}

// Updates the contents of an item object
function updateItem (itemArg) {
    for (let i=0; i<items.length; i++) {
        if (items[i].strTx === itemArg.strTx) {
            items[i] = parseItem(itemArg);
            return true;
        }
    }
    return false;
}

// Returns true if the given item is a ZENZO Forge profile
function isProfile(nItem) {
    const standard = script.getStandards().ZFI_1;
    // For compatibility; this method supports (and auto-converts) all item formats
    const cItemToCheck = isOldItemFormat(nItem) ? parseItem(nItem) : nItem;
    if (!cItemToCheck.objContracts || !cItemToCheck.objContracts.validation) return false;
    // Ensure this item conforms to the ZFI-1 standard;
    if (!script.conformsToStandard(cItemToCheck.objContracts.validation, standard)) return false;
    // Contract is valid, ensure profile name matches contract input;
    if (cItemToCheck.strName !== util.recoverContractString(cItemToCheck.objContracts.validation, 0)) return false;
    // This is a valid ZFI-1 Profile!
    return true;
}

// Gets an array of all ZFI-1 profiles on the network
function getAllProfiles(includePending = false) {
    let profiles = [], i, len = items.length;
    for (i=0; i<len; i++) {
        let nItem = items[i];
        if (!includePending && nItem.getValidityLevel() === ValidityLevel.PENDING) continue;
        if (!isProfile(nItem)) continue;
        profiles.push(nItem);
    }
    return util.cleanItems(profiles, true);
}

// Gets a single ZFI-1 profile by it's username
function getProfileByName(name, includePending = false) {
    let profiles = getAllProfiles(includePending);
    for (let i=0; i<profiles.length; i++) {
        // Ensure the contract's name matches the query name
        if (util.recoverContractString(profiles[i].contracts.validation, 0) === name) {
            return profiles[i];
        }
    }
    return null;
}

// Gets a list of ZFI-1 profiles by their address
function getProfilesByAddress(address, includePending = false) {
    let profiles = getAllProfiles(includePending);
    let matchedProfiles = [];
    for (let i=0; i<profiles.length; i++) {
        if (profiles[i].address !== address) continue;
        matchedProfiles.push(profiles[i]);
    }
    return matchedProfiles;
}

// Setup Express server
let app = express();
app.use(bodyParser.json({limit: '10mb'}));
app.use(express.urlencoded({limit: '10mb', extended: true}));

class ReceivedMessage {
    constructor(host, content, res) {
        this.from = net.getPeer(host); // The host (Peer class) of the sender
        this.content = content; // The content of the message (Could be plaintext or JSON)
        this.res = res; // The raw express response obj
    }

    reply(sentContent) {
        this.from.send(sentContent);
    }
}

/* Express Endpoints */
// Ping
// An easy way to check if a node is responsive and meets protocol consensus
app.post('/ping', (req, res) => {
    if (safeMode) return
    let ip = net.cleanIP(req.ip);

    // We don't want to connect to ourselves
    if (ip !== "127.0.0.1") {
        req.peer = net.getPeer("http://" + ip);
        if (req.peer !== null) {
            req.peer = net.getPeer("http://" + ip);
            req.peer.lastPing = Date.now();
            net.updatePeer(req.peer);
        } else {
            if (params.isValidProtocol(req.body.protocol)) {
                req.peer = new net.Peer(ip, req.body.protocol);
                req.peer.lastPing = Date.now();
                req.peer.connect(false);
            } else {
                res.json({error: "Incompatible node handshake"});
                return;
            }
        }
        if (req.body && req.body.protocol && debug("net")) {
            net.receivedPing();
        }
    }

    res.send(params.protocolVersion);
});

// Forge Receive
// Allows peers to send us their Forge item data
app.post('/forge/receive', (req, res) => {
    let ip = net.cleanIP(req.ip);
    req.peer = net.getPeer("http://" + ip);
    if (req.peer === null) {
        res.send({error: "Handshake needed before making consensus-reliant requests."})
        if (debug("net")) console.warn("Peer " + ip + " tried to send us items without a handshake connection, ignoring...");
        return;
    }


    let nItems = req.body;
    let nSmelts = req.body.smeltedItems;

    validateSmelts(nSmelts);

    validateItemBatch(res, parseItems(nItems.items), true).then(done => {
        if (debug("net") || debug("validations")) {
            console.log('Forge: Validated item batch from "' + ip + '"');
            console.info("Validated item results from peer\n - Accepted: " + done.accepted + "\n - Ignored: " + done.ignored + "\n - Rejected: " + done.rejected);
            net.receivedPing();
        }
    });
});

// Forge Sync
// Allows peers to sync with our database
app.post('/forge/sync', (req, res) => {
    let ip = net.cleanIP(req.ip);
    req.peer = net.getPeer("http://" + ip);
    if (req.peer === null) {
        res.send({error: "Handshake needed before making consensus-reliant requests."})
        if (debug("net")) console.warn("Peer " + ip + " tried to send us items without a handshake connection, ignoring...");
        return;
    }

    // Check the peer's header context, and send any items WE have which are missing from THEIR headers.
    net.receivedPing();

    // Don't try to exchange items during safemode
    let nItemsToSend = [];
    let nItemsWanted = [];
    if (req.peer !== null && !safeMode) {
        // Loop our items, try to find a match in-context
        for (const nItem of items) {
            // Check that THEY have OUR copy (Upgrade them if they're behind)
            if (!_.find(req.body.headers_context, {'strTx': nItem.strTx})) {
                // Peer doesn't have this item, send them a copy!
                nItemsToSend.push(nItem);
            } else {
                // Peer has the item, but check if the version is older than ours
                let nHeader = _.find(req.body.headers_context, {'strTx': nItem.strTx});
                if (nHeader.nVersion < nItem.nVersion) {
                    // Our item is newer, send it over!
                    nItemsToSend.push(nItem);
                } else if (nHeader.nVersion > nItem.nVersion) {
                    // Their item is newer, ask for it!
                    nItemsWanted.push(nHeader.strTx);
                }
            }
        }
    }

    // Don't try to validate smelts during safemode
    if (!safeMode)
        validateSmelts(req.body.smeltedItems);

    let obj = {items: util.cleanItems(nItemsToSend, true), itemsWanted: nItemsWanted, smeltedItems: itemsSmelted};
    res.send(JSON.stringify(obj));
});

// Forge Sync Hashes
// Allows peers to sync hashes to determine the item differences
app.post('/forge/sync/hashes', (req, res) => {
    let ip = net.cleanIP(req.ip);
    req.peer = net.getPeer("http://" + ip);
    net.receivedPing();
    if (req.peer === null) {
        res.send({error: "Handshake needed before making consensus-reliant requests."})
        if (debug("net")) console.warn("Peer " + ip + " tried to send us item hashes without a handshake connection, ignoring...");
        return;
    }

    // Peer sends us "peerHashes[]"
    // We loop our hashes and try to find an identical peer hash (if no match: add to itemsToSend)
    // We then loop the peer's hashes to find a match to ours (if no match: add to hashesWeWant)
    // Send lists to peer and await a response via "/forge/sync"

    let peerHashes = req.body; // Peer's sent hashes
    let hashesWeWant = [];     // Hashes we're missing that our peer has
    let itemsToSend = [];      // Hashes our peer is missing, but we send the full items in return

    // Get a list of all our item hashes
    getItemHashes(true, true).then(ourHashes => {
        // Loop our hashes and try to find a match from our peer's list
        ourHashes.forEach(nHash => {
            if (!_.find(peerHashes, {'hash': nHash.hash})) {
                // No match found, peer is missing this item
                let peersMissingItem = getItem(nHash.strTx, true, true);
                if (peersMissingItem)
                    itemsToSend.push(peersMissingItem);
            }
        });

        // Loop the peer's hashes and try to find a match from our list
        peerHashes.forEach(nHash => {
            if (!_.find(ourHashes, {'hash': nHash.hash})) {
                // No match found, we're missing this item
                hashesWeWant.push(nHash);
            }
        });

        itemsToSend = util.cleanItems(itemsToSend, true);

        res.send(JSON.stringify({itemsSent: itemsToSend, hashesWanted: hashesWeWant, smeltedItems: itemsSmelted}));
    });
});

// Forge Inventory
// An endpoint that allows peers to see our personal inventory. Items owned and/or created by us.
app.post('/forge/inventory', (req, res) => {
    let ourItems = [];
    let ourPendingItems = [];

    // Find our validated items
    for (let i=0; i<items.length; i++) {
        if (items[i].strAddress === addy) {
            if (items[i].getValidityLevel() === ValidityLevel.VALID)
                ourItems.push(items[i]);
            else
                ourPendingItems.push(items[i]);
        }
    }

    let obj = {items: util.cleanItems(ourItems, true), pendingItems: util.cleanItems(ourPendingItems, true)};

    // BACKWARDS-COMPAT NOTE/TODO: Remove this once KOTA moves to TXs instead of Hashes!!
    for (const item of obj.items) {
        item.hash = item.tx;
    }
    for (const item of obj.pendingItems) {
        item.hash = item.tx;
    }

    res.send(JSON.stringify(obj));
});

// Forge Profiles
// An endpoint that returns all known user profiles
app.post('/forge/profiles', (req, res) => {
    res.send(JSON.stringify(getAllProfiles(true)));
});

// Forge Profile
// An endpoint that returns a profile by it's name
app.post('/forge/profile', (req, res) => {
    if (req.body.name && req.body.name.length >= 1) {
        let objProfile = getProfileByName(req.body.name, true);
        res.send(JSON.stringify(objProfile));
    }
});


/* LOCAL-ONLY ENDPOINTS (Cannot be used by peers, only us)*/

// Forge Account
// The endpoint for getting the general information of a user
app.post('/forge/account', (req, res) => {
    let ip = net.cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    zenzo.call("getinfo").then(info => {
        let obj = {forge_address: addy, balance: info.balance, wallet_version: info.version};
        res.json(obj);
    })
});

// Forge Create
// The endpoint for crafting new items, backed by ZNZ and validated by the ZENZO Core protocol
app.post('/forge/create', (req, res) => {
    if (net.getPeers().length === 0 || safeMode) return res.json({error: "Crafting is unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = net.cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    // Check we have all needed parameters
    if (req.body.amount < 0.01) {
        res.json({error: "Invalid amount parameter (Has: " + req.body.amount + ", Min: 0.01)."});
        return console.warn("Forge: Invalid amount parameter (Has: " + req.body.amount + ", Min: 0.01).");
    }
    if (req.body.name.length < 1 || req.body.name.length > 50) {
        res.json({error: "Invalid name parameter."});
        return console.warn("Forge: Invalid name parameter.");
    }
    if (req.body.image.length < 1) {
        res.json({error: "Invalid image parameter."});
        return console.warn("Forge: Invalid image parameter.");
    }
    let metadataBytes = 0;
    if (!_.isNil(req.body.objMetadata)) {
        try {
            metadataBytes = JSON.stringify(req.body.objMetadata).length;
        } catch {
            res.json({error: "Invalid metadata payload, unable to parse JSON."});
            return console.warn("Forge: Invalid metadata payload, unable to parse JSON.");
        }
    }
    if (metadataBytes > params.maxMetadataBytes) {
        res.json({error: "Metadata payload is too large. (Has: " + metadataBytes + ", Max: " + params.maxMetadataBytes + ")"});
        return console.warn("Forge: Metadata payload is too large. (Has: " + metadataBytes + ", Max: " + params.maxMetadataBytes + ")");
    }
    let contractBytes = 0;
    if (!_.isNil(req.body.contracts)) {
        try {
            if (typeof req.body.contracts !== "object") {
                req.body.contracts = JSON.parse(req.body.contracts);
            }
            contractBytes = JSON.stringify(req.body.contracts).length;
        } catch {
            res.json({error: "Invalid contracts payload, unable to parse JSON."});
            return console.warn("Forge: Invalid contracts payload, unable to parse JSON.");
        }
    }
    if (contractBytes > params.maxContractBytes) {
        res.json({error: "Contracts payload is too large. (Has: " + contractBytes + ", Max: " + params.maxContractBytes + ")"});
        return console.warn("Forge: Contracts payload is too large. (Has: " + contractBytes + ", Max: " + params.maxContractBytes + ")");
    }

    if (contractBytes === 0) req.body.contracts = {};

    // Cleanse the input
    req.body.amount = formatNum(req.body.amount);

    // Create a transaction
    zenzo.call("sendtoaddress", addy, Number(req.body.amount.toFixed(8))).then(txid => {
        // Sign the transaction hash
        zenzo.call("signmessage", addy, txid).then(sig => {
            let nItem = new CItem(txid, addy, req.body.name, req.body.amount,
                req.body.image, util.epoch(), sig, null,
                req.body.metadata, req.body.contracts);
            console.log("Forge: Item Created!\n- TX: " + nItem.strTx + "\n- Signature: " + nItem.strSig + "\n- Name: " + nItem.strName + "\n- Image: " + nItem.strImage + "\n- Value: " + nItem.nValue + " ZNZ\n- Metadata: " + metadataBytes + " bytes\n- Contracts: " + contractBytes + " bytes");
            items.push(nItem);
            net.sendItemsToNetwork([nItem]);
            zenzo.call("gettransaction", txid).then(rawtx => {
                zenzo.call("lockunspent", false, [{"txid": txid, "vout": rawtx.details[0].vout}]).then(didLock => {
                    if (didLock) console.info("- Item collateral was successfully locked in ZENZO Coin Control.");
                    res.json(nItem);
                }).catch(function(){
                    console.error("--- CRAFT FAILURE ---\n- ZENZO-RPC 'lockunspent false " + JSON.stringify([{"txid": txid, "vout": rawtx.details[0].vout}]) + "' failed");
                    res.json({error: "Craft failure: ZENZO-RPC hangup"});
                });
            }).catch(function(){
                console.error("--- CRAFT FAILURE ---\n- ZENZO-RPC 'gettransaction " + txid + "' failed");
                res.json({error: "Craft failure: ZENZO-RPC hangup"});
            });
        }).catch(function(){
            console.error("--- CRAFT FAILURE ---\n- ZENZO-RPC 'signmessage " + addy + " " + txid + "' failed");
            res.json({error: "Craft failure: ZENZO-RPC hangup"});
        });
    }).catch(function(){
        console.error("--- CRAFT FAILURE ---\n- ZENZO-RPC 'sendtoaddress " + addy + " " + req.body.amount.toFixed(8) + "' failed");
        res.json({error: "Craft failure: ZENZO-RPC hangup"});
    });
});

// Forge Transfer
// The endpoint for transferring items to other addresses or profiles
app.post('/forge/transfer', (req, res) => {
    if (net.getPeers().length === 0 || safeMode) return res.json({error: "Transfers are unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = net.cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    // Check we have all needed parameters
    if (req.body.item.length !== 64) return console.warn("Forge: Invalid item parameter.");
    if (req.body.to.length !== 34) return console.warn("Forge: Invalid to parameter.");

    // Get the item
    let tItem = getItem(req.body.item);

    findMatchingVouts(tItem).then(vouts => {
        // Create a transaction
        //zenzo.call("gettxout", tItem.strTx, tItem.vout).then(rawPrevTx => {
            // Sign the transaction hash
            let receiverJson = "{\"" + req.body.to + "\":" + (tItem.nValue - 0.001).toFixed(4) + "}"
            let VoutJson = "[{\"txid\":\"" + tItem.strTx + "\",\"vout\":" + vouts[0] + "}]"
            console.log("Receiver: " + receiverJson);
            console.log("VoutJson: " + VoutJson);
            zenzo.call("createrawtransaction", JSON.parse(VoutJson), JSON.parse(receiverJson)).then(rawTx => {
                zenzo.call("signrawtransaction", rawTx).then(signedTx => {
                    zenzo.call("sendrawtransaction", signedTx.hex).then(txid => {
                        //zenzo.call("signmessage", addy, txid).then(sig => {
                            let objPrev = [
                                {
                                    tx: tItem.strTx,
                                    vout: vouts[0],
                                    address: addy,
                                    spend_timestamp: util.epoch(),
                                    transfer_fee: 0.001
                                }
                            ]
                            let nItem = new CItem(txid, req.body.to, tItem.strName, tItem.nValue - objPrev[0].transfer_fee,
                                tItem.strImage, util.epoch(), "", objPrev,
                                tItem.objMetadata, tItem.objContracts, tItem.nVersion + 1);
                            console.log("Forge: Item Transferred!\n- TX: " + nItem.strTx + /*"\n- Signature: " + nItem.strSig +*/ "\n- Name: " + nItem.strName + "\n- Value: " + nItem.nValue + " ZNZ\n - Version: " + nItem.nVersion + "\n- Status: Awaiting item signature from receiver");
                            items.push(nItem);
                            net.sendItemsToNetwork([nItem]);
                            eraseItem(tItem);
                            zenzo.call("gettransaction", txid).then(rawtx => {
                                res.json(nItem);
                            }).catch(function(){
                                console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'gettransaction " + txid + "' failed");
                                res.json({error: "Craft failure: ZENZO-RPC hangup"});
                            });
                        //}).catch(function(e){
                        //    console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'signmessage " + addy + " " + txid + "' failed (" + e + ", " + JSON.stringify(e) + ")");
                        //    res.json({error: "Craft failure: ZENZO-RPC hangup"});
                        //});
                    }).catch(function(e){
                        console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'sendrawtransaction " + signedTx.hex + "' failed (e: " + e + ")");
                        res.json({error: "Craft failure: ZENZO-RPC hangup"});
                    });
                }).catch(function(){
                    console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'signrawtransaction " + rawTx + "' failed");
                    res.json({error: "Craft failure: ZENZO-RPC hangup"});
                });
            }).catch(function(){
                console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'createrawtransaction " + JSON.stringify([{"txid":tItem.strTx,"vout":tItem.vout}]) + " " + receiverJson + "' failed");
                console.error(tItem.vout);
                res.json({error: "Craft failure: ZENZO-RPC hangup"});
            });
        //}).catch(function(){
        //    console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'gettxout " + tItem.strTx + " " + tItem.vout + "' failed");
        //    res.json({error: "Craft failure: ZENZO-RPC hangup"});
        //});
    });
});

// Forge Smelt
// The endpoint for smelting (destroying) items and converting them back into their native ZNZ value.
app.post('/forge/smelt', (req, res) => {
    if (net.getPeers().length === 0 || safeMode) return res.json({error: "Smelting is unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = net.cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    if (req.body.hash.length !== 64) return console.warn("Forge: Invalid TX-hash.");

    const smeltingItem = getItem(req.body.hash, true);
    if (smeltingItem === null) return res.json({error: "Smelting Item could not be found via it's TX hash."});

    console.info("Preparing to smelt " + smeltingItem.strName + "...");
    zenzo.call("gettransaction", smeltingItem.strTx).then(rawtx => {
        zenzo.call("lockunspent", true, [{"txid": smeltingItem.strTx, "vout": rawtx.details[0].vout}]).then(didUnlock => {
            if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
        }).catch(e => {
            console.warn("Unable to unlock collateral of (" + smeltingItem.strName + ")... continuing smelt process without auto-unlock!");
        }).finally(() => {
            zenzo.call("signmessage", addy, "smelt_" + smeltingItem.strTx).then(sig => {
                smeltItem({strTx: smeltingItem.strTx, strAddress: addy}, sig);
                res.json({message: "Item smelted, collateral unlocked and peers are being notified."});
            }).catch(console.error);
        });
    }).catch(console.error);
});

// Forge Items
// The endpoint for getting a list of validated and pending items
app.post('/forge/items', (req, res) => {
    items.sort(function(a, b){return b.nTimestamp-a.nTimestamp});
    let obj = {items: util.cleanItems(items, true)};

    // BACKWARDS-COMPAT NOTE/TODO: Remove after v1.0 launch!!!
    obj.pendingItems  = [];
    obj.unsignedItems = [];

    res.json(obj);
});

// Start a header-comparison item exchange with a peer
function exchangeItems(peer) {
    if (peer.isSendOnly())
        return false;

    // Give the peer efficient context into the item headers we've received from it previously.
    // ... This allows the peer to send us items ONLY if it's new OR updated via strTx + nVersion headers.

    return superagent
    .post(peer.host + "/forge/sync")
    //.send({items: util.cleanItems(items, true), smeltedItems: itemsSmelted})
    .send({headers_context: peer.syncedItems, smeltedItems: itemsSmelted})
    .then((res) => {
        let data = JSON.parse(res.text);
        console.log("Syncing with peer: (Our headers: " + peer.syncedItems.length + ", their items: " + data.items.length + ")");

        // Check if they want any of our items
        let itemsToSend = [];
        if (data.itemsWanted && data.itemsWanted.length > 0) {
            // Loop the headers and retrieve the full items from DB
            for (const nHeader of data.itemsWanted) {
                let nItem = getItem(nHeader, true, true);
                if (!_.isNil(nItem))
                    itemsToSend.push(nItem);
            }
            // Send the items to our peer!
            if (itemsToSend.length > 0) {
                console.log("Sending " + itemsToSend.length + " requested items to our peer!");
                peer.sendItems(itemsToSend);
            }
        }

        validateItemBatch(null, parseItems(data.items), false).then(done => {
            if (done) {
                // Only display net + validations stats IF anything actually changed
                if ((done.accepted + done.ignored + done.rejected) > 0) {
                    if (debug("net")) console.info(`Synced with peer "${peer.host}", we now have ${items.length} items!`);
                    if (debug("net") || debug("validations")) console.info("Validated item results from peer\n - Accepted: " + done.accepted + "\n - Ignored: " + done.ignored + "\n - Rejected: " + done.rejected);
                }
            } else if (debug("net")) console.warn(`Failed to sync with peer "${peer.host}"`);
        });

    }).catch((err) => {
        if (debug("net")) console.warn(`Unable to get items from peer "${peer.host}" --> ${err.message}`);
    });
}

// P2P Messaging System
// This endpoint is used to transfer standardized messages (data packets) between nodes effectively

// Every 750ms, check for (and process) messages in the queue
let messageProcessor = setInterval(function() {
    if (messageQueue.length === 0) return; // No messages to read!

    // We've got mail! Open it up and find out it's intention
    console.info("Processing message...");

    /* A peer wants to smelt an item */
    if (messageQueue[0].content.header === "smelt") {
        // Some simple parameter tests
        if (!messageQueue[0].content.item) {
            console.error("- Item TX missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item TX hash"});
            return messageQueue.shift();
        }
        if (!messageQueue[0].content.sig) {
            console.error("- Item signature missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item smelt signature"});
            return messageQueue.shift();
        }

        // Check if the item has already been smelted
        if (wasItemSmelted(messageQueue[0].content.item)) {
            messageQueue[0].res.json({message: "Item already smelted"});
            return messageQueue.shift();
        }

        // Get the item
        const smeltedItem = getItem(messageQueue[0].content.item, true);
        if (!smeltedItem || smeltedItem === null) {
            console.error("- Item couldn't be found!");
            messageQueue[0].res.json({error: "Missing or Invalid item"});
            return messageQueue.shift();
        }

        // Verify the smelt message's authenticity
        zenzo.call("verifymessage", smeltedItem.strAddress, messageQueue[0].content.sig, "smelt_" + smeltedItem.strTx).then(isGenuine => {
            if (isGenuine) {
                console.info("- Signature verified! Message is genuine, performing smelt...");
                messageQueue[0].res.json({message: "Smelt confirmed"});

                // Begin the local smelt process for the item
                smeltItem({strTx: smeltedItem.strTx, strAddress: smeltedItem.strAddress}, messageQueue[0].content.sig).then(smelted => {
                    console.info("- Item (" + smeltedItem.strName + ") smelted successfully!");
                });

                return messageQueue.shift();
            } else {
                console.error("- Invalid signature, ignoring smelt request.");
                messageQueue[0].res.json({error: "Invalid signature"});
                return messageQueue.shift();
            }
        }).catch(function(){
            console.error("- Malformed signature, ignoring smelt request.");
            messageQueue[0].res.json({error: "Malformed signature"});
            return messageQueue.shift();
        });
    }

    /* A peer wants to gracefully disconnect from us */
    else if (messageQueue[0].content.header === "disconnect") {
        // Remove the peer from our list
        return net.disconnectPeer(messageQueue[0].from.host);
    }
    
    // No matching header found, just count the message as "processed"
    else {
        if (debug("net")) console.error(" - Message with header '" + messageQueue.shift().content.header + "' ignored, no matching headers.");
    }
}, 750);

// Message Receive
// The endpoint for receiving messages from other public nodes
app.post('/message/receive', (req, res) => {
    try {
        let msg = req.body;
        if (!msg.header) throw "Missing header";
        if (msg.header.length === 0) throw "Empty header";

        // Message looks good, push it to the queue!
        let recvMsg = new ReceivedMessage("http://" + net.cleanIP(req.ip), msg, res);
        messageQueue.push(recvMsg);
        net.receivedPing();
        console.info("Message received from " + net.cleanIP(req.ip) + " successfully, appended to queue.");
    } catch (err) {
        if (debug("net")) console.error("Message sent by " + net.cleanIP(req.ip) + " is not JSON, ignoring.");
    }
});

/* ------------------ Core Forge Operations ------------------ */

// Smelt an item, permanently excluding it from the Forge and allowing the collateral to be safely spent
async function smeltItem (item, signature = null) {
    if (net.getPeers().length === 0 || safeMode) return;

    // If we own this item, unlock the collateral
    const thisItem = getItem(item.strTx, true);
    if (!_.isNil(thisItem) && addy === thisItem.strAddress) {
        try {
            let rawtx = await zenzo.call("gettransaction", thisItem.strTx);
            let didUnlock = await zenzo.call("lockunspent", true, [{"txid": thisItem.strTx, "vout": rawtx.details[0].vout}]);
            if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
        } catch (e) {
            console.warn("- Unable to unlock smelted item collateral (" + thisItem.strName + ")... continuing to smelt item without auto-unlock!");
        }
        // Remove smelted item from our locked list
        for (let i=0; i<lockedItems.length; i++) {
            if (lockedItems[i].strTx === item.strTx) {
                console.log("- Removed item from locked list!");
                lockedItems.splice(i, 1);
            }
        }
    }


    console.info("- Broadcasting smelt request to " + net.getPeers().length + " peer" + ((net.getPeers().length === 1) ? "" : "s"));
    asyncForEach(net.getPeers(), async (peer) => {
        if (!peer.isSendOnly()) {
            await superagent
            .post(peer.host + "/message/receive")
            .send({
                header: "smelt",
                item: item.strTx,
                sig: signature
            })
            .then((res) => {
                peer.lastPing = Date.now();
                if (debug("net")) console.info(`- Peer "${peer.host}" (${peer.index}) responded to smelt with "${res.text}".`);
            })
            .catch((err) => {
                if (debug("net")) console.warn(`- Unable to broadcast smelt to peer "${peer.host}" --> ${err.message}`);
            });
        }
    });

    // Add the item TX to the smelted DB
    itemsSmelted.push({tx: item.strTx, address: item.strAddress, sig: signature});
    await database.toDisk("smelted_items.json", itemsSmelted, true);
    console.info("- Written " + itemsSmelted.length + " smelted items to disk.");

    // Remove the item from our item lists
    eraseItem(item, true);

    return true;
}


/* ------------------ Daemon Operations ------------------ */

async function lockCollateralUTXOs() {
    if (debug("me")) console.info("--- (Re)Locking all item collaterals ---");
    await asyncForEach(items, async (lItem) => {
        try {
            if (!_.find(lockedItems, {'strTx': lItem.strTx}) && lItem.strAddress === addy) {
                let rawtx = await zenzo.call("gettransaction", lItem.strTx);
                let didLock = await zenzo.call("lockunspent", false, [{"txid": lItem.strTx, "vout": rawtx.details[0].vout}]);
                if (didLock) {
                    if (debug("me")) console.info("- Item (" + lItem.strName + ") collateral was successfully locked in ZENZO Coin Control.");
                    lockedItems.push({strName: lItem.strName, strTx: lItem.strTx, vout: rawtx.details[0].vout});
                }
            }
        } catch (e) {
            // Assume the UTXO was locked by a previous run of the Forge (or the QT locked it via forge.conf file)
            if (!_.find(lockedItems, {'strTx': lItem.strTx}) && lItem.strAddress === addy) {
                let rawtx = await zenzo.call("gettransaction", lItem.strTx);
                if (debug("me")) console.info("- Item (" + lItem.strName + ") collateral was successfully locked in ZENZO Coin Control.");
                lockedItems.push({strName: lItem.strName, strTx: lItem.strTx, vout: rawtx.details[0].vout});
            }
        };
    });

    // Write the Lockfile
    await writeLockfile();

    return true;
}

// Write to ZENZO Core's forge config to allow for persistent locks
async function writeLockfile() {
    let nConfigZC = "";
    for (const nLock of lockedItems) {
        nConfigZC += "\r\n" + util.sanitizeString(nLock.strName).replace(/ /g, "_") + " " + nLock.strTx + " " + nLock.vout;
    }
    await database.toDiskZC("forge.conf", nConfigZC, false);
    return true;
}

// This function intelligently finds or generates the Forge's single operator address
function selectOperatorAddress(forceNewAddress = false) {
    if (forceNewAddress) {
        zenzo.call("getnewaddress", forgeAccountLabel).then(nAddy => {
            setupForge(nAddy, true).then(done => {
                addy = nAddy;
                console.info("- New address (" + nAddy + ") successfully generated!");
                startForge();
            });
        });
    } else {
        zenzo.call("listaddressgroupings").then(nAddresses => {
            // Sanity check... (Don't want to loop a non-existent array!)
            if (nAddresses.length < 1 || nAddresses.length >= 1 && nAddresses[0].length < 1)
                // This wallet has no addresses at all, so let's just create a new one...
                return selectOperatorAddress(true);
            
            nAddresses = _.flatten(nAddresses);
            let selectedAddress = null;
            for (let i = 0; i < nAddresses.length; i++) {
                // We only care about labelled addresses (3rd array param), as we're searching for the "Forge" account
                if (nAddresses[i].length !== 3) continue;
                if (nAddresses[i][2] === forgeAccountLabel) {
                    // If there's more than one address, we prioritize accounts with a non-zero balance
                    // ... but if we can't find any to select, we settle with the first account we find.
                    if (_.isNil(selectedAddress)) {
                        // We accept the first address for comparison + last resort.
                        selectedAddress = nAddresses[i];
                        console.log("Selected address:");
                        console.log(selectedAddress);
                    } else
                    if (nAddresses[i][1] !== 0) {
                        // This address has a non-zero address, prioritize it and replace the previous.
                        selectedAddress = nAddresses[i];
                        console.log("Selected new address:");
                        console.log(selectedAddress);
                    } // else... we don't care about this zero'd address!
                }
            }
            if (_.isNil(selectedAddress)) {
                // The user has no Forge account, let's create a new one...
                console.log("No accounts found, generating new '" + forgeAccountLabel + "' account...");
                selectOperatorAddress(true);
            } else {
                // The user has a Forge account! Let's re-use this one...
                addy = selectedAddress[0];
                console.log("Account found! (" + addy + ")");
                // Save the recovered address to disk via Forge config file
                setupForge(addy, true).then(done => {
                    startForge();
                });
            }
        });
    }
}

async function findMatchingVouts(item) {
    // List of unspent vouts to search for
    let vouts = [0,1,2,3,4,5,6,7,8,9];
    let matchingVouts = [];
    await asyncForEach(vouts, async (vout) => {
        let nTx = await zenzo.call("gettxout", item.strTx, vout);
        if (nTx !== null) {
            if (nTx.value === item.nValue && nTx.scriptPubKey.addresses[0] === item.strAddress) matchingVouts.push(vout);
        }
    });
    return matchingVouts;
}

/* Core Node Mechanics */

// TEMP DB: Cache the number of DB entries for efficiency
let cachedDbEntries = 0;
let cachedUtxoLocks = 0;

// Load all relevent data from disk (if it already exists)
// Item data
function loadData() {
    if (!fs.existsSync(appdata + 'data/')) {
        console.warn("Init: dir 'data/' doesn't exist, creating new directory...");
        fs.mkdirSync(appdata); /* /forge */
        fs.mkdirSync(appdata + 'data'); /* /forge/data */
        console.info("Created data directory at '" + appdata + "data/" + "'");
    } else {
        console.info("Init: loading previous data from disk...");

        // Load our global Items list
        database.fromDisk("items.json", true).then(nDiskItems => {
            if (nDiskItems === null) {
                console.warn("Init: file 'items.json' missing from disk, ignoring...");
                nDiskItems = [];
            }

            // Initialize all raw item data into the CItem class
            for (let i = 0; i < nDiskItems.length; i++) {
                const objZFI = nDiskItems[i];
                try {
                    let cZFI = parseItem(objZFI);
                    if (cZFI === null) throw "Unexpected item initialization error";
                    items.push(cZFI);
                } catch (e) {
                    // Failed to initialize the item, skip it and dump some useful debuggin' data
                    console.error("Failed to initialize item(" + i + ")!");
                    console.error({
                        error: e,
                        db_pos: i,
                        raw_dump: objZFI
                    });
                }
            }

            // Load and initialize our Smelted Items list
            database.fromDisk("smelted_items.json", true).then(nDiskSmeltedItems => {
                if (nDiskSmeltedItems === null)
                    console.warn("Init: file 'smelted_items.json' missing from disk, ignoring...");
                else
                    itemsSmelted = nDiskSmeltedItems;
                
                if (itemsSmelted.length > 1) {
                    // Check if DB uses the old smelt format, wipe smelts from memory + disk to avoid unexpected TypeErrors
                    if (typeof itemsSmelted[0] === "string") {
                        while (itemsSmelted.length) itemsSmelted.pop();
                        database.toDisk("smelted_items.json", "[]", false).then(() => {
                            console.log("Smelt database wiped!");
                        });
                    }

                    // Check for the 'missing addy' bugged items and remove them
                    for (let i=0; i<itemsSmelted.length; i++) {
                        if (!itemsSmelted[i].strAddress) {
                            itemsSmelted.splice(i, 1);
                        }
                    }
                }

                // Log our DB states
                console.info("Init - loaded from disk:\n- Items: " + items.length + "\n- Smelted Items: " + itemsSmelted.length);
            });
        });
    }
    // Initialize Game Manager
    games_manager.init().then(() => {
        console.info("Game Manager: Ready!");
    });
}

loadData();

// Start the "janitor" loop to ping peers, validate items and save to disk at intervals
let janitor = setInterval(function() {
    let peers = net.getPeers();
    // We have no connected peers, so let's keep attempting to connect to seednodes
    if (peers.length === 0 && !safeMode && isForgeRunning) {
        net.connectSeednodes();
    }

    // No peers, safemode or not running. Cannot perform core operations yet
    if (peers.length === 0 || safeMode || !isForgeRunning) return;

    // Ping peers
    peers.forEach(peer => {
        peer.ping();
        exchangeItems(peer);
    });

    // Keep a list of our personal items to broadcast to peers later...
    let ourItems = [];

    // Sign unsigned items that belong to us, and remove unsigned items that have been recently signed
    let hasSignedItem = false;
    let unsignedItems = getUnsignedItems();
    if (unsignedItems.length > 0) {
        unsignedItems.forEach(unsignedItem => {
            if (unsignedItem.strAddress === addy) {
                if (debug("me")) console.info("Signing received unsigned item (" + unsignedItem.strName + ")...");
                hasSignedItem = true;
                zenzo.call("signmessage", addy, unsignedItem.strTx).then(sig => {
                    if (sig && sig.length > 5) {
                        unsignedItem.strSig = sig;   // Attach the signature
                        unsignedItem.nVersion++;     // Increment version
                        ourItems.push(unsignedItem); // Broadcast to the world!
                        if (debug("me")) console.info(" - Item signed successfully!");
                    } else {
                        if (debug("me")) console.error(" - Signing failed...");
                    }
                });
            }
        });
    }

    // Send our validated items to peers
    if (items.length > 0) {
        let fullValidation = (fullNode && validationQueue.count % 5 === 0);
        if (fullValidation && debug("validations")) console.log("Preparing to validate ALL items...");
        _.map(items, function(i) {
            // Only revalidate non-essential items every 5 validation rounds, if we're a full node
            if (fullValidation || doesItemInvolveMe(i)) {
                addToValidationQueue(i, true);
                // Save the item for broadcasting if it's related to us
                if (doesItemInvolveMe(i))
                    ourItems.push(i);
            }
        });
        
        // Items newer than 15 minutes are given 'priority' in propagation to ensure they propagate enough,
        // this happens only after the initial bootup distribution.
        if (ourItems.length > 0) {
            if (hasDistributedItems && validationQueue.count % 3 === 0 || hasDistributedItems && hasSignedItem) {
                // We use the validation queue round to prevent 'overloading' the network with too many already-known items.
                // If we signed an item, we ignore the queue rounds entirely for quickness.
                let ourNewItems = [];
                ourItems.forEach(nOurItem => {
                    if (nOurItem.nTimestamp && nOurItem.nTimestamp > 0) {
                        if (nOurItem.nTimestamp + (15 * 60) > (Date.now() / 1000))
                            ourNewItems.push(nOurItem);
                    }
                });
                if (ourNewItems.length > 0) {
                    // Broadcast our new items
                    console.log("Propagating " + ourNewItems.length + " new node-related items to the network...");
                    net.sendItemsToNetwork(ourNewItems, itemsSmelted);
                }
            } else
            if (peers.length >= 2 && !hasDistributedItems) {
                // Broadcast all of our own items to peers, if we have enough of them.
                // We only do this once per-boot for efficiency.
                console.log("Propagating " + ourItems.length + " node-related items to the network...");
                net.sendItemsToNetwork(ourItems, itemsSmelted);
                hasDistributedItems = true;
            }
        }

        // Execute the validation queue
        runValidationQueue();
    }

    // Save data to disk
    let newDbEntries = items.length + itemsSmelted.length;
    let hasDbChanged = (newDbEntries !== cachedDbEntries);
    cachedDbEntries = newDbEntries;

    // The 'functions / methods' of the CItems *should* automatically be ignored,
    // ... so let's just save the raw, stringified 'items' array to disk!
    // Note: Kyeno will kill me if I'm wrong here!
    database.toDisk("items.json", items, true).then(() => {
        if (hasDbChanged) console.log('Database: Written ' + items.length + ' items to disk.');
        database.toDisk("smelted_items.json", itemsSmelted, true).then(() => {
            if (hasDbChanged) console.log('Database: Written ' + itemsSmelted.length + ' smelted items to disk.');
        });
    });

    // Lock any UTXOs that belong to our unlocked items
    lockCollateralUTXOs().then(() => {
        if (lockedItems.length != cachedUtxoLocks) {
            cachedUtxoLocks = lockedItems.length;
            if (debug("me")) console.info("Now " + lockedItems.length + " UTXOs locked!");
        }
    });
}, 10000);

// Setup the wallet variables
let addy = null;
let zenzo = null;
let rpcAuth;

let isForgeRunning = false;
let hasDistributedItems = false;

// Catch if the wallet RPC isn't available
function rpcError() {
    net.clear();
    safeMode = true;
    // TODO: Ensure this is 100% safe, could this cause potential init-race-conditions?
    isInitializing = false;
}

// Load variables from disk config
let isInitializing = false;
function startForge() {
    if (isInitializing) return;
    isInitializing = true;
    database.fromDisk("config.json", true).then(config => {
        /* Forge Config file (full configuration options) */
        if (!config) {
            console.warn("- config.json is missing, if you're not using the Forge GUI wallet, you'll have to fix this manually.");
            isInitializing = false;
            return;
        }

        /* Fullnode Toggle (bool) */
        if (!_.isNil(config.fullnode) && typeof config.fullnode === "boolean") {
            fullNode = config.fullnode;
        } else {
            console.warn("- Config missing 'fullnode', defaulting to '" + fullNode + "'");
        }

        /* RPC Authentication (object of auth details) */
        rpcAuth = {
            user: config.wallet.user,
            pass: config.wallet.pass,
            port: config.wallet.port
        };

        /* Operator Address (string) */
        if (_.isNil(addy)) {
            if (config.wallet.address !== null) {
                addy = config.wallet.address.replace(/ /g, "");
            } else {
                console.warn("- Config missing 'address', searching for operator address...");
            }
        }

        /* ZENZO Core data directory (string path) */
        if (config.wallet.datadir) {
            appdataZC = config.wallet.datadir.replace(/\\/g, '/');
            // Make sure the ending "/" isn't missing
            if (!appdataZC.endsWith("/"))
                appdataZC += "/";
            
            // Update the database paths
            database.updatePaths(appdata, appdataZC);
        } else {
            console.warn("- Config missing 'wallet.datadir', defaulting to '" + appdataZC +"'");
        }

        /* ZENZO Core RPC daemon (RPC) */
        zenzo = new RPC('http://' + rpcAuth.user + ':' + rpcAuth.pass + '@localhost:' + rpcAuth.port);

        /* Forge Port (int) */
        if (config.forgeport) {
            forgePort = config.forgeport;
        } else {
            console.info("- Config missing 'forgeport' option, defaulting to '" + forgePort + "'.");
        }

        /* Max Invalid Score (number) */
        if (config.maxinvalidscore) {
            maxInvalidScore = config.maxinvalidscore;
        }

        /* Debug Options (array of string options) */
        if (config.debug) {
            try {
                // Remove whitespace (No more space typos, Josep!)
                let debugTmp = config.debug.replace(/ /g, "");
                // Attempt to split the debug option if a delimiter is specified
                if (debugTmp.includes(",")) {
                    debugType = debugTmp.split(",");
                } else {
                    debugType = [debugTmp];
                }
            } catch (e) {
                console.warn("- Config 'debug' option is invalid, defaulting to '" + debugType + "' (" + e + ")");
            }
        } else {
            console.info("- Config missing 'debug' option, defaulting to '" + debugType + "'.");
        }
        
        // --- BEGIN NODE INITIALIZATION --- \\
        zenzo.call("ping").then(msg => {
            // If there's no address in the config, generate one and re-run the startForge process again
            if (addy === null || addy.length !== 34) {
                isInitializing = false;
                return selectOperatorAddress();
            } else {
                // We have an address in our config, so let's ensure it's known to the wallet before accepting it
                zenzo.call("getaddressinfo", addy).then(addyInfo => {
                    if (addyInfo.ismine !== 1) {
                        // This address doesn't belong to us, the user probably switched wallet.dat files or configs,
                        // ... lets resolve that!
                        console.log("- Address (" + addy + ") is unknown, searching for operator address...");
                        isInitializing = false;
                        return selectOperatorAddress();
                    }
                    console.info("ZENZO Forge v" + npm_package.version +  " \n--- Configuration ---\n - Full Node: " + fullNode + "\n - RPC Port: " + rpcAuth.port + "\n - ZENZO Core datadir: " + appdataZC + "\n - Forge Port: " + forgePort + "\n - Forge Address: " + addy + "\n - Debugging Mode(s): " + debugType + "\n - Max Invalidation Score: " + maxInvalidScore + "\n");
                    console.log("Connected to ZENZO-RPC successfully!");

                    // Incase the zenzod daemon was restarted, re-lock our collateral UTXOs to prevent accidental spends
                    lockCollateralUTXOs().then(locked => {
                        if (locked) console.info("All collaterals locked successfully!");
                        // Start listening for Forge requests
                        app.listen(forgePort);

                        // Let's bootstrap the validator with seednodes
                        net.connectSeednodes();
                        isForgeRunning = true;
                        safeMode = false;
                    });
                }).catch(function(e){
                    console.error("Failed to validate address '" + addy + "'. (" + e + ")\nSearching for valid operator address...");
                    isInitializing = false;
                    return selectOperatorAddress();
                });
            }
        }).catch(function(e){
            console.error("Failed to connect to ZENZO-RPC, running Forge in Safe Mode. (" + e + ")");
            rpcError();
        });
    });
}

startForge();

// Create Forge and ZENZO Core configuration files, and populate with information
async function setupForge(address, forgeOnly = false) {
    // Forge config
    let nConfig = {
        fullnode: fullNode,
        wallet: {
            datadir: appdataZC,
            user: forgeOnly ? rpcAuth.user : crypto.createHash('sha256').update(nanoid(32)).digest('hex'),
            pass: forgeOnly ? rpcAuth.pass : crypto.createHash('sha256').update(nanoid(64)).digest('hex'),
            port: 26211,
            address: address
        },
        forgePort: forgePort,
        maxinvalidscore: 25,
        debug: debugType.join(",")
    }
    await database.toDisk("config.json", nConfig, true);
    if (forgeOnly) return true;

    // ZENZO Core config
    let nConfigZC = [
        "# Config created automatically by the ZENZO Forge",
        "txindex=1",
        "rpcuser=" + nConfig.wallet.user,
        "rpcpassword=" + nConfig.wallet.pass,
        "listen=1",
        "server=1",
        "rpcallowip=127.0.0.1"
    ]

    await database.toDiskZC("zenzo.conf", nConfigZC.join("\r\n"), false);
    return true;
}


// Save our AuthKey to disk to allow other applications to access the user's Forge node during private actions
/* This is insecure, and will be revamped in the future to have a permission-based system, instead of private key based */
database.toDisk("auth.key", authToken, false).then(res => {
    console.log('Database: Written AuthKey to disk.');
});