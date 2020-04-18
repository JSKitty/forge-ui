const fs = require('fs');
const superagent = require('superagent');
const express = require('express');
const bodyParser = require('body-parser');
const RPC = require('bitcoin-rpc-promise');
const nanoid = require('nanoid');
const x11 = require('x11-hash-js');

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
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : '/var/local');
appdataZC = appdataZC.replace(/\\/g, '/') + '/Zenzo/';

/* ------------------ GLOBAL SETTINGS ------------------ */
// The debugging mode, this allows the user to customize what the forge should log
// Debug types: all, none, validations
let debugType = "none";

// Return if the current debug mode includes the caller's debug type
function debug(type) {
    if (debugType === "all") return true;
    if (debugType === "none") return false;

    if (debugType === "validations" && type === "validations") return true;
    if (debugType === "net" && type === "net") return true;
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

// The list of all known items on the Forge network
let items = [];

// The list of "pending" items, of which require further validations
let itemsToValidate = [];

// The list of "unsigned" items, of which require the receiver's signature
let unsignedItems = [];

// The list of smelted item hashes, this can be checked to ensure that a peer doesn't send us a smelted item, thus accidently accepting it due to being valid
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

// Validates if an item is genuine
async function isItemValid (nItem, isUnsigned, approve = false) {
    try {
        if (debug("validations")) console.info("Validating item: '" + nItem.name + "' from " + nItem.address);
        if (wasItemSmelted(nItem.tx)) {
            eraseItem(nItem.tx);
            if (debug("validations")) console.error("Forge: Item '" + nItem.name + "' was previously smelted.");
            return false;
        }
        let rawTx = await zenzo.call("getrawtransaction", nItem.tx, 1);
        if (!rawTx || !rawTx.vout || !rawTx.vout[0]) {
            if (debug("validations")) console.warn('Forge: Item "' + nItem.name + '" is not in the blockchain.');
            disproveItem(nItem);
            addInvalidationScore(nItem, 2);
            return false;
        }
        for (let i=0; i<rawTx.vout.length; i++) {
            if (rawTx.vout[i].value === nItem.value) {
                if (rawTx.vout[i].scriptPubKey.addresses.includes(nItem.address)) {
                    if (debug("validations")) console.log("Found pubkey of item...");

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
                        if (debug("validations") && !isUnsigned) console.info("Sig is genuine...");
                        if (debug("validations") && isUnsigned) console.info("Item is unsigned but valid...");
                        let itemHash = "";
                        if (!isUnsigned && !nItem.prev) {
                            itemHash = hash(nItem.tx + nItem.sig + nItem.address + nItem.name + nItem.value); // Old, signed format
                            if (debug("validations")) console.log("Old signed: " + itemHash);
                        }
                        if (isUnsigned && nItem.prev) {
                            itemHash = hash(nItem.tx + JSON.stringify(nItem.prev) + nItem.address + nItem.name + nItem.value); // New, unsigned format
                            if (debug("validations")) console.log("New unsigned: " + itemHash);
                        }
                        if (!isUnsigned && itemHash === "") {
                            itemHash = hash(nItem.tx + JSON.stringify(nItem.prev) + nItem.sig + nItem.address + nItem.name + nItem.value) // New, signed format
                            if (debug("validations")) console.log("New signed: " + itemHash);
                        }
                        if (itemHash === nItem.hash) {
                            if (debug("validations")) console.info("Hash is genuine...");
                            let res = await zenzo.call("gettxout", nItem.tx, 0);
                            let resSecondary = await zenzo.call("gettxout", nItem.tx, 1);

                            // Do we have atleast one UTXO?
                            if (res === null) {
                                res = {value: 0, scriptPubKey: {addresses: [""]}}
                                if (resSecondary === null) {
                                    if (debug("validations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' has no UTXO");
                                    disproveItem(nItem);
                                    addInvalidationScore(nItem, 25);
                                    return false; // UTXO has been spent
                                }
                            } else if (resSecondary === null) {
                                resSecondary = {value: 0, scriptPubKey: {addresses: [""]}}
                            }

                            // Do any of the UTXOs contain matching info?
                            if (res.value === nItem.value || resSecondary.value === nItem.value) {
                                if (res.scriptPubKey.addresses[0] === nItem.address || resSecondary.scriptPubKey.addresses[0] === nItem.address) {
                                    if (debug("validations")) console.info("Found unspent UTXO collateral...");
                                    if (approve) approveItem(nItem);
                                    return true; // Found unspent collateral UTXO
                                } else {
                                    if (debug("validations")) console.warn("Item address (" + nItem.address + ") doesn't match it's TX collateral address (" + ((res !== null) ? res : resSecondary).scriptPubKey.addresses[0] + ")");
                                    disproveItem(nItem);
                                    addInvalidationScore(nItem, 12.5);
                                    return false;
                                }
                            } else {
                                if (debug("validations")) console.warn("Item value (" + nItem.value + ") doesn't match it's TX collateral value (" + ((res !== null) ? res : resSecondary).value + ")");
                                disproveItem(nItem);
                                addInvalidationScore(nItem, 25);
                                return false;
                            }

                            if (debug("validations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' does not have a collateral UTXO");
                            disproveItem(nItem);
                            addInvalidationScore(nItem, 5);
                            return false; // Couldn't find unspent collateral UTXO
                        } else {
                            if (debug("validations")) console.warn("Hash is not genuine..." + JSON.stringify(nItem));
                            disproveItem(nItem);
                            addInvalidationScore(nItem, 25);
                            return false;
                        }
                    } else {
                        if (debug("validations")) console.warn("Sig is not genuine..." + JSON.stringify(nItem));
                        disproveItem(nItem);
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

async function validateItems (revalidate = false) {
    let validated = 0;
    await asyncForEach(((revalidate) ? items : itemsToValidate), async (item) => {
        let isUnsigned = true;
        if (item.sig) {
            if (item.sig.length > 1) isUnsigned = false;
        }
        item.value = formatNum(item.value);
        let res = await isItemValid(item, isUnsigned, true);
        if (res) {
            validated++;
        } else {
            for (let i=0; i<items.length; i++) {
                if (items[i].tx === item.tx) {
                    items.splice(i, 1); // Erase invalid item from our list
                    if (debug("validations")) console.warn("Erased bad item! (" + item.name + " - " + item.tx + ")");
                }
            }
        }
    });
    return validated;
}

async function validateItemBatch (res, nItems, reply) {
    await asyncForEach(nItems, async (nItem) => {
        // Check all values are valid
        let isUnsigned = true;
        if (nItem.tx.length !== 64) return console.warn("Forge: Received invalid item, TX length is not 64.");
        if (nItem.sig) isUnsigned = false;
        if (nItem.address.length !== 34) return console.warn("Forge: Received invalid address, length is not 34.");
        if (nItem.name.length < 1) return console.warn("Forge: Received invalid name, length is below 1.");
        if (nItem.value < 0.01) return console.warn("Forge: Received invalid item, value is below minimum.");
        if (nItem.hash.length !== 64) return console.warn("Forge: Received invalid item, hash length is not 64.");

        nItem.value = formatNum(nItem.value);

        // Check if the item was previously smelted
        if (wasItemSmelted(nItem.hash)) {
            if (debug("validations")) console.error("Rejected item (" + nItem.name + ") from peer, item has been smelted");
            if (reply && !res.sentReply) {
                res.send("Invalid item (" + nItem.name + "), marked as smelted.");
                res.sentReply = true;
            }
            return false;
        }

        // Check if the item's contents are genuine
        let valid = await isItemValid(nItem, isUnsigned, true);
        if (!valid) {
            if (debug("validations")) console.error("Forge: Received item is not genuine, ignored.");
            return;
        }
    });
    if (reply && !res.sentReply) res.send("Thanks!");
    return true;
}

// Approve an item as valid, moving it to the main items DB and removing it from the pending list
function approveItem(item) {
    let wasFound = false;
    let itemFromItems = getItem(item.tx, false, false);
    let itemFromPending = getItem(item.tx, true, false);
    let itemFromUnsigned = getItem(item.tx, true, true);
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            wasFound = true;
            items.push(item);
            itemsToValidate.splice(i, 1);
            console.info("An item has been approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
        }
    }
    for (let i=0; i<unsignedItems.length; i++) {
        if (item.tx === unsignedItems[i].tx) {
            if (item.sig && !item.signedByReceiver) {
                if (item.sig.length > 0) {
                    item.signedByReceiver = true;
                    unsignedItems.splice(i, 1);
                    console.info("An unsigned item has been signed by it's owner!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
                    items.push(item);
                }
            }
            wasFound = true;
        }
    }
    // If the item isn't already in the validation list and isn't already approved, add it as a new approved item. Or if unsigned, add to the unsigned list
    if (!wasFound) {
        wasFound = false;
        for (let i=0; i<items.length; i++) {
            if (item.tx === items[i].tx) {
                wasFound = true;
            }
        }
        if (!wasFound && item.sig !== null) {
            items.push(item);
            console.info("An item has been added and approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
        } else if (!item.signedByReceiver && !item.sig && itemFromUnsigned === null) {
            console.info("An unsigned item has been added to the unsigned list!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as an unsigned item.");
            unsignedItems.push(item);
        } else if (itemFromUnsigned !== null && itemFromUnsigned.tx === item.tx) {
            eraseItem(item.tx, true);
            items.push(item);
        }
    }
}

// Disprove an item, moving it out of the main items DB and to the pending list
function disproveItem(item) {
    for (let i=0; i<items.length; i++) {
        if (item.tx === items[i].tx) {
            itemsToValidate.push(items[i]);
            items.splice(i, 1);
            if (debug("validations")) console.info("An item has been disproved!\n - Item '" + item.name + "' (" + item.tx + ") has been removed as a verified item and is now pending.");
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

    if (includeUnsigned) {
        for (let i=0; i<unsignedItems.length; i++) {
            if (item === unsignedItems[i].hash || item === unsignedItems[i].tx) {
                unsignedItems.splice(i, 1);
            }
        }
    }
}

// Check if an item hash or TX was smelted
function wasItemSmelted(item) {
    return itemsSmelted.includes(item);
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
                items.splice(i, 1);
                if (debug("validations")) console.info(" - Item has been abandoned due to exceeding the invalidation score threshold.");
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
                itemsToValidate.splice(i, 1);
                if (debug("validations")) console.info(" - Item has been abandoned due to exceeding the invalidation score threshold.");
            }
        }
    }
}

// Cleans a list of items of their local-node data
function cleanItems (itemList) {
    for (let i=0; i<itemList.length; i++) {
        delete itemList[i].invalidScore;
    }
    return itemList;
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
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// Cleanse the IP of unimportant stuff
function cleanIP(ip) {
    return ip.replace(/::ffff:/g, "");
}

class Peer {
    constructor(host, protocol) {
        this.host = "http://" + host; // The host (http URL) of the peer
        this.protocol = params.parse(protocol); // The protocol of the peer
        this.lastPing = 0; // The timestamp of the last succesful ping to this peer
        this.index = ((peers.length != 0) ? peers[peers.length - 1].index + 1 : 0); // The order in which we connected to this peer
        this.stale = false; // A peer is stale if they do not respond to our requests
    }

    isStale() {
        return this.stale;
    }

    setStale(bool) {
        this.stale = bool;
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
                            // Handshaked peer didn't respond, assume they're offline and disconnect
                            disconnectPeer(this.host);
                        }
                        console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
                    });
            }
        }
    }

    send(sentData, name = "Unknown Request") {
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
                    // Handshaked peer didn't respond, assume they're offline and disconnect
                    disconnectPeer(this.host);
                }
                if (debug("net")) console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
            });
    }

    sendItems() {
        return superagent
            .post(this.host + "/forge/receive")
            .send({items: cleanItems(items), pendingItems: cleanItems(itemsToValidate), unsignedItems: cleanItems(unsignedItems)})
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
        return superagent
            .post(this.host + "/forge/sync")
            .send((items.length + itemsToValidate.length + unsignedItems.length).toString())
            .then((res) => {
                if (safeMode) return;
                // Peer sent items, scan through them and merge lists if necessary
                this.lastPing = Date.now();
                this.setStale(false);
                let data = JSON.parse(res.text);
                if (debug("net")) console.info(`Peer "${this.host}" (${this.index}) sent items (${data.items.length} Items, ${data.pendingItems.length} Pending Items)`);
                validateItemBatch(null, cleanItems(data.items.concat(data.pendingItems, data.unsignedItems)), false).then(done => {
                    if (done) {
                        if (debug("net")) console.info(`Synced with peer "${this.host}", we now have ${items.length} valid, ${itemsToValidate.length} pending items & ${unsignedItems.length} unsigned items!`);
                    } else if (debug("net")) console.warn(`Failed to sync with peer "${this.host}"`);
                });
            })
            .catch((err) => {
                if (debug("net")) console.warn(`Unable to get items from peer "${this.host}" --> ${err.message}`);
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
        if (req.body && req.body.protocol && debug("net"))
            console.info('Received ping from "' + ip + '" (Protocol ' + req.body.protocol + ')');
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

    validateItemBatch(res, cleanItems(nItems.items.concat(nItems.pendingItems, nItems.unsignedItems)), true).then(ress => {
        if (debug("validations")) console.log('Forge: Validated item batch from "' + ip + '"');
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
    if (Number(req.body) != (items.length + itemsToValidate.length + unsignedItems.length)) {
        req.peer = getPeer("http://" + ip);
        if (req.peer !== null)
            req.peer.getItems();
    }

    let obj = {items: items, pendingItems: itemsToValidate, unsignedItems: unsignedItems};
    res.send(JSON.stringify(obj));
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
    if (req.body.name.length < 1) return console.warn("Forge: Invalid name parameter.");
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
                                signedByReceiver: false,
                                address: req.body.to,
                                name: tItem.name,
                                image: tItem.image,
                                value: formatNum(tItem.value - 0.001)
                            }
                            nItem.hash = hash(nItem.tx + JSON.stringify(nItem.prev) + /*nItem.sig +*/ nItem.address + nItem.name + nItem.value);
                            console.log("Forge: Item Transferred!\n- TX: " + nItem.tx + /*"\n- Signature: " + nItem.sig +*/ "\n- Name: " + nItem.name + "\n- Value: " + nItem.value + " ZNZ\n- Hash: " + nItem.hash + "\n- Status: Awaiting item signature from receiver");
                            unsignedItems.push(nItem);
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

    if (req.body.hash.length !== 64) return console.warn("Forge: Invalid item-hash or TX-hash.");

    const smeltingItem = getItem(req.body.hash, true);
    if (smeltingItem === null) return res.json({error: "Smelting Item could not be found via it's item hash nor TX hash."});

    console.info("Preparing to smelt " + smeltingItem.name + "...");
    zenzo.call("gettransaction", smeltingItem.tx).then(rawtx => {
        zenzo.call("lockunspent", true, [{"txid": smeltingItem.tx, "vout": rawtx.details[0].vout}]).then(didUnlock => {
            if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
            zenzo.call("signmessage", addy, "smelt_" + smeltingItem.tx).then(sig => {
                smeltItem(smeltingItem.hash, sig);
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

// Every 25ms, check for (and process) messages in the queue
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
            console.error("- Item hash missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item hash"});
            return messageQueue.shift();
        }
        if (!messageQueue[0].content.sig) {
            console.error("- Item signature missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item smelt signature"});
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
                smeltItem(smeltedItem.hash, messageQueue[0].content.sig).then(smelted => {
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
}, 25);

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
    const thisItem = getItem(item, true);
    if (addy === thisItem.address) {
        zenzo.call("gettransaction", thisItem.tx).then(rawtx => {
            zenzo.call("lockunspent", true, [{"txid": thisItem.tx, "vout": rawtx.details[0].vout}]).then(didUnlock => {
                if (didUnlock) console.info("- Item collateral was successfully unlocked in ZENZO Coin Control.");
            }).catch(console.error);
        }).catch(console.error);
    }

    // If a signature was provided, broadcast the smelt to our peers
    if (signature !== null) {
        console.info("- Broadcasting smelt request to " + peers.length + " peer" + ((peers.length === 1) ? "" : "s"));
        asyncForEach(peers, async (peer) => {
            await superagent
            .post(peer.host + "/message/receive")
            .send({
                header: "smelt",
                item: item,
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
        });
    }

    // Add the item hash to the smelted DB
    itemsSmelted.push(item);
    await toDisk("smelted_items.json", itemsSmelted, true);
    console.info("- Written " + itemsSmelted.length + " smelted items to disk.");

    // Remove the item from our item lists
    eraseItem(item);

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
    console.info("--- (Re)Locking all item collaterals ---");
    await asyncForEach(items, async (lItem) => {
        zenzo.call("gettransaction", lItem.tx).then(rawtx => {
            zenzo.call("lockunspent", false, [{"txid": lItem.tx, "vout": rawtx.details[0].vout}]).then(didLock => {
                if (didLock) console.info("- Item collateral was successfully locked in ZENZO Coin Control.");
            }).catch(function(){});
        }).catch(function(){});
    });
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
            console.info("nTx: " + nTx);
            console.info("item: " + item);
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
    // Only perform these when we've got atleast one peer and the RPC is present, otherwise we're potentially offline, or validating stale data
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
                if (debug("validations")) console.info("Signing received unsigned item (" + unsignedItem.name + ")...")
                zenzo.call("signmessage", addy, unsignedItem.tx).then(sig => {
                    if (sig) {
                        unsignedItem.sig = sig;
                        unsignedItem.hash = hash(unsignedItem.tx + JSON.stringify(unsignedItem.prev) + unsignedItem.sig + unsignedItem.address + unsignedItem.name + unsignedItem.value);
                        eraseItem(unsignedItem.tx, true);
                        items.push(unsignedItem);
                        if (debug("validations")) console.error(" - Item signed successfully!");
                    } else {
                        if (debug("validations")) console.error(" - Signing failed...");
                    }
                });
            }
        });
    }

    // Validate pending items
    if (itemsToValidate.length > 0) {
        validateItems().then(validated => {
            if (debug("validations")) console.log("Validated " + validated + " item(s).")
            if (itemsToValidate.length === validated) {
                itemsToValidate = [];
            }
        });
    }

    // Send our validated items to peers
    if (items.length > 0) {
        validateItems(true).then(validated => {
            if (debug("validations")) console.log("Revalidated " + validated + " item(s).")
        });
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
}, 5000);

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
            addy = config.wallet.address;
        } else {
            console.warn("- Config missing 'address', generating a new address...");
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
            debugType = config.debug;
        } else {
            console.info("- Config missing 'debug' option, defaulting to '" + debugType + "'.");
        }
        
        zenzo.call("ping").then(msg => {
            // If there's no address in the config, generate one and re-run the startForge process again
            if (addy === null) return generateForgeAddress();

            console.info("\n--- Configuration ---\n - RPC Port: " + rpcAuth.port + "\n - Forge Port: " + forgePort + "\n - Forge Address: " + addy + "\n - Debugging Mode: " + debugType + "\n - Max Invalidation Score: " + maxInvalidScore + "\n");
            console.log("Connected to ZENZO-RPC successfully!");
            // Incase the zenzod daemon was restarted, re-lock our collateral UTXOs to prevent accidental spends
            lockCollateralUTXOs().then(locked => {
                if (locked) console.info("All collaterals locked successfully!");
            });

            // Start listening for Forge requests
            app.listen(forgePort);

            // Let's bootstrap the validator with seednodes
            const seednodes = ["45.12.32.114", "144.91.87.251:8000"];
            for (let i=0; i<seednodes.length; i++) {
                // Assume seednodes use the same protocol as us
                let seednode = new Peer(seednodes[i], params.protocolVersion);
                seednode.connect(true);
            }
            isForgeRunning = true;
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
            user: "user",
            pass: "forgepass",
            port: 26211,
            address: address
        },
        maxinvalidscore: 25,
        debug: "none"
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