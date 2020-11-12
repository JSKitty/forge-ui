const crypto =     require('crypto');
const fs =         require('fs');
const superagent = require('superagent');
const express =    require('express');
const bodyParser = require('body-parser');
const RPC =        require('bitcoin-rpc-promise');
const nanoid =     require('nanoid');
var _ =            require('lodash');

let script;
let params;
let util;
let database;
let games_manager;
try {
// GUI
    script =        require('./lib/script.js');
    params =        require('./lib/params.js');
    util =          require('./lib/util.js');
    database =      require('./lib/database.js');
    games_manager = require('./lib/games_manager.js');
} catch (e) {
// Terminal
    script =        require('./script.js');
    params =        require('./params.js');
    util =          require('./util.js');
    database =      require('./database.js');
    games_manager = require('./games_manager.js');
}


// System Application data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support/Zenzo/' : process.env.HOME + '/.zenzo/');
if (appdataZC === process.env.APPDATA) appdataZC += '/Zenzo/'; // Append '/Zenzo/' to the windows appdata directory
appdataZC = appdataZC.replace(/\\/g, '/');

/* ------------------ GLOBAL SETTINGS ------------------ */
// The debugging mode, this allows the user to customize what the forge should log
// Debug types: all, none, validations, deepvalidations, me
let debugType = ["me","validations"];

// Return if the current debug mode includes the caller's debug type
function debug(type) {
    if (debugType.includes("all")) return true;
    if (debugType.includes("none")) return false;

    if (debugType.includes("validations") && "validations" === type) return true;
    if (debugType.includes("deepvalidations") && "deepvalidations" === type) return true;
    if (debugType.includes("net") && "net" === type) return true;
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
// The list of all known peers
let peers = [];

// The list of hardcoded, developer-approved seednodes
const seednodes = ["144.91.87.251:8000", "164.68.102.142:45001"];

// Have other nodes connected to us previously? (We assume not, until we actually receive some data)
let canReceiveData = false;

// The list of all known items on the Forge network
let items = [];

// The list of items our node has locked previously
let lockedItems = [];

// The state and list of items in the validation queue
let validationQueue = {
    validating: false, // Returns true if the node is busy validating
    list: [],
    count: 0 // The count of total Validation locks performed
}

// The list of "pending" items, of which require further validations
let itemsToValidate = [];

// The list of "unsigned" items, of which require the receiver's signature
let unsignedItems = [];

// The list of smelted items, this can be checked to ensure that a peer doesn't send us a smelted item, thus accidently accepting it due to being valid
let itemsSmelted = [];

// The list of messages that are in the processing queue
let messageQueue = [];

// Get a peer object from our list by it's host or index
function getPeer (peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg || peers[i].index === peerArg) return peers[i];
    }
    return null;
}

// Updates the contents of a peer object
function updatePeer (peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg.host || peers[i].index === peerArg.index) {
            peers[i] = peerArg;
            return true;
        }
    }
    return false;
}

// Removes a peer from the peers list
function disconnectPeer (peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg || peers[i].index === peerArg) {
            peers.splice(i, 1);
            if (debug("net")) console.warn("Removed peer, we now have " + peers.length + " peer" + (peers.length === 1 ? "" : "s"));
        }
    }
    // Re-index peers to prevent "holes" in the peers array when accessed from a peer class
    for (let index=0; index<peers.length; index++) {
        peers[index].index = index;
    }
}


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
        nItem.value = formatNum(nItem.value);
        if (!_.isNil(nItem.sig) && nItem.sig.length > 1)
            isUnsigned = false;
    }

    // Check if the item was previously smelted
    if (!isInvalid && wasItemSmelted(nItem.tx)) {
        isSmelted = true;
    }

    // Check if we already know the item
    // TODO: Add some hash-comparison checks, as this assumes far too much and could cause issues
    // ... when the ability to 'update' items is introduced, this check caused the implementation
    // ... of transfers to fail, for example.
    if (fullNode && !revalidate && !isInvalid && !isSmelted && !isUnsigned && hasItem(nItem.tx)) {
        isIgnored = true;
    }

    if (!isInvalid && !revalidate && !isIgnored && !isSmelted && !isUnsigned || // Signed items
        !isInvalid && revalidate && !isSmelted && !isUnsigned || // Signed revalidating items
        !isInvalid && isUnsigned) { // Unsigned items
        // Finally, ensure the item isn't already being validated
        if (!isItemValidating(nItem.tx)) {
            nItem.isUnsigned = isUnsigned;
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

    // Deep clone for queue immutability
    validationQueue.lockedList = _.cloneDeep(validationQueue.list);
    let lockedLen = validationQueue.lockedList.length;
    if (debug("validations")) {
        console.info("Starting item queue validation...");
        console.time("Batch validation for " + lockedLen + " items");
    }

    // Attempt to clear the validationQueue list in the most efficient and safe way possible
    if (lockedLen === validationQueue.list.length) {
        // Try 1: If no new items have been added since the clone, clear the list completely.
        while (validationQueue.list.length) validationQueue.list.pop();
    } else {
        // Try 2: If new items were added since the clone, loop through the list and splice items in our lockedList.
        // This protects the immutability of the list and prevents race-conditions that accidently drop/lose items.
        let i, len = lockedLen;
        if (debug("validations")) console.warn("Validation Queue has been Mutated!");
        for (i=0; i<len; i++) {
            if (debug("validations")) console.info(" - lockedList["  + i + "] = " + validationQueue.lockedList[i].tx + ", list[" + i + "] = " + validationQueue.list[i].tx);
            if (validationQueue.lockedList[i].tx === validationQueue.list[i].tx) {
                validationQueue.list.splice(i, 1);
                i--;
            }
        }
    }


    // Begin validation
    let i = 0;
    asyncForEach(validationQueue.lockedList, async (item) => {
        // Check if the item's contents are genuine
        let isUnsigned = (!item.sig ? true : false);
        let valid = await isItemValid(item, isUnsigned, true);
        if (!valid) {
            if (debug("deepvalidations")) console.error("Forge: Received item is not genuine, rejected.");
        }
        if (i+1 === lockedLen) {
            // No more items in the queue
            if (debug("validations")) console.timeEnd("Batch validation for " + lockedLen + " items");
            while (validationQueue.lockedList.length) validationQueue.lockedList.pop();
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
    cList.push(items);
    if (includePending) cList.push(itemsToValidate);
    if (includeUnsigned) cList.push(unsignedItems);

    // Clean the item of any local-only information and flatten down one array
    cList = cleanItems(_.flatten(cList));

    // Loop cList, hash the stringified item data and push into hashed list
    let hashedList = [];
    await asyncForEach(cList, async (rawItem) => {
        hashedList.push({hash: crypto.createHash('md5').update(JSON.stringify(rawItem)).digest('hex'), tx: rawItem.tx});
    });

    return hashedList;
}

// Validates if an item's contents complies with basic bare-bones requirements
function isItemContentValid (nItem) {
    // TX length is fixed (64 bytes hash)
    if (nItem.tx.length !== 64) {
        console.error("Forge: Received invalid item, TX length is not 64. (Has: " + nItem.tx.length + ")");
        return false;
    }
    // Address length is fixed (34 bytes)
    if (nItem.address.length !== 34) {
        console.error("Forge: Received invalid address, length is not 34. (Has: " + nItem.address.length + ")");
        return false;
    }

    // Name is custom, human-readable but must be between 1 and 50 chars
    if (nItem.name.length < 1) {
        console.error("Forge: Received invalid name, length is below 1. (Has: " + nItem.name.length + ")");
        return false;
    } else if (nItem.name.length > 50) {
        console.error("Forge: Received invalid name, length is over 50. (Has: " + nItem.name.length + ")");
        return false;
    }

    // Value is custom but must be atleast 0.001 ZNZ
    if (nItem.value < 0.001) {
        console.error("Forge: Received invalid item, value is below minimum. (Has: " + nItem.value + ", Min: 0.001)");
        return false;
    }

    // Basic checks passed! Now we clean the item to ensure there's no accidental data parts from unsanitized broadcasts.
    nItem = cleanItems([nItem])[0];

    // Ensure the item has no unexpected / illegal keys
    const acceptedKeys = [
        "tx", "timestamp", "prev", "sig", "address", "name", "image", "value", "metadata", "contracts", // Public (clean) keys
        "vout", "isUnsigned", "invalidScore", // Private (unclean) keys, these should NOT come from peers, this allows for more efficient internal validation
        "hash"                                // Deprecated keys (These are 'okay' to accept, but will eventually be removed entirely)
    ];
    const validKeyTest = util.areKeysValid(acceptedKeys, nItem);
    if (validKeyTest !== true) {
        console.error("Forge: Received invalid item, illegal key '" + validKeyTest + "' found...");
        return false;
    }

    // DEPRECATED: This can be removed before v1.0, this is a security precaution to ensure the 'hash' key
    // ... is not used maliciously to bloat the network.
    if (nItem.hash)
        delete nItem.hash;

    // If the item contains metadata, limit the amount of data it can store to prevent excessive network load
    if (nItem.metadata) {
        let nRaw;
        try {
            nRaw = JSON.stringify(nItem.metadata);
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
    }

    // If the item contains any smart contracts, ensure they're collectively under 1 KB in size
    if (nItem.contracts && !_.isEmpty(nItem.contracts)) {
        let nRaw;
        try {
            if (typeof nItem.contracts !== "object") {
                nItem.contracts = JSON.parse(nItem.contracts);
            }
            nRaw = JSON.stringify(nItem.contracts);
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
        nItem.contracts = [];
    }

    // If an item has no signature, ensure it has a "prev" input specified
    if (!nItem.sig) {
        if (!nItem.prev) {
            console.error("Forge: Received invalid unsigned item, prev is missing.");
            return false;
        }
    }

    return true;
}


// Validates if an item is genuine
async function isItemValid (nItem, isUnsigned, approve = false) {
    try {
        delete nItem.isUnsigned;

        // Soft local-node checks
        // Was the item smelted? (Prevents race-conditions where an item is smelted while inside the validation queue)
        if (wasItemSmelted(nItem.tx)) {
            eraseItem(nItem, true);
            if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' was previously smelted.");
            return false;
        }
        
        // Does the item meet bare-bones content requirements?
        if (!isItemContentValid(nItem)) {
            eraseItem(nItem, true);
            if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' doesn't meet content requirements.");
            return false;
        }

        // Execute the item's validation contract (If it has one)
        if (!_.isEmpty(nItem.contracts) && !_.isNil(nItem.contracts.validation)) {
            // Check if the validation contract requires any contextual data, if so, we inject it into the context
            const contexts = script.containsContextualCodes(nItem.contracts.validation);
            const opcodes = script.getOpcodes();
            // To allow for easy self-contexts, we always inject our own item data
            let contextualData = {
                this: nItem
            };

            if (!_.isNil(contexts)) {
                if (contexts.includes(opcodes.GETBESTBLK)) {
                    // Retrieve the best block from our daemon
                    contextualData.bestBlock = await zenzo.call("getblockcount");
                } else
                if (contexts.includes(opcodes.ISNAMEUSED) ||
                    contexts.includes(opcodes.GETITEMEPOCH)) {
                    // Provide a deep clone of all existing signed items (to search for the desired name)
                    contextualData.signedItems = _.flatten(_.cloneDeep([items, itemsToValidate]));
                }
            }
            let res = await script.execute(nItem.contracts.validation, contextualData);
            // A "validation" script MUST return "1" AND execute successfully, otherwise the item is invalid
            if (res.result !== 1 || !res.success) {
                if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' validation contract " + (!res.success ? "failed" : "resulted in '" + res.result + "'") + ", invalid item.");
                eraseItem(nItem, true);
                return false;
            }
        }

        // Begin deep chain/mempool + signature validation
        //if (debug("deepvalidations")) console.info("Validating item: '" + nItem.name + "' from " + nItem.address);
        // Ensure the collateral TX exists either in the blockchain or mempool
        let rawTx;
        try {
            rawTx = await zenzo.call("getrawtransaction", nItem.tx, 1);
        } catch (e) {/* Silently catch getrawtransaction errors */}
        if (!rawTx || !rawTx.vout || !rawTx.vout[0]) {
            if (debug("deepvalidations")) console.warn('Forge: Item "' + nItem.name + '" is not in the blockchain.');
            let testItem = getItem(nItem.tx, true, true);
            // Case 1: We already have this item, so we keep it within our DB and simply add invalidation score
            if (!_.isNil(testItem)) {
                addInvalidationScore(nItem, 2);
            }
            // Case 2: We don't have any history of this item, so we add it to our pending or unsigned list
            else {
                if (isUnsigned) {
                    unsignedItems.push(nItem);
                    if (debug("deepvalidations")) console.log("New untrusted unsigned item added to DB");
                } else {
                    itemsToValidate.push(nItem);
                    if (debug("deepvalidations")) console.log("New untrusted signed item added to DB");
                }
                // Add invalidation score to the newly-added item
                addInvalidationScore(nItem, 2);
            }
            return false;
        }
        for (let i=0; i<rawTx.vout.length; i++) {
            if (rawTx.vout[i].value === nItem.value) {
                if (rawTx.vout[i].scriptPubKey.addresses.includes(nItem.address)) {
                    //if (debug("deepvalidations")) console.log("Found pubkey of item...");

                    // Upgrade the item if it has missing parameters
                    upgradeItem(nItem, rawTx);

                    let isSigGenuine = false;
                    if (nItem.sig)
                        isSigGenuine = await zenzo.call("verifymessage", nItem.address, nItem.sig, nItem.tx);
                    if (isSigGenuine || !isSigGenuine && isUnsigned) {
                        //if (debug("deepvalidations") && !isUnsigned) console.info("Sig is genuine...");
                        //if (debug("deepvalidations") && isUnsigned) console.info("Item is unsigned but valid...");
                        let res = await zenzo.call("gettxout", nItem.tx, i); // i is the vout from the previous rawTx.vout[] forloop
                        
                        // Ensure the collateral output hasn't been spent
                        if (res === null) {
                            if (debug("deepvalidations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' has no UTXO");
                            // Be softer on our own items
                            if (doesItemInvolveMe(nItem)) {
                                addInvalidationScore(nItem, 2.5);
                            } else {
                                addInvalidationScore(nItem, 12.5);
                            }
                            return false; // UTXO has been spent (Or doesn't yet exist, so we give it a chance to appear in mempool/chain)
                        }
                        
                        // Ensure UTXO data matches item data
                        if (res.value === nItem.value) {
                            if (res.scriptPubKey.addresses[0] === nItem.address) {
                                //if (debug("deepvalidations")) console.info("Found unspent UTXO collateral...");
                                if (approve) approveItem(nItem);
                                return true; // Found unspent collateral UTXO on-chain
                            } else {
                                if (debug("deepvalidations")) console.warn("Item address (" + nItem.address + ") doesn't match it's TX collateral address (" + ((res !== null) ? res : resSecondary).scriptPubKey.addresses[0] + ")");
                                addInvalidationScore(nItem, 12.5);
                                return false;
                            }
                        } else {
                            if (debug("deepvalidations")) console.warn("Item value (" + nItem.value + ") doesn't match it's TX collateral value (" + ((res !== null) ? res : resSecondary).value + ")");
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
    });

    runValidationQueue();

    if (reply) res.send("Thanks!");
    return validationStats;
}

// Validate new deterministic smelts
function validateSmelts(smelts) {
    asyncForEach(smelts, async (smelt) => {
        // Barebones security checks
        if (!_.isNil(smelt.address) && !_.isNil(smelt.tx) && !_.isNil(smelt.sig)) {
            // Ensure we don't already have a copy of the smelt
            if (!wasItemSmelted(smelt.tx)) {
                // Verify the signature and smelt is genuine
                console.info("Verifying smelt for item (" + smelt.tx + ")");
                console.info(smelt);
                zenzo.call("verifymessage", smelt.address, smelt.sig, "smelt_" + smelt.tx).then(isGenuine => {
                    if (isGenuine) {
                        console.info("- Signature verified! Smelt is genuine, performing smelt...");
        
                        // Begin the local smelt process for the item
                        smeltItem({tx: smelt.tx, address: smelt.address}, smelt.sig).then(smelted => {
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

// Upgrade an item with the latest mandatory parameters
function upgradeItem(nItem, rawTx) {
    let hasUpdated = false;
    if (!nItem.timestamp || nItem.timestamp && nItem.timestamp < 1) {
        nItem.timestamp = rawTx.blocktime;
        hasUpdated = true;
    }
    // A previous bug left an array in place of blank contracts, this must be an empty object
    // ... to avoid confusion or future TypeErrors.
    if (!_.isPlainObject(nItem.contracts) && _.isEmpty(nItem.contracts)) {
        nItem.contracts = {};
        hasUpdated = true;
    }
    // Items without an image should always use "default" to signal DApp UIs to use their own icon in-place.
    if (!nItem.image) {
        nItem.image = "default";
        hasUpdated = true;
    }
    // DEPRECATED: This can be removed before v1.0, this is a security precaution to ensure the 'hash' key
    // ... is not used maliciously to bloat the network.
    if (nItem.hash)
        delete nItem.hash;
    if (hasUpdated)
        return updateItem(nItem);
    else
        return false;
}

// Approve an item as valid, moving it to the main items DB and removing it from the pending list
function approveItem(item) {
    let wasFound = false;
    let itemFromUnsigned;

    // First, check the pending list for the item
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            wasFound = true;
            items.push(item);
            itemsToValidate.splice(i, 1);
            console.info("A pending item has been approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
        }
    }
    
    // Now we check unsigned items for a match, and if the newly approved item is the signed version; we replace the unsigned item
    for (let i=0; i<unsignedItems.length; i++) {
        if (item.tx === unsignedItems[i].tx) {
            if (item.sig && !unsignedItems[i].sig) {
                if (item.sig.length > 0) {
                    item.signedByReceiver = true;
                    unsignedItems.splice(i, 1);
                    console.info("An unsigned item has been signed by it's owner!\n - Item '" + item.name + "' (" + item.tx + ") removed from unsigned list");
                }
            }
            itemFromUnsigned = item;
            wasFound = true;
        }
    }

    // If we found an Unsigned Item, ensure we gracefully erase the "prev" item as it's UTXO has been spent
    if (!_.isNil(itemFromUnsigned)) {
        eraseItem(itemFromUnsigned.prev[0], true);
    }

    // If the item isn't already in the validation list and isn't already approved, add it as a new approved item. Or if unsigned, add to the unsigned list
    if (!wasFound) {
        wasFound = false;
        for (let i=0; i<items.length; i++) {
            if (item.tx === items[i].tx) {
                wasFound = true;
            }
        }
        if (!wasFound && !_.isNil(item.sig)) {
            // Case 1: New valid signed item
            delete item.signedByReceiver;
            items.push(item);
            console.info("An item has been added and approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
        } else if (!wasFound && !item.signedByReceiver && !item.sig && _.isNil(itemFromUnsigned)) {
            // Case 2: New valid unsigned item
            delete item.signedByReceiver;
            console.info("An unsigned item has been added to the unsigned list!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as an unsigned item.");
            unsignedItems.push(item);
        } else if (!_.isNil(itemFromUnsigned) && item.signedByReceiver && itemFromUnsigned.tx === item.tx) {
            // Case 3: Old unsigned item receiving an update
            delete item.signedByReceiver;
            console.info("An unsigned item has been updated!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
            eraseItem(item, true);
            items.push(item);
        } else if (wasFound && _.isNil(itemFromUnsigned) && !item.signedByReceiver) {
            // Case 4: This is a fully valid item with no changes, silently ignore
        } else {
            // This shouldn't happen... but log errors just incase!
            console.warn(" --- UNEXPECTED ITEM VALIDATION ERROR ---");
            console.warn({wasFound: wasFound, itemFromUnsigned: itemFromUnsigned});
            console.warn(item);
            console.warn("WARNING: approveItem() for (" + item.name + ", " + item.tx + ") met no conditions, this item has unexpected properties!\n --- Please report this to the developer! ---");
        }
    }
}

// Disprove an item, moving it out of the main items DB and to the pending list, and removing it entirely if it gets disproven again
function disproveItem(item) {
    // If the item is in our pending list, remove it entirely from the node
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            eraseItem(item, true);
            if (debug("validations")) console.warn("A bad item has been erased!\n - Item '" + item.name + "' (" + item.tx + ") has been erased from the local database.");
        }
    }

    // If the item is in our validated items, move it down a level into the pending list
    for (let i=0; i<items.length; i++) {
        if (item.tx === items[i].tx) {
            itemsToValidate.push(items[i]);
            items.splice(i, 1);
            if (debug("validations")) console.warn("An item has been disproved!\n - Item '" + item.name + "' (" + item.tx + ") has been removed as a verified item and is now pending.");
        }
    }
}

// Erase an item from all DB lists (minus smelt list)
function eraseItem(item, includeUnsigned = false) {
    for (let i=0; i<items.length; i++) {
        if (item.tx === items[i].tx) {
            items.splice(i, 1);
        }
    }
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            itemsToValidate.splice(i, 1);
        }
    }
    for (let i=0; i<validationQueue.list.length; i++) {
        if (item.tx === validationQueue.list[i].tx) {
            validationQueue.list.splice(i, 1);
        }
    }

    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (item.tx === unsignedItems[i].tx) {
                unsignedItems.splice(i, 1);
            }
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
    if (_.find(items, {'tx': item})) return "items";
    if (_.find(itemsToValidate, {'tx': item})) return "itemsToValidate";
    return false;
}

// Check if we have the item in our validation queue
function isItemValidating(item) {
    if (_.find(validationQueue.lockedList, {'tx': item})) return true;
    if (_.find(validationQueue.list, {'tx': item})) return true;
    return false;
}

// Check if an item object is involved with our wallet (address)
function doesItemInvolveMe(item) {
    if (item.address === addy ||
        !_.isNil(item.prev) && !_.isNil(item.prev[0]) && item.prev[0].address === addy) return true;
    return false;
}

// Increments the invalidation score of an item, if this score reaches maxInvalidScore, the item is considered irreversibly invalid, and removed from the DB permanently
function addInvalidationScore(item, score) {
    for (let i=0; i<items.length; i++) {
        if (item.tx === items[i].tx) {
            if (!items[i].invalidScore) items[i].invalidScore = 0;
            items[i].invalidScore += score;
            item.invalidScore = items[i].invalidScore;
            if (debug("validations")) console.info("An invalidation score of '" + score + "' has been applied to '" + item.name + "', now totalling '" + items[i].invalidScore + "' invalidation score.");
            if (item.invalidScore >= maxInvalidScore) {
                item.invalidScore = 0;
                disproveItem(item);
                if (debug("validations")) console.info(" - Item has been invalidated to Pending due to exceeding the invalidation score threshold.");
            }
        }
    }
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            if (!itemsToValidate[i].invalidScore) itemsToValidate[i].invalidScore = 0;
            itemsToValidate[i].invalidScore += score;
            item.invalidScore = itemsToValidate[i].invalidScore;
            if (debug("validations")) console.info("An invalidation score of '" + score + "' has been applied to '" + item.name + "', now totalling '" + itemsToValidate[i].invalidScore + "' invalidation score.");
            if (item.invalidScore >= maxInvalidScore) {
                disproveItem(item);
                if (debug("validations")) console.info(" - Item has been abandoned due to exceeding the invalidation score threshold.");
            }
        }
    }
}

// Cleans a list of items of their local-node data (Does not mutate original list)
function cleanItems (itemList) {
    let tmpItemList = _.cloneDeep(itemList);
    for (let i=0; i<tmpItemList.length; i++) {
        delete tmpItemList[i].invalidScore;
        delete tmpItemList[i].signedByReceiver;
        delete tmpItemList[i].isUnsigned;
        delete tmpItemList[i].vout;
    }
    return tmpItemList;
}

// Format a number to to 6 decimal places remove any JS-buggy number changes
function formatNum(n) {
    return Number((Number(n)).toFixed(6));
}

// Get an item object from our list by it's hash
function getItem(itemArg, includePending = false, includeUnsigned = false) {
    for (let i=0; i<items.length; i++) {
        if (items[i].tx === itemArg) return items[i];
    }

    // (includePending only)
    // Search for the item in the pending Items DB
    if (includePending) {
        for (let i=0; i<itemsToValidate.length; i++) {
            if (itemsToValidate[i].tx === itemArg) return itemsToValidate[i];
        }
    }

    // (includeUnsigned only)
    // Search for the item in the unsigned Items DB
    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (unsignedItems[i].tx === itemArg) return unsignedItems[i];
        }
    }

    return null;
}

// Gets a list of all items with a specified name
function getItemsByName(itemArg, includePending = false, includeUnsigned = false) {
    let retItems = {
        items: [],
        pendingItems: [],
        unsignedItems: []
    };

    for (let i=0; i<items.length; i++) {
        if (items[i].name.includes(itemArg)) retItems.items.push(items[i]);
    }

    // (includePending only)
    // Search for the item in the pending Items DB
    if (includePending) {
        for (let i=0; i<itemsToValidate.length; i++) {
            if (itemsToValidate[i].name.includes(itemArg)) retItems.pendingItems.push(itemsToValidate[i]);
        }
    }

    // (includeUnsigned only)
    // Search for the item in the unsigned Items DB
    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (unsignedItems[i].name.includes(itemArg)) retItems.unsignedItems.push(unsignedItems[i]);
        }
    }

    return retItems;
}

// Updates the contents of an item object
function updateItem (itemArg) {
    for (let i=0; i<items.length; i++) {
        if (items[i].tx === itemArg.tx) {
            items[i] = _.cloneDeep(itemArg);
            return true;
        }
    }
    for (let i=0; i<itemsToValidate.length; i++) {
        if (itemsToValidate[i].tx === itemArg.tx) {
            itemsToValidate[i] = _.cloneDeep(itemArg);
            return true;
        }
    }
    return false;
}

// Returns true if the given item is a ZENZO Forge profile
function isProfile(nItem) {
    const standard = script.getStandards().ZFI_1;
    if (!nItem.contracts || !nItem.contracts.validation) return false;
    // Ensure this item conforms to the ZFI-1 standard;
    if (!script.conformsToStandard(nItem.contracts.validation, standard)) return false;
    // Contract is valid, ensure profile name matches contract input;
    if (nItem.name !== util.recoverContractString(nItem.contracts.validation, 0)) return false;
    // This is a valid ZFI-1 Profile!
    return true;
}

// Gets an array of all ZFI-1 profiles on the network
function getAllProfiles(includePending = false) {
    let profiles = [], i, a, len = items.length, aLen = itemsToValidate.length;
    for (i=0; i<len; i++) {
        let nItem = items[i];
        if (!isProfile(nItem)) continue;
        profiles.push(nItem);
    }
    if (includePending) {
        for (a=0; a<aLen; a++) {
            let nItem = items[a];
            if (!isProfile(nItem)) continue;
            profiles.push(nItem);
        }
    }
    return profiles;
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

// Cleanse the IP of unimportant stuff
function cleanIP(ip) {
    return ip.replace(/::ffff:/g, "");
}

// Sends item(s) to every connected peer
function sendItemsToNetwork (itemsToSend) {
    peers.forEach(peer => {
        peer.sendItems(itemsToSend);
    });
}

class Peer {
    constructor(host, protocol) {
        this.host = "http://" + host; // The host (http URL) of the peer
        this.protocol = params.parse(protocol); // The protocol of the peer
        this.lastPing = 0; // The timestamp of the last succesful ping to this peer
        this.index = ((peers.length != 0) ? peers[peers.length - 1].index + 1 : 0); // The order in which we connected to this peer
        this.stale = false; // A peer is stale if they do not respond to our requests
        this.sendOnly = false; // A peer is sendOnly if we cannot communicate to them, but they can reach us
    }

    isStale() {
        return this.stale;
    }

    setStale(bool) {
        this.stale = bool;
    }

    isSendOnly() {
        return this.sendOnly;
    }

    setSendOnly(bool) {
        this.sendOnly = bool;
    }

    connect(shouldPing) {
        if (safeMode) return;
        if (getPeer(this.host) === null) {
            if (!shouldPing) {
                if (params.hasConsensus(this.protocol)) {
                    peers.push(this);
                    return console.info(`Peer "${this.host}" (${this.index}) appended to peers list!`);
                }
            } else {
                return superagent
                    .post(this.host + "/ping")
                    .send({protocol: params.protocolVersion}) // Send peer our protocol
                    .then((res) => {
                        // Peer responded, check protocol validity
                        if (!params.isValidProtocol(res.text)) {
                            if (debug("net")) console.warn("Peer " + this.host + " has an invalid protocol, cancelling connection...");
                            return;
                        }
                        // Check the peer's protocol is within consensus of ours
                        let pver = params.parse(res.text);
                        if (!params.hasConsensus(pver)) {
                            if (debug("net")) console.warn("Peer " + this.host + " doesn't meet local protocol consensus, cancelling connection...");
                            return;
                        }
                        
                        // Protocol is valid and has met consensus, finish the connection!
                        this.lastPing = Date.now();
                        this.setStale(false);
                        peers.push(this);
                        console.info(`Peer "${this.host}" (${this.index}) responded to ping, appended to peers list!\n- Starting item Sync with peer.`);
                        this.exchangeItems();
                    })
                    .catch((err) => {
                        if (getPeer(this.index) === null) {
                            // Non-handshaked peer didn't respond, don't add to peers list
                            this.setStale(true);
                        } else {
                            // Handshaked peer didn't respond
                            if (this.lastPing + 60000 < Date.now()) {
                                // No successful pings in over 60 seconds, assume peer is offline and disconnect
                                disconnectPeer(this.host);
                            } else if (!this.isSendOnly() && canReceiveData) {
                                // Peer has pinged us in the past 60 seconds, assume peer is sendOnly   
                                this.setSendOnly(true);
                                if (debug("net")) console.info("Peer \"" + this.host + "\" (" + this.index + ") cannot be reached, but has pinged us recently, assuming sendOnly");
                            }
                        }
                        // Don't spam ping handshake errors if they're send-only
                        if (!this.isSendOnly()) console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
                    });
            }
        }
    }

    send(sentData, name = "Unknown Request") {
        if (this.isSendOnly())
            return false;

        return superagent
        .post(this.host + "/message/receive")
        .send(sentData)
        .then((res) => {
            if (debug("net")) console.info(`Successfully sent message "${name}" to peer "${this.host}"`);
        })
        .catch((err) => {
            if (debug("net")) console.warn(`Unable to send "${name}" message to peer "${this.host}" --> ${err.message}`);
        });
    }

    ping() {
        return superagent
            .post(this.host + "/ping")
            .send({protocol: params.protocolVersion}) // Send peer our protocol
            .then((res) => {
                this.lastPing = Date.now();
                this.setStale(false);
                if (debug("net")) console.info(`Peer "${this.host}" (${this.index}) responded to ping.`);
            })
            .catch((err) => {
                if (getPeer(this.index) === null) {
                    // Non-handshaked peer didn't respond, don't add to peers list
                    this.setStale(true);
                } else {
                    // Handshaked peer didn't respond
                    if (this.lastPing + 60000 < Date.now()) {
                        // No successful pings in over 60 seconds, assume peer is offline and disconnect
                        disconnectPeer(this.host);
                    } else if (!this.isSendOnly() && canReceiveData) {
                        // Peer has pinged us in the past 60 seconds, assume peer is sendOnly   
                        this.setSendOnly(true);
                        if (debug("net")) console.info("Peer \"" + this.host + "\" (" + this.index + ") cannot be reached, but has pinged us recently, assuming sendOnly");
                    }
                }
                // If the peer is send-only, allow pings to fail silently to prevent spamming the net logs
                if (!this.isSendOnly() && debug("net")) console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
            });
    }

    sendItems(itemsToSend = null) {
        if (this.isSendOnly())
            return false;

        if (_.isNil(itemsToSend)) {
            itemsToSend = {
                items: cleanItems(items),
                pendingItems: cleanItems(itemsToValidate),
                unsignedItems: cleanItems(unsignedItems),
                smeltedItems: itemsSmelted
            }
        } else {
            itemsToSend = {
                items: cleanItems(itemsToSend),
                pendingItems: [],
                unsignedItems: [],
                smeltedItems: []
            }
        }

        return superagent
            .post(this.host + "/forge/receive")
            .send(itemsToSend)
            .then((res) => {
                this.lastPing = Date.now();
                this.setStale(false);
                if (debug("net")) console.info(`Peer "${this.host}" (${this.index}) responded to items with "${res.text}".`);
            })
            .catch((err) => {
                // Peer didn't respond, mark as stale
                this.setStale(true);
                if (debug("net")) console.warn(`Unable to send items to peer "${this.host}" --> ${err.message}`);
            });
    }

    exchangeItems() {
        if (this.isSendOnly())
            return false;

        // Compute our inventory hashes, send to the peer, wait for their hashes, then exchange items
        getItemHashes(true, true).then(itemHashes => {
            return superagent
            .post(this.host + "/forge/sync/hashes")
            .send(itemHashes)
            .then((res) => {
                if (safeMode) return;
                this.lastPing = Date.now();
                this.setStale(false);

                // Peer sent items; validate itemsSent and return hashesWanted in a new request
                let data = JSON.parse(res.text);

                // itemsSent validation
                if (debug("net")) console.info(`Peer "${this.host}" (${this.index}) sent (${data.itemsSent.length} Items)`);
                // (tmp, needs optimizing) smelts are included in the hashes for now
                validateSmelts(data.smeltedItems);
                validateItemBatch(null, cleanItems(data.itemsSent), false).then(done => {
                    if (done) {
                        // Only display net + validations stats IF anything actually changed
                        if ((done.accepted + done.ignored + done.rejected) > 0) {
                            if (debug("net")) console.info(`Synced with peer "${this.host}", we now have ${items.length} valid, ${itemsToValidate.length} pending items & ${unsignedItems.length} unsigned items!`);
                            if (debug("net") || debug("validations")) console.info("Validated item results from peer\n - Accepted: " + done.accepted + "\n - Ignored: " + done.ignored + "\n - Rejected: " + done.rejected);
                        }
                    } else if (debug("net")) console.warn(`Failed to sync with peer "${this.host}"`);
                });

                // itemsWanted request
                if (data.hashesWanted.length > 0) {
                    let itemsToSend = [];
                    data.hashesWanted.forEach(nHash => {
                        let foundHash = _.find(itemHashes, {'hash': nHash});
                        if (foundHash) {
                            itemsToSend.push(getItem(foundHash.tx));
                            console.error("Peer " + this.host + " is missing our item, sending...: " + foundHash.tx);
                        }
                    });
                    if (itemsToSend.length > 0) {
                        this.sendItems(itemsToSend).then(done => {
                            if (debug("net")) console.info("Sent peer \"" + this.host + "\" " + itemsToSend.length + " requested items!");
                        });
                    }
                }
            })
            .catch((err) => {
                if (debug("net")) console.warn(`Unable to get items from peer "${this.host}" --> ${err.message}`);
            });
        });
    }
}

class ReceivedMessage {
    constructor(host, content, res) {
        this.from = getPeer(host); // The host (Peer class) of the sender
        this.content = content; // The content of the message (Could be plaintext or JSON)
        this.res = res; // The raw express response obj
    }

    reply(sentContent) {
        this.from.send(sentContent);
    }
}

// Attempt to connect to hardcoded seednodes
function connectSeednodes() {
    for (let i=0; i<seednodes.length; i++) {
        // Assume seednodes use the same protocol as us
        let seednode = new Peer(seednodes[i], params.protocolVersion);
        seednode.connect(true);
    }
}

/* Express Endpoints */
// Ping
// An easy way to check if a node is responsive and meets protocol consensus
app.post('/ping', (req, res) => {
    if (safeMode) return
    let ip = cleanIP(req.ip);

    // We don't want to connect to ourselves
    if (ip !== "127.0.0.1") {
        req.peer = getPeer("http://" + ip);
        if (req.peer !== null) {
            req.peer = getPeer("http://" + ip);
            req.peer.setStale(false);
            req.peer.lastPing = Date.now();
            updatePeer(req.peer);
        } else {
            if (params.isValidProtocol(req.body.protocol)) {
                req.peer = new Peer(ip, req.body.protocol);
                req.peer.lastPing = Date.now();
                req.peer.connect(false);
            } else {
                res.json({error: "Incompatible node handshake"});
                return;
            }
        }
        if (req.body && req.body.protocol && debug("net")) {
            canReceiveData = true;
        }
    }

    res.send(params.protocolVersion);
});

// Forge Receive
// Allows peers to send us their Forge item data
app.post('/forge/receive', (req, res) => {
    let ip = cleanIP(req.ip);
    req.peer = getPeer("http://" + ip);
    if (req.peer === null) {
        res.send({error: "Handshake needed before making consensus-reliant requests."})
        if (debug("net")) console.warn("Peer " + ip + " tried to send us items without a handshake connection, ignoring...");
        return;
    }


    let nItems = req.body;
    let nSmelts = req.body.smeltedItems;

    validateSmelts(nSmelts);

    validateItemBatch(res, cleanItems(nItems.items.concat(nItems.pendingItems, nItems.unsignedItems)), true).then(done => {
        if (debug("net") || debug("validations")) {
            console.log('Forge: Validated item batch from "' + ip + '"');
            console.info("Validated item results from peer\n - Accepted: " + done.accepted + "\n - Ignored: " + done.ignored + "\n - Rejected: " + done.rejected);
            canReceiveData = true;
        }
    });
});

// Forge Sync
// Allows peers to sync with our database
app.post('/forge/sync', (req, res) => {
    let ip = cleanIP(req.ip);
    req.peer = getPeer("http://" + ip);
    if (req.peer === null) {
        res.send({error: "Handshake needed before making consensus-reliant requests."})
        if (debug("net")) console.warn("Peer " + ip + " tried to send us items without a handshake connection, ignoring...");
        return;
    }

    // Check if they have a different amount of items to us, if so, ask for them
    if (Number(req.body.len) != (items.length + itemsToValidate.length + unsignedItems.length)) {
        req.peer = getPeer("http://" + ip);
        canReceiveData = true;
        if (req.peer !== null)
            req.peer.exchangeItems();
    }

    validateSmelts(req.body.smeltedItems);

    let obj = {items: items, pendingItems: itemsToValidate, unsignedItems: unsignedItems, smeltedItems: itemsSmelted};
    res.send(JSON.stringify(obj));
});

// Forge Sync Hashes
// Allows peers to sync hashes to determine the item differences
app.post('/forge/sync/hashes', (req, res) => {
    let ip = cleanIP(req.ip);
    req.peer = getPeer("http://" + ip);
    canReceiveData = true;
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
                let peersMissingItem = getItem(nHash.tx, true, true);
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

        itemsToSend = cleanItems(itemsToSend);

        res.send(JSON.stringify({itemsSent: itemsToSend, hashesWanted: hashesWeWant, smeltedItems: itemsSmelted}));
    });
});

// Forge Inventory
// An endpoint that allows peers to see our personal inventory. Item owned and/or created by us.
app.post('/forge/inventory', (req, res) => {
    let ourItems = [];
    let ourPendingItems = [];

    // Find our validated items
    for (let i=0; i<items.length; i++) {
        if (items[i].address === addy) ourItems.push(items[i]);
    }

    // Find our pending items (Mempool items, these can be optionally included in fast-paced games)
    for (let i=0; i<itemsToValidate.length; i++) {
        if (itemsToValidate[i].address === addy) ourPendingItems.push(itemsToValidate[i]);
    }

    let obj = {items: ourItems, pendingItems: ourPendingItems};
    res.send(JSON.stringify(obj));
});

// Forge Profiles
// An endpoint that returns all known user profiles
app.post('/forge/profiles', (req, res) => {
    res.send(JSON.stringify(getAllProfiles(true)));
});

// Forge Profile
// An endpoint that returns a profile by it's name or address
app.post('/forge/profile', (req, res) => {
    if (req.body.name && req.body.name.length >= 1) {
        res.send(JSON.stringify(getProfile(req.body.name, true)));
    }
});


/* LOCAL-ONLY ENDPOINTS (Cannot be used by peers, only us)*/

// Forge Account
// The endpoint for getting the general information of a user
app.post('/forge/account', (req, res) => {
    if (peers.length === 0 || safeMode) return res.json({error: "Account information is unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    zenzo.call("getinfo").then(info => {
        let obj = {forge_address: addy, balance: info.balance, wallet_version: info.version};
        res.json(obj);
    })
});

// Forge Create
// The endpoint for crafting new items, backed by ZNZ and validated by the ZENZO Core protocol
app.post('/forge/create', (req, res) => {
    if (peers.length === 0 || safeMode) return res.json({error: "Crafting is unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = cleanIP(req.ip);
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
    if (!_.isNil(req.body.metadata)) {
        try {
            metadataBytes = JSON.stringify(req.body.metadata).length;
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
            let nItem = {
                tx: txid,
                sig: sig,
                address: addy,
                name: req.body.name,
                image: req.body.image,
                value: req.body.amount,
                metadata: req.body.metadata,
                contracts: req.body.contracts
            }
            if (_.isNil(nItem.metadata) || _.isEmpty(nItem.metadata)) {
                // To save a little bit of space, metadata can be completely deleted if empty
                delete nItem.metadata;
            }
            console.log("Forge: Item Created!\n- TX: " + nItem.tx + "\n- Signature: " + nItem.sig + "\n- Name: " + nItem.name + "\n- Image: " + nItem.image + "\n- Value: " + nItem.value + " ZNZ\n- Metadata: " + metadataBytes + " bytes\n- Contracts: " + contractBytes + " bytes");
            items.push(nItem);
            sendItemsToNetwork([nItem]);
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
    if (peers.length === 0 || safeMode) return res.json({error: "Transfers are unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    // Check we have all needed parameters
    if (req.body.item.length !== 64) return console.warn("Forge: Invalid item parameter.");
    if (req.body.to.length !== 34) return console.warn("Forge: Invalid to parameter.");

    // Get the item
    let tItem = getItem(req.body.item);

    findMatchingVouts(tItem).then(vouts => {
        // Create a transaction
        //zenzo.call("gettxout", tItem.tx, tItem.vout).then(rawPrevTx => {
            // Sign the transaction hash
            let receiverJson = "{\"" + req.body.to + "\":" + (tItem.value - 0.001).toFixed(4) + "}"
            let VoutJson = "[{\"txid\":\"" + tItem.tx + "\",\"vout\":" + vouts[0] + "}]"
            console.log("Receiver: " + receiverJson);
            console.log("VoutJson: " + VoutJson);
            zenzo.call("createrawtransaction", JSON.parse(VoutJson), JSON.parse(receiverJson)).then(rawTx => {
                zenzo.call("signrawtransaction", rawTx).then(signedTx => {
                    zenzo.call("sendrawtransaction", signedTx.hex).then(txid => {
                        //zenzo.call("signmessage", addy, txid).then(sig => {
                            let nItem = {
                                tx: txid,
                                prev: [
                                    {
                                        tx: tItem.tx,
                                        vout: vouts[0],
                                        address: addy,
                                        spend_timestamp: Date.now(),
                                        transfer_fee: 0.001
                                    }
                                ],
                                //sig: sig,
                                address: req.body.to,
                                name: tItem.name,
                                image: tItem.image,
                                value: formatNum(tItem.value - 0.001),
                                contracts: tItem.contracts
                            }
                            if (tItem.metadata && !_.isNil(tItem.metadata)) {
                                // Add metadata to the transferred item if the old one had any
                                nItem.metadata = tItem.metadata;
                            }
                            console.log("Forge: Item Transferred!\n- TX: " + nItem.tx + /*"\n- Signature: " + nItem.sig +*/ "\n- Name: " + nItem.name + "\n- Value: " + nItem.value + " ZNZ\n- Status: Awaiting item signature from receiver");
                            unsignedItems.push(nItem);
                            sendItemsToNetwork([nItem]);
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
                console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'createrawtransaction " + JSON.stringify([{"txid":tItem.tx,"vout":tItem.vout}]) + " " + receiverJson + "' failed");
                console.error(tItem.vout);
                res.json({error: "Craft failure: ZENZO-RPC hangup"});
            });
        //}).catch(function(){
        //    console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'gettxout " + tItem.tx + " " + tItem.vout + "' failed");
        //    res.json({error: "Craft failure: ZENZO-RPC hangup"});
        //});
    });
});

// Forge Smelt
// The endpoint for smelting (destroying) items and converting them back into their native ZNZ value.
app.post('/forge/smelt', (req, res) => {
    if (peers.length === 0 || safeMode) return res.json({error: "Smelting is unavailable while the Forge is in Safe Mode and/or Offline."});
    let ip = cleanIP(req.ip);
    if (!isAuthed(req)) return console.warn("Forge: A non-authorized Forge was made by '" + ip + "', ignoring.");

    if (req.body.hash.length !== 64) return console.warn("Forge: Invalid TX-hash.");

    const smeltingItem = getItem(req.body.hash, true);
    if (smeltingItem === null) return res.json({error: "Smelting Item could not be found via it's TX hash."});

    console.info("Preparing to smelt " + smeltingItem.name + "...");
    zenzo.call("gettransaction", smeltingItem.tx).then(rawtx => {
        zenzo.call("lockunspent", true, [{"txid": smeltingItem.tx, "vout": rawtx.details[0].vout}]).then(didUnlock => {
            if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
            zenzo.call("signmessage", addy, "smelt_" + smeltingItem.tx).then(sig => {
                smeltItem({tx: smeltingItem.tx, address: addy}, sig);
                res.json({message: "Item smelted, collateral unlocked and peers are being notified."});
                // Remove smelted item from our locked list
                for (let i=0; i<lockedItems.length; i++) {
                    if (lockedItems[i].tx === smeltingItem.tx) {
                        lockedItems.splice(i, 1);
                    }
                }
            }).catch(console.error);
        }).catch(console.error);
    }).catch(console.error);
});

// Forge Items
// The endpoint for getting a list of validated and pending items
app.post('/forge/items', (req, res) => {
    items.sort(function(a, b){return b.timestamp-a.timestamp});
    itemsToValidate.sort(function(a, b){return b.timestamp-a.timestamp});
    unsignedItems.sort(function(a, b){return b.timestamp-a.timestamp});
    let obj = {items: items, pendingItems: itemsToValidate, unsignedItems: unsignedItems};
    res.json(obj);
});


// P2P Messaging System
// This endpoint is used to transfer standardized messages (data packets) between nodes effectively

// Every 750ms, check for (and process) messages in the queue
let messageProcessor = setInterval(function() {
    if (messageQueue.length === 0) return; // No messages to read!

    // We've got mail! Open it up and find out it's intention
    console.info("Processing message...");
    if (messageQueue[0].content.header === "test") {
        console.info("- Message test worked, yay!");
        messageQueue[0].res.send("Hi! :3");
        messageQueue.shift();
    }

    /* A peer wants to smelt an item */
    else if (messageQueue[0].content.header === "smelt") {
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
        zenzo.call("verifymessage", smeltedItem.address, messageQueue[0].content.sig, "smelt_" + smeltedItem.tx).then(isGenuine => {
            if (isGenuine) {
                console.info("- Signature verified! Message is genuine, performing smelt...");
                messageQueue[0].res.json({message: "Smelt confirmed"});

                // Begin the local smelt process for the item
                smeltItem({tx: smeltedItem.tx, address: smeltItem.address}, messageQueue[0].content.sig).then(smelted => {
                    console.info("- Item (" + smeltedItem.name + ") smelted successfully!");
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
        return disconnectPeer(messageQueue[0].from.host);
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
        let recvMsg = new ReceivedMessage("http://" + cleanIP(req.ip), msg, res);
        messageQueue.push(recvMsg);
        canReceiveData = true;
        console.info("Message received from " + cleanIP(req.ip) + " successfully, appended to queue.");
    } catch (err) {
        if (debug("net")) console.error("Message sent by " + cleanIP(req.ip) + " is not JSON, ignoring.");
    }
});

/* ------------------ Core Forge Operations ------------------ */

// Smelt an item, permanently excluding it from the Forge and allowing the collateral to be safely spent
async function smeltItem (item, signature = null) {
    if (peers.length === 0 || safeMode) return;

    // If we own this item, unlock the collateral
    const thisItem = getItem(item.tx, true);
    if (!_.isNil(thisItem) && addy === thisItem.address) {
        try {
            let rawtx = await zenzo.call("gettransaction", thisItem.tx);
            let didUnlock = await zenzo.call("lockunspent", true, [{"txid": thisItem.tx, "vout": rawtx.details[0].vout}]);
            if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
        } catch (e) {
            console.error("- Unable to unlock smelted item collateral (" + thisItem.name + ", " + thisItem.tx + ")");
        }
    }


    console.info("- Broadcasting smelt request to " + peers.length + " peer" + ((peers.length === 1) ? "" : "s"));
    asyncForEach(peers, async (peer) => {
        if (!peer.isSendOnly()) {
            await superagent
            .post(peer.host + "/message/receive")
            .send({
                header: "smelt",
                item: item.tx,
                sig: signature
            })
            .then((res) => {
                peer.lastPing = Date.now();
                peer.setStale(false);
                if (debug("net")) console.info(`- Peer "${peer.host}" (${peer.index}) responded to smelt with "${res.text}".`);
            })
            .catch((err) => {
                // Peer didn't respond, mark as stale
                peer.setStale(true);
                if (debug("net")) console.warn(`- Unable to broadcast smelt to peer "${peer.host}" --> ${err.message}`);
            });
        }
    });

    // Add the item TX to the smelted DB
    itemsSmelted.push({tx: item.tx, address: item.address, sig: signature});
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
            if (!_.find(lockedItems, {'tx': lItem.tx}) && lItem.address === addy) {
                let rawtx = await zenzo.call("gettransaction", lItem.tx);
                let didLock = await zenzo.call("lockunspent", false, [{"txid": lItem.tx, "vout": rawtx.details[0].vout}]);
                if (didLock) {
                    if (debug("me")) console.info("- Item (" + lItem.name + ") collateral was successfully locked in ZENZO Coin Control.");
                    lockedItems.push({name: lItem.name, tx: lItem.tx, vout: rawtx.details[0].vout});
                }
            }
        } catch (e) {
            // Assume the UTXO was locked by a previous run of the Forge (or the QT locked it via forge.conf file)
            if (!_.find(lockedItems, {'tx': lItem.tx}) && lItem.address === addy) {
                let rawtx = await zenzo.call("gettransaction", lItem.tx);
                if (debug("me")) console.info("- Item (" + lItem.name + ") collateral was successfully locked in ZENZO Coin Control.");
                lockedItems.push({name: lItem.name, tx: lItem.tx, vout: rawtx.details[0].vout});
            }
        };
    });

    // Write to ZENZO Core's forge config to allow for persistent locks
    if (lockedItems.length > 0) {
        let nConfigZC = "";
        for (let i=0; i<lockedItems.length; i++) {
            nConfigZC += "\r\n" + lockedItems[i].name.replace(/ /g, "_") + " " + lockedItems[i].tx + " " + lockedItems[i].vout;
        }
        await database.toDiskZC("forge.conf", nConfigZC, false);
    }
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
        let nTx = await zenzo.call("gettxout", item.tx, vout);
        if (nTx !== null) {
            if (nTx.value === item.value && nTx.scriptPubKey.addresses[0] === item.address) matchingVouts.push(vout);
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
        database.fromDisk("items.json", true).then(nDiskItems => {
            if (nDiskItems === null)
                console.warn("Init: file 'items.json' missing from disk, ignoring...");
            else
                items = nDiskItems;

            database.fromDisk("smelted_items.json", true).then(nDiskSmeltedItems => {
                if (nDiskSmeltedItems === null)
                    console.warn("Init: file 'smelted_items.json' missing from disk, ignoring...");
                else
                    itemsSmelted = nDiskSmeltedItems;

                if (itemsSmelted[0] && typeof itemsSmelted[0] === "string") {
                    // DB uses the old smelt format, wipe smelts from memory + disk to avoid conflicts
                    while (itemsSmelted.length) itemsSmelted.pop();
                    database.toDisk("smelted_items.json", "[]", false).then(smeltWritten => {
                        console.log("Smelt database wiped!");
                    });
                }

                if (itemsSmelted.length > 1) {
                    // Check for the 'missing addy' bugged items and remove them
                    for (let i=0; i<itemsSmelted.length; i++) {
                        if (!itemsSmelted[i].address) {
                            itemsSmelted.splice(i, 1);
                        }
                    }
                }

                database.fromDisk("pending_items.json", true).then(nDiskPendingItems => {
                    if (nDiskPendingItems === null)
                        console.warn("Init: file 'pending_items.json' missing from disk, ignoring...");
                    else
                        itemsToValidate = nDiskPendingItems;

                    database.fromDisk("unsigned_items.json", true).then(nDiskUnsignedItems => {
                        if (nDiskUnsignedItems === null)
                            console.warn("Init: file 'unsigned_items.json' missing from disk, ignoring...");
                        else
                            unsignedItems = nDiskUnsignedItems;
            
                        console.info("Init: loaded from disk:\n- Items: " + items.length + "\n- Pending Items: " + itemsToValidate.length + "\n- Smelted Items: " + itemsSmelted.length + "\n- Unsigned Items: " + unsignedItems.length);

                        // Remove unnecessary data from items in memory
                        for (let i = 0; i < items.length; i++) {
                            if (items[i].hash) {
                                delete items[i].hash;
                            }
                        }
                        for (let i = 0; i < itemsToValidate.length; i++) {
                            if (itemsToValidate[i].hash) {
                                delete itemsToValidate[i].hash;
                            }
                        }
                        for (let i = 0; i < unsignedItems.length; i++) {
                            if (unsignedItems[i].hash) {
                                delete unsignedItems[i].hash;
                            }
                        }

                        // Initialize Game Manager
                        games_manager.init().then(done => {});
                    });
                });
            });
        });
    }
}

loadData();

// Start the "janitor" loop to ping peers, validate items and save to disk at intervals
let janitor = setInterval(function() {
    // We have no connected peers, so let's keep attempting to connect to seednodes
    if (peers.length === 0 && !safeMode && isForgeRunning) {
        connectSeednodes();
    }

    // No peers, safemode or not running. Cannot perform core operations yet
    if (peers.length === 0 || safeMode || !isForgeRunning) return;

    // Ping peers
    peers.forEach(peer => {
        peer.ping();
        peer.exchangeItems();
    });

    // Keep a list of our personal items to broadcast to peers later...
    let ourItems = [];

    // Sign unsigned items that belong to us, and remove unsigned items that have been recently signed
    let hasSignedItem = false;
    if (unsignedItems.length > 0) {
        unsignedItems.forEach(unsignedItem => {
            if (unsignedItem.address === addy) {
                if (debug("me")) console.info("Signing received unsigned item (" + unsignedItem.name + ")...")
                zenzo.call("signmessage", addy, unsignedItem.tx).then(sig => {
                    if (sig && sig.length > 5) {
                        unsignedItem.sig = sig;
                        eraseItem(unsignedItem, true);
                        items.push(unsignedItem);
                        ourItems.push(unsignedItem);
                        hasSignedItem = true;
                        if (debug("me")) console.info(" - Item signed successfully!");
                    } else {
                        if (debug("me")) console.error(" - Signing failed...");
                    }
                });
            }
        });
    }

    // Validate pending items
    if (itemsToValidate.length > 0) {
        _.map(itemsToValidate, function(i) {
            addToValidationQueue(i, true);
            // Save the item for broadcasting if it's related to us
            if (doesItemInvolveMe(i))
                ourItems.push(i);
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
                    if (nOurItem.timestamp && nOurItem.timestamp > 0) {
                        if (nOurItem.timestamp + (15 * 60) > (Date.now() / 1000))
                            ourNewItems.push(nOurItem);
                    }
                });
                if (ourNewItems.length > 0) {
                    // Broadcast our new items
                    console.log("Propagating " + ourNewItems.length + " new node-related items to the network...");
                    sendItemsToNetwork(ourNewItems);
                }
            } else
            if (peers.length >= 2 && !hasDistributedItems) {
                // Broadcast all of our own items to peers, if we have enough of them.
                // We only do this once per-boot for efficiency.
                console.log("Propagating " + ourItems.length + " node-related items to the network...");
                sendItemsToNetwork(ourItems);
                hasDistributedItems = true;
            }
        }

        // Execute the validation queue
        runValidationQueue();
    }

    // Save data to disk
    let newDbEntries = items.length + itemsToValidate.length + itemsSmelted.length + unsignedItems.length;
    let hasDbChanged = (newDbEntries != cachedDbEntries ? true : false);
    cachedDbEntries = newDbEntries;
    database.toDisk("items.json", items, true).then(res => {
        if (hasDbChanged) console.log('Database: Written ' + items.length + ' items to disk.');
        database.toDisk("pending_items.json", itemsToValidate, true).then(res => {
            if (hasDbChanged) console.log('Database: Written ' + itemsToValidate.length + ' pending items to disk.');
            database.toDisk("smelted_items.json", itemsSmelted, true).then(res => {
                if (hasDbChanged) console.log('Database: Written ' + itemsSmelted.length + ' smelted items to disk.');
                database.toDisk("unsigned_items.json", unsignedItems, true).then(res => {
                    if (hasDbChanged) console.log('Database: Written ' + unsignedItems.length + ' unsigned items to disk.');
                });
            });
        });
    });

    // Lock any UTXOs that belong to our unlocked items
    lockCollateralUTXOs().then(locked => {
        if (lockedItems.length != cachedUtxoLocks) {
            cachedUtxoLocks = lockedItems.length;
            if (debug("me")) console.info("Now " + lockedItems.length + " UTXOs locked!");
        }
    });
}, 10000);

// Setup the wallet variables
let addy = null;
let zenzo = null;

let isForgeRunning = false;
let hasDistributedItems = false;

// Catch if the wallet RPC isn't available
function rpcError() {
    peers = [];
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
        let rpcAuth = {
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
            if (addy === null) {
                isInitializing = false;
                return selectOperatorAddress();
            }

            console.info("\n--- Configuration ---\n - Full Node: " + fullNode + "\n - RPC Port: " + rpcAuth.port + "\n - ZENZO Core datadir: " + appdataZC + "\n - Forge Port: " + forgePort + "\n - Forge Address: " + addy + "\n - Debugging Mode(s): " + debugType + "\n - Max Invalidation Score: " + maxInvalidScore + "\n");
            console.log("Connected to ZENZO-RPC successfully!");

            // Incase the zenzod daemon was restarted, re-lock our collateral UTXOs to prevent accidental spends
            lockCollateralUTXOs().then(locked => {
                if (locked) console.info("All collaterals locked successfully!");
                // Start listening for Forge requests
                app.listen(forgePort);

                // Let's bootstrap the validator with seednodes
                connectSeednodes();
                isForgeRunning = true;
                safeMode = false;
            });
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
            user: "user",
            pass: "forgepass",
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
    let nConfigZC = "txindex=1\r\n" +
                    "rpcuser=" + nConfig.wallet.user + "\r\n" +
                    "rpcpassword=" + nConfig.wallet.pass + "\r\n" +
                    "listen=1" + "\r\n" +
                    "server=1";

    await database.toDiskZC("zenzo.conf", nConfigZC, false);
    return true;
}


// Save our AuthKey to disk to allow other applications to access the user's Forge node during private actions
/* This is insecure, and will be revamped in the future to have a permission-based system, instead of private key based */
database.toDisk("auth.key", authToken, false).then(res => {
    console.log('Database: Written AuthKey to disk.');
});