const crypto = require('crypto');
const fs = require('fs');
const superagent = require('superagent');
const express = require('express');
const bodyParser = require('body-parser');
const RPC = require('bitcoin-rpc-promise');
const nanoid = require('nanoid');
const x11 = require('x11-hash-js');
var _ = require('lodash');

let script;
let params;
try {
// GUI
    script = require('./lib/script.js');
    params = require('./lib/params.js');
} catch (e) {
// Terminal
    script = require('./script.js');
    params = require('./params.js');
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

/* ------------------ NETWORK ------------------ */
// The list of all known peers
let peers = [];

// The list of hardcoded, developer-approved seednodes
const seednodes = ["144.91.87.251:8000"];

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

    if (!isInvalid) nItem.value = formatNum(nItem.value);

    // Check if the item was previously smelted
    if (!isInvalid && wasItemSmelted(nItem.tx)) {
        isSmelted = true;
    }

    // Check if we already own the item
    if (!revalidate && !isInvalid && !isSmelted && hasItem(nItem.tx)) {
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
        if (debug("validations")) console.info("Not mutated!");
    } else {
        // Try 2: If new items were added since the clone, loop through the list and splice items in our lockedList.
        // This protects the immutability of the list and prevents race-conditions that accidently drop/lose items.
        let i, len = lockedLen;
        if (debug("validations")) console.warn("Mutated!");
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
    // Hash is fixed (64 bytes)
    if (nItem.hash.length !== 64) {
        console.error("Forge: Received invalid item, hash length is not 64. (Has: " + nItem.hash.length + ")");
        return false;
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
            eraseItem(nItem.tx, true);
            if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' was previously smelted.");
            return false;
        }
        
        // Does the item meet bare-bones content requirements?
        if (!isItemContentValid(nItem)) {
            eraseItem(nItem.tx, true);
            if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' doesn't meet content requirements.");
            return false;
        }

        // Begin deep chain/mempool + signature + hash validation
        if (debug("deepvalidations")) console.info("Validating item: '" + nItem.name + "' from " + nItem.address);
        let rawTx = await zenzo.call("getrawtransaction", nItem.tx, 1);
        if (!rawTx || !rawTx.vout || !rawTx.vout[0]) {
            if (debug("deepvalidations")) console.warn('Forge: Item "' + nItem.name + '" is not in the blockchain.');
            addInvalidationScore(nItem, 2);
            return false;
        }
        for (let i=0; i<rawTx.vout.length; i++) {
            if (rawTx.vout[i].value === nItem.value) {
                if (rawTx.vout[i].scriptPubKey.addresses.includes(nItem.address)) {
                    if (debug("deepvalidations")) console.log("Found pubkey of item...");

                    /* TODO: Move this into it's own function */
                    // Upgrade the item if it has missing parameters
                    if (!nItem.timestamp || nItem.timestamp && nItem.timestamp < 1) {
                        nItem.timestamp = rawTx.blocktime;
                    }
                    if (!nItem.image) {
                        nItem.image = "default";
                    }

                    let isSigGenuine = false;
                    if (nItem.sig)
                        isSigGenuine = await zenzo.call("verifymessage", nItem.address, nItem.sig, nItem.tx);
                    if (isSigGenuine || !isSigGenuine && isUnsigned) {
                        if (debug("deepvalidations") && !isUnsigned) console.info("Sig is genuine...");
                        if (debug("deepvalidations") && isUnsigned) console.info("Item is unsigned but valid...");
                        let itemHash = "";
                        if (!isUnsigned && !nItem.prev) {
                            itemHash = hash(nItem.tx + nItem.sig + nItem.address + nItem.name + nItem.value); // Old, signed format
                            if (debug("deepvalidations")) console.log("Old signed: " + itemHash);
                        }
                        if (isUnsigned && nItem.prev) {
                            itemHash = hash(nItem.tx + JSON.stringify(nItem.prev) + nItem.address + nItem.name + nItem.value); // New, unsigned format
                            if (debug("deepvalidations")) console.log("New unsigned: " + itemHash);
                        }
                        if (!isUnsigned && itemHash === "") {
                            itemHash = hash(nItem.tx + JSON.stringify(nItem.prev) + nItem.sig + nItem.address + nItem.name + nItem.value) // New, signed format
                            if (debug("deepvalidations")) console.log("New signed: " + itemHash);
                        }
                        if (itemHash === nItem.hash) {
                            if (debug("deepvalidations")) console.info("Hash is genuine...");
                            let res = await zenzo.call("gettxout", nItem.tx, 0);
                            let resSecondary = await zenzo.call("gettxout", nItem.tx, 1);

                            // Do we have atleast one UTXO?
                            if (res === null) {
                                res = {value: 0, scriptPubKey: {addresses: [""]}}
                                if (resSecondary === null) {
                                    if (debug("deepvalidations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' has no UTXO");
                                    // Be softer on our own items
                                    if (doesItemInvolveMe(nItem)) {
                                        addInvalidationScore(nItem, 2.5);
                                    } else {
                                        addInvalidationScore(nItem, 5);
                                    }
                                    return false; // UTXO has been spent (Or doesn't yet exist, so we give it a chance to appear in mempool/chain)
                                }
                            } else if (resSecondary === null) {
                                resSecondary = {value: 0, scriptPubKey: {addresses: [""]}}
                            }

                            // Do any of the UTXOs contain matching info?
                            if (res.value === nItem.value || resSecondary.value === nItem.value) {
                                if (res.scriptPubKey.addresses[0] === nItem.address || resSecondary.scriptPubKey.addresses[0] === nItem.address) {
                                    if (debug("deepvalidations")) console.info("Found unspent UTXO collateral...");
                                    if (approve) approveItem(nItem);
                                    return true; // Found unspent collateral UTXO
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

                            if (debug("deepvalidations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' does not have a collateral UTXO");
                            addInvalidationScore(nItem, 5);
                            return false; // Couldn't find unspent collateral UTXO
                        } else {
                            if (debug("deepvalidations")) console.warn("Hash is not genuine..." + JSON.stringify(nItem));
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
        // Ensure we don't already have a copy of the smelt
        if (!wasItemSmelted(smelt.tx)) {
            // Verify the signature and smelt is genuine
            console.info("Verifying smelt for item (" + smelt.tx + ")");
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
    });
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
        eraseItem(itemFromUnsigned.prev[0].tx, true);
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
            eraseItem(item.tx, true);
            items.push(item);
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
        if (item === items[i].hash || item === items[i].tx) {
            items.splice(i, 1);
        }
    }
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item === itemsToValidate[i].hash || item === itemsToValidate[i].tx) {
            itemsToValidate.splice(i, 1);
        }
    }
    for (let i=0; i<validationQueue.list.length; i++) {
        if (item === validationQueue.list[i].hash || item === validationQueue.list[i].tx) {
            validationQueue.list.splice(i, 1);
        }
    }

    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (item === unsignedItems[i].hash || item === unsignedItems[i].tx) {
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
        !_.isNil(item.prev) && item.prev[0].address) return true;
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
        if (items[i].hash === itemArg || items[i].tx === itemArg) return items[i];
    }

    // (includePending only)
    // Search for the item in the pending Items DB
    if (includePending) {
        for (let i=0; i<itemsToValidate.length; i++) {
            if (itemsToValidate[i].hash === itemArg || itemsToValidate[i].tx === itemArg) return itemsToValidate[i];
        }
    }

    // (includeUnsigned only)
    // Search for the item in the unsigned Items DB
    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (unsignedItems[i].hash === itemArg || unsignedItems[i].tx === itemArg) return unsignedItems[i];
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
        if (items[i].hash === itemArg.hash || items[i].tx === itemArg.tx) {
            items[i] = JSON.parse(JSON.stringify(itemArg));
            return true;
        }
    }
    for (let i=0; i<itemsToValidate.length; i++) {
        if (itemsToValidate[i].hash === itemArg.hash || itemsToValidate[i].tx === itemArg.tx) {
            itemsToValidate[i] = JSON.parse(JSON.stringify(itemArg));
            return true;
        }
    }
    return false;
}

// Gets an array of all profiles on the network
function getAllProfiles(includePending = false) {
    let profiles = [];
    for (let i=0; i<items.length; i++) {
        if (items[i].name.startsWith("zenzo.")) {
            profiles.push(items[i]);
        }
    }
    if (includePending) {
        for (let i=0; i<itemsToValidate.length; i++) {
            if (itemsToValidate[i].name.startsWith("zenzo.")) {
                profiles.push(itemsToValidate[i]);
            }
        }
    }
    return profiles;
}

// Gets a single profile by it's username or address
function getProfile(name, includePending = false) {
    let profiles = getAllProfiles(includePending);
    for (let i=0; i<profiles.length; i++) {
        if (profiles[i].name.toLowerCase() === "zenzo." + name.toLowerCase() || profiles[i].address === name) {
            return profiles[i];
        }
    }
    return null;
}

// Hash a string with x11
function hash(txt) {
    return x11.digest(txt);
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
                        this.getItems();
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
                        console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
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
                if (debug("net")) console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
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

    getItems() {
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
                        if (debug("net")) console.info(`Synced with peer "${this.host}", we now have ${items.length} valid, ${itemsToValidate.length} pending items & ${unsignedItems.length} unsigned items!`);
                        if (debug("net") || debug("validations")) console.info("Validated item results from peer\n - Accepted: " + done.accepted + "\n - Ignored: " + done.ignored + "\n - Rejected: " + done.rejected);
                    } else if (debug("net")) console.warn(`Failed to sync with peer "${this.host}"`);
                });

                // itemsWanted request
                let itemsToSend = [];
                data.hashesWanted.forEach(nHash => {
                    itemsToSend.push(getItem(nHash.tx));
                });
                this.sendItems(itemsToSend).then(done => {
                    if (debug("net")) console.info("Sent peer \"" + this.host + "\" " + itemsToSend.length + " requested items!");
                });
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
            console.info('Received ping from "' + ip + '" (Protocol ' + req.body.protocol + ')');
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
            req.peer.getItems();
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
                itemsToSend.push(getItem(nHash.tx));
            }
        });

        // Loop the peer's hashes and try to find a match from our list
        peerHashes.forEach(nHash => {
            if (!_.find(ourHashes, {'hash': nHash.hash})) {
                // No match found, we're missing this item
                hashesWeWant.push(nHash);
            }
        });

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
    if (req.body.amount < 0.01) return console.warn("Forge: Invalid amount parameter.");
    if (req.body.name.length < 1 || req.body.name.length > 50) return console.warn("Forge: Invalid name parameter.");
    if (req.body.image.length < 1) return console.warn("Forge: Invalid image parameter.");

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
                value: req.body.amount
            }
            nItem.hash = hash(nItem.tx + nItem.sig + nItem.address + nItem.name + nItem.value);
            console.log("Forge: Item Created!\n- TX: " + nItem.tx + "\n- Signature: " + nItem.sig + "\n- Name: " + nItem.name + "\n- Image: " + nItem.image + "\n- Value: " + nItem.value + " ZNZ\n- Hash: " + nItem.hash);
            itemsToValidate.push(nItem);
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
                                value: formatNum(tItem.value - 0.001)
                            }
                            nItem.hash = hash(nItem.tx + JSON.stringify(nItem.prev) + /*nItem.sig +*/ nItem.address + nItem.name + nItem.value);
                            console.log("Forge: Item Transferred!\n- TX: " + nItem.tx + /*"\n- Signature: " + nItem.sig +*/ "\n- Name: " + nItem.name + "\n- Value: " + nItem.value + " ZNZ\n- Hash: " + nItem.hash + "\n- Status: Awaiting item signature from receiver");
                            unsignedItems.push(nItem);
                            sendItemsToNetwork([nItem]);
                            eraseItem(tItem.tx);
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
                    }).catch(function(){
                        console.error("--- TRANSFER FAILURE ---\n- ZENZO-RPC 'sendrawtransaction " + signedTx.hex + "' failed");
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
    await toDisk("smelted_items.json", itemsSmelted, true);
    console.info("- Written " + itemsSmelted.length + " smelted items to disk.");

    // Remove the item from our item lists
    eraseItem(item.tx, true);

    return true;
}

/* ------------------ I/O Operations ------------------ */

// Write data to a specified file
async function toDisk (file, data, isJson) {
    if (isJson) data = JSON.stringify(data);
    await fs.writeFileSync(appdata + 'data/' + file, data);
    return true;
}

// Write data to a ZENZO Core file
async function toDiskZC (file, data, isJson) {
    if (isJson) data = JSON.stringify(data);
    await fs.writeFileSync(appdataZC + file, data);
    return true;
}

// Read data from a specified file
async function fromDisk (file, isJson) {
    if (!fs.existsSync(appdata + 'data/' + file)) return null;
    let data = await fs.readFileSync(appdata + 'data/' + file, "utf8");
    if (isJson) data = JSON.parse(data);
    return data;
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
        await toDiskZC("forge.conf", nConfigZC, false);
    }
    return true;
}

function generateForgeAddress() {
    zenzo.call("getnewaddress", "Forge").then(nAddy => {
        setupForge(nAddy).then(done => {
            addy = nAddy;
            console.info("- New address (" + nAddy + ") successfully generated!");
            startForge();
        });
    });
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
        fromDisk("items.json", true).then(nDiskItems => {
            if (nDiskItems === null)
                console.warn("Init: file 'items.json' missing from disk, ignoring...");
            else
                items = nDiskItems;

            fromDisk("smelted_items.json", true).then(nDiskSmeltedItems => {
                if (nDiskSmeltedItems === null)
                    console.warn("Init: file 'smelted_items.json' missing from disk, ignoring...");
                else
                    itemsSmelted = nDiskSmeltedItems;

                if (itemsSmelted[0] && typeof itemsSmelted[0] === "string") {
                    // DB uses the old smelt format, wipe smelts from memory + disk to avoid conflicts
                    while (itemsSmelted.length) itemsSmelted.pop();
                    toDisk("smelted_items.json", "[]", false).then(smeltWritten => {
                        console.log("Smelt database wiped!");
                    });
                }

                fromDisk("pending_items.json", true).then(nDiskPendingItems => {
                    if (nDiskPendingItems === null)
                        console.warn("Init: file 'pending_items.json' missing from disk, ignoring...");
                    else
                        itemsToValidate = nDiskPendingItems;

                    fromDisk("unsigned_items.json", true).then(nDiskUnsignedItems => {
                        if (nDiskUnsignedItems === null)
                            console.warn("Init: file 'unsigned_items.json' missing from disk, ignoring...");
                        else
                            unsignedItems = nDiskUnsignedItems;
            
                        console.info("Init: loaded from disk:\n- Items: " + items.length + "\n- Pending Items: " + itemsToValidate.length + "\n- Smelted Items: " + itemsSmelted.length + "\n- Unsigned Items: " + unsignedItems.length);
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
        peer.getItems(); // Temp, will be optimized later
        peer.sendItems();
    });

    // Sign unsigned items that belong to us, and remove unsigned items that have been recently signed
    if (unsignedItems.length > 0) {
        unsignedItems.forEach(unsignedItem => {
            if (unsignedItem.address === addy) {
                if (debug("me")) console.info("Signing received unsigned item (" + unsignedItem.name + ")...")
                zenzo.call("signmessage", addy, unsignedItem.tx).then(sig => {
                    if (sig) {
                        unsignedItem.sig = sig;
                        let stringItem = unsignedItem.tx + JSON.stringify(unsignedItem.prev) + unsignedItem.sig + unsignedItem.address + unsignedItem.name + unsignedItem.value.toString();
                        try {
                            unsignedItem.hash = hash(stringItem);
                            eraseItem(unsignedItem.tx, true);
                            items.push(unsignedItem);
                            if (debug("me")) console.info(" - Item signed successfully!");
                        } catch (e) {
                            console.error(unsignedItem.name + " Hash error: " + e);
                        }
                    } else {
                        if (debug("me")) console.error(" - Signing failed...");
                    }
                });
            }
        });
    }

    // Validate pending items
    if (itemsToValidate.length > 0) {
        let validated = _.map(itemsToValidate, function(i) {
            addToValidationQueue(i, false);
        });
        if (itemsToValidate.length === validated.length) {
            itemsToValidate = [];
        }
    }

    // Send our validated items to peers
    if (items.length > 0) {
        _.map(items, function(i) {
            // Only revalidate non-essential items every 5 validation rounds
            if (validationQueue.count % 5 === 0 || doesItemInvolveMe(i)) addToValidationQueue(i, true);
        });
        runValidationQueue();
    }

    // Save data to disk
    toDisk("items.json", items, true).then(res => {
        console.log('Database: Written ' + items.length + ' items to disk.');
        toDisk("pending_items.json", itemsToValidate, true).then(res => {
            console.log('Database: Written ' + itemsToValidate.length + ' pending items to disk.');
            toDisk("smelted_items.json", itemsSmelted, true).then(res => {
                console.log('Database: Written ' + itemsSmelted.length + ' smelted items to disk.');
                toDisk("unsigned_items.json", unsignedItems, true).then(res => {
                    console.log('Database: Written ' + unsignedItems.length + ' unsigned items to disk.');
                });
            });
        });
    });

    // Lock any UTXOs that belong to our unlocked items
    lockCollateralUTXOs().then(locked => {
        if (debug("me")) console.info("Now " + lockedItems.length + " UTXOs locked!");
    });
}, 10000);

// Setup the wallet variables
let addy = null;
let zenzo = null;

let isForgeRunning = false;

// Catch if the wallet RPC isn't available
function rpcError() {
    peers = [];
    safeMode = true;
}

// Load variables from disk config
function startForge() {
    fromDisk("config.json", true).then(config => {
        if (!config) {
            console.warn("- config.json is missing, if you're not using the Forge GUI wallet, you'll have to fix this manually.");
            return;
        }
        let rpcAuth = {user: config.wallet.user, pass: config.wallet.pass, port: config.wallet.port};
        if (config.wallet.address !== null) {
            addy = config.wallet.address.replace(/ /g, "");;
        } else {
            console.warn("- Config missing 'address', generating a new address...");
        }
        if (config.wallet.datadir) {
            appdataZC = config.wallet.datadir.replace(/\\/g, '/');
            // Make sure the ending "/" isn't missing
            if (!appdataZC.endsWith("/"))
                appdataZC += "/";
        } else {
            console.warn("- Config missing 'wallet.datadir', defaulting to '" + appdataZC +"'");
        }
        zenzo = new RPC('http://' + rpcAuth.user + ':' + rpcAuth.pass + '@localhost:' + rpcAuth.port);
        if (config.forgeport) {
            forgePort = config.forgeport;
        } else {
            console.info("- Config missing 'forgeport' option, defaulting to '" + forgePort + "'.");
        }
        if (config.maxinvalidscore) {
            maxInvalidScore = config.maxinvalidscore;
        }
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
        
        zenzo.call("ping").then(msg => {
            // If there's no address in the config, generate one and re-run the startForge process again
            if (addy === null) return generateForgeAddress();

            console.info("\n--- Configuration ---\n - RPC Port: " + rpcAuth.port + "\n - ZENZO Core datadir: " + appdataZC + "\n - Forge Port: " + forgePort + "\n - Forge Address: " + addy + "\n - Debugging Mode(s): " + debugType + "\n - Max Invalidation Score: " + maxInvalidScore + "\n");
            console.log("Connected to ZENZO-RPC successfully!");

            // Incase the zenzod daemon was restarted, re-lock our collateral UTXOs to prevent accidental spends
            lockCollateralUTXOs().then(locked => {
                if (locked) console.info("All collaterals locked successfully!");
                // Start listening for Forge requests
                app.listen(forgePort);

                // Let's bootstrap the validator with seednodes
                connectSeednodes();
                isForgeRunning = true;
            });
        }).catch(function(e){
            console.error("Failed to connect to ZENZO-RPC, running Forge in Safe Mode. (" + e + ")");
            rpcError();
        });
    });
}

startForge();

async function setupForge(address) {
    // Create config.json and populate with information
    let nConfig = {
        wallet: {
            datadir: appdataZC,
            user: "user",
            pass: "forgepass",
            port: 26211,
            address: address
        },
        maxinvalidscore: 25,
        debug: debugType.join(",")
    }
    let nConfigZC = "txindex=1\r\n" +
                    "rpcuser=" + nConfig.wallet.user + "\r\n" +
                    "rpcpassword=" + nConfig.wallet.pass + "\r\n" +
                    "listen=1" + "\r\n" +
                    "server=1";

    await toDisk("config.json", nConfig, true);
    await toDiskZC("zenzo.conf", nConfigZC, false);
    return true;
}


// Save our AuthKey to disk to allow other applications to access the user's Forge node during private actions
/* This is insecure, and will be revamped in the future to have a permission-based system, instead of private key based */
toDisk("auth.key", authToken, false).then(res => {
    console.log('Database: Written AuthKey to disk.');
});