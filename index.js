const fs = require('fs');
const superagent = require('superagent');
const express = require('express');
const bodyParser = require('body-parser');
const RPC = require('bitcoin-rpc-promise');
const nanoid = require('nanoid');
const x11 = require('x11-hash-js');

// TEMP EXPLORER FIX, INSECURE!
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;

// System Application Data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

/* ------------------ GLOBAL SETTINGS ------------------ */
// The debugging mode, this allows the user to customize what the forge should log
// Debug types: all, none, validations
let debugType = "none";

// Return if the current debug mode includes the caller's debug type
function debug(type) {
    if (debugType === "all") return true;
    if (debugType === "none") return false;

    if (debugType === "validations" && type === "validations") return true;
}


// The max invalidation score we're willing to put up with before classing an item as invalid
let maxInvalidScore = 50;

// Safe mode, this can be used if the RPC is missing or our peers are acting unstable
let safeMode = false;

/* ------------------ NETWORK ------------------ */
// The list of all known peers
let peers = [];

// The list of all known items on the Forge network
let items = [];

// The list of "pending" items, of which require further validations
let itemsToValidate = [];

// The list of smelted item hashes, this can be checked to ensure that a peer doesn't send us a smelted item, thus accidently accepting it due to being valid
let itemsSmelted = [];

// The list of messages that are in the processing queue
let messageQueue = [];

// The explorer API to use for checking if a UTXO is spent (CENTRALIZED)
/* This will eventually be replaced by a home-made system that saves a slimmed UTXO tree on-disk to trustlessly validate the on-chain item collateral */
let explorer = "";

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
async function isItemValid (nItem, approve = false) {
    try {
        if (wasItemSmelted(nItem.hash)) {
            eraseItem(nItem.hash);
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
                    let isSigGenuine = await zenzo.call("verifymessage", nItem.address, nItem.sig, nItem.tx);
                    if (isSigGenuine) {
                        if (debug("validations")) console.info("Sig is genuine...");
                        if (hash(nItem.tx + nItem.sig + nItem.address + nItem.name + nItem.value) === nItem.hash) {
                            if (debug("validations")) console.info("Hash is genuine...");
                            let res = await superagent.get(explorer + 'api/v2/utxo/' + nItem.address + "?confirmed=false");
                            res = JSON.parse(res.text);
                            if (res.length === 0) {
                                if (debug("validations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' has no UTXOs");
                                disproveItem(nItem);
                                addInvalidationScore(nItem, 5);
                                return false; // UTXO has been spent
                            }
                            for (let i=0; i<res.length; i++) {
                                if (res[i].txid === nItem.tx) {
                                    if (debug("validations")) console.warn("Found unspent UTXO collateral...");
                                    if (approve) approveItem(nItem);
                                    return true; // Found unspent collateral UTXO
                                }
                            }
                            if (debug("validations")) console.warn("UTXO couldn't be found, item '" + nItem.name + "' does not have a collateral UTXO");
                            disproveItem(nItem);
                            addInvalidationScore(nItem, 5);
                            return false; // Couldn't find unspent collateral UTXO
                        } else {
                            if (debug("validations")) console.info("Hash is not genuine...");
                            disproveItem(nItem);
                            addInvalidationScore(nItem, 12.5);
                            return false;
                        }
                    } else {
                        if (debug("validations")) console.info("Sig is not genuine...");
                        disproveItem(nItem);
                        addInvalidationScore(nItem, 12.5);
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
        let res = await isItemValid(item, true);
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
        if (nItem.tx.length !== 64) return console.warn("Forge: Received invalid item, TX length is not 64.");
        if (nItem.sig.length < 1) return console.warn("Forge: Received invalid signature, length is below 1.");
        if (nItem.address.length !== 34) return console.warn("Forge: Received invalid address, length is not 34.");
        if (nItem.name.length < 1) return console.warn("Forge: Received invalid name, length is below 1.");
        if (nItem.value < 0.01) return console.warn("Forge: Received invalid item, value is below minimum.");
        if (nItem.hash.length !== 64) return console.warn("Forge: Received invalid item, hash length is not 64.");

        // Check if the item was previously smelted
        if (wasItemSmelted(nItem.hash)) {
            if (debug("validations")) console.error("Rejected item (" + nItem.name + ") from peer, item has been smelted");
            if (reply) res.send("Invalid item (" + nItem.name + "), marked as smelted.");
            return false;
        }

        // Check if the item's contents are genuine
        let valid = await isItemValid(nItem, true);
        if (!valid) {
            if (debug("validations")) console.error("Forge: Received item is not genuine, ignored.");
            return;
        }
        if (getItem(nItem.hash, true) === null) {
            console.info("New item received from peer! (" + nItem.name + ") We have " + items.length + " items.");
            if (reply) res.send("Thanks!");
        }
    });
    return true;
}

// Approve an item as valid, moving it to the main items DB and removing it from the pending list
function approveItem(item) {
    let wasFound = false;
    for (let i=0; i<itemsToValidate.length; i++) {
        if (item.tx === itemsToValidate[i].tx) {
            wasFound = true;
            items.push(item);
            itemsToValidate.splice(i, 1);
            console.info("An item has been approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
        }
    }
    // If the item isn't already in the validation list and isn't already approved, add it as a new approved item
    if (!wasFound) {
        wasFound = false;
        for (let i=0; i<items.length; i++) {
            if (item.tx === items[i].tx) {
                wasFound = true;
            }
        }
        if (!wasFound) {
            items.push(item);
            console.info("An item has been added and approved!\n - Item '" + item.name + "' (" + item.tx + ") has been approved and appended as a verified item.");
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
function eraseItem(item) {
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

// Get an item object from our list by it's hash
function getItem(itemArg, includePending = false) {
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
    constructor(host) {
        this.host = "http://" + host; // The host (http URL) of the peer
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
                peers.push(this);
                return console.info(`Peer "${this.host}" (${this.index}) appended to peers list!`);
            } else {
                return superagent
                    .post(this.host + "/ping")
                    .send("ping!")
                    .then((res) => {
                        // Peer responded, add it to our list
                        this.lastPing = Date.now();
                        this.setStale(false);
                        peers.push(this);
                        console.info(`Peer "${this.host}" (${this.index}) responded to ping, appended to peers list!\n- Starting item Sync with peer.`);
                        this.getItems();
                    })
                    .catch((err) => {
                        // Peer didn't respond, don't add to peers list
                        this.setStale(true);
                        console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
                    });
            }
        }
    }

    send(sentData, name = "Unknown Request") {
        return superagent
        .post(this.host + "/message")
        .send(sentData)
        .then((res) => {
            console.info(`Successfully sent message "${name}" to peer "${this.host}"`);
        })
        .catch((err) => {
            console.warn(`Unable to send "${name}" message to peer "${this.host}" --> ${err.message}`);
        });
    }

    ping() {
        return superagent
            .post(this.host + "/ping")
            .send("ping!")
            .then((res) => {
                this.lastPing = Date.now();
                this.setStale(false);
                console.info(`Peer "${this.host}" (${this.index}) responded to ping.`);
            })
            .catch((err) => {
                // Peer didn't respond, mark as stale
                this.setStale(true);
                console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
            });
    }

    sendItems(itemz) {
        return superagent
            .post(this.host + "/forge/receive")
            .send(cleanItems(itemz))
            .then((res) => {
                this.lastPing = Date.now();
                this.setStale(false);
                console.info(`Peer "${this.host}" (${this.index}) responded to items with "${res.text}".`);
            })
            .catch((err) => {
                // Peer didn't respond, mark as stale
                this.setStale(true);
                console.warn(`Unable to send items to peer "${this.host}" --> ${err.message}`);
            });
    }

    getItems() {
        return superagent
            .post(this.host + "/forge/sync")
            .send((items.length + itemsToValidate.length).toString())
            .then((res) => {
                if (safeMode) return;
                // Peer sent items, scan through them and merge lists if necessary
                this.lastPing = Date.now();
                this.setStale(false);
                let data = JSON.parse(res.text);
                console.info(`Peer "${this.host}" (${this.index}) sent items (${data.items.length} Items, ${data.pendingItems.length} Pending Items)`);
                validateItemBatch(null, cleanItems(data.items.concat(data.pendingItems)), false).then(done => {
                    if (done) {
                        console.info(`Synced with peer "${this.host}", we now have ${items.length} valid & ${itemsToValidate.length} pending items!`);
                    } else console.warn(`Failed to sync with peer "${this.host}"`);
                });
            })
            .catch((err) => {
                console.warn(`Unable to get items from peer "${this.host}" --> ${err.message}`);
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
// An easy way to check if a node is online and responsive
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
            req.peer = new Peer(ip);
            req.peer.lastPing = Date.now();
            req.peer.connect(false);
        }
        console.info('Received ping from "' + ip + '" (' + req.peer.index + ')');
    }

    res.send("Pong!");
});

// Forge Receive
// Allows peers to send us their Forge item data
app.post('/forge/receive', (req, res) => {
    let ip = cleanIP(req.ip);

    let nItems = req.body;

    validateItemBatch(res, nItems, true).then(ress => {
        if (debug("validations")) console.log('Forge: Validated item batch from "' + ip + '"');
    });
});

// Forge Sync
// Allows peers to sync with our database
app.post('/forge/sync', (req, res) => {
    let ip = cleanIP(req.ip);

    // Check if they have a different amount of items to us, if so, ask for them
    if (Number(req.body) != (items.length + itemsToValidate.length)) {
        req.peer = getPeer("http://" + ip);
        req.peer.getItems();
    }

    let obj = {items: items, pendingItems: itemsToValidate};
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

    // Cleanse the input
    req.body.amount = Number(req.body.amount);

    // Create a transaction
    zenzo.call("sendtoaddress", addy, Number(req.body.amount.toFixed(8))).then(txid => {
        // Sign the transaction hash
        zenzo.call("signmessage", addy, txid).then(sig => {
            let nItem = {
                tx: txid,
                sig: sig,
                address: addy,
                name: req.body.name,
                value: req.body.amount
            }
            nItem.hash = hash(nItem.tx + nItem.sig + nItem.address + nItem.name + nItem.value);
            console.log("Forge: Item Created!\n- TX: " + nItem.tx + "\n- Signature: " + nItem.sig + "\n- Name: " + nItem.name + "\n- Value: " + nItem.value + " ZNZ\n- Hash: " + nItem.hash);
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
    let obj = {items: items, pendingItems: itemsToValidate};
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
        console.info(" - Message test worked, yay!");
        messageQueue[0].res.send("Hi! :3");
        messageQueue.shift();
    }

    /* A peer wants to smelt an item */
    else if (messageQueue[0].content.header === "smelt") {
        // Some simple parameter tests
        if (!messageQueue[0].content.item) {
            console.error(" - Item hash missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item hash"});
            return messageQueue.shift();
        }
        if (!messageQueue[0].content.sig) {
            console.error(" - Item signature missing from smelt request!");
            messageQueue[0].res.json({error: "Missing item smelt signature"});
            return messageQueue.shift();
        }

        // Get the item
        const smeltedItem = getItem(messageQueue[0].content.item, true);
        if (!smeltedItem || smeltedItem === null) {
            console.error(" - Item couldn't be found!");
            messageQueue[0].res.json({error: "Missing or Invalid item"});
            return messageQueue.shift();
        }

        // Verify the smelt message's authenticity
        zenzo.call("verifymessage", smeltedItem.address, messageQueue[0].content.sig, "smelt_" + smeltedItem.tx).then(isGenuine => {
            if (isGenuine) {
                console.info(" - Signature verified! Message is genuine, performing smelt...");
                messageQueue[0].res.json({message: "Smelt confirmed"});
                messageQueue.shift();

                // Begin the local smelt process for the item
                smeltItem(smeltedItem.hash, messageQueue[0].content.sig).then(smelted => {
                    console.info("- Item (" + smeltedItem.name + ") smelted successfully!");
                });
            } else {
                console.error(" - Invalid signature, ignoring smelt request.");
                messageQueue[0].res.json({error: "Invalid signature"});
                return messageQueue.shift();
            }
        }).catch(function(){
            console.error(" - Malformed signature, ignoring smelt request.");
            messageQueue[0].res.json({error: "Malformed signature"});
            return messageQueue.shift();
        });
    }
    
    // No matching header found, just count the message as "processed"
    else {
        console.error(" - Message with header '" + messageQueue.shift().content.header + "' ignored, no matching headers.");
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
        console.error("Message sent by " + cleanIP(req.ip) + " is not JSON, ignoring.");
    }
});

app.listen(80);

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
                console.info(`- Peer "${peer.host}" (${peer.index}) responded to smelt with "${res.text}".`);
            })
            .catch((err) => {
                // Peer didn't respond, mark as stale
                peer.setStale(true);
                console.warn(`- Unable to broadcast smelt to peer "${peer.host}" --> ${err.message}`);
            });
        });
    }

    // Add the item hash to the smelted DB
    itemsSmelted.push(item);
    await toDisk("smelted_items.json", itemsSmelted, true);
    console.info("Database: Written " + itemsSmelted.length + " smelted items to disk.");

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

/* Core Node Mechanics */

// Load all relevent data from disk (if it already exists)
// Item data
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

                console.info("Init: loaded from disk:\n- Items: " + items.length + "\n- Pending Items: " + itemsToValidate.length + "\n- Smelted Items: " + itemsSmelted.length);
            });
        });
    });
}

// Start the "janitor" loop to ping peers, validate items and save to disk at intervals
let janitor = setInterval(function() {
    // Only perform these when we've got atleast one peer and the RPC is present, otherwise we're potentially offline, or validating stale data
    if (peers.length === 0 || safeMode) return;

    // Ping peers
    peers.forEach(peer => {
        peer.ping();
        peer.getItems(); // Temp, will be optimized later
    });

    // Validate pending items
    if (itemsToValidate.length > 0) {
        validateItems().then(validated => {
            if (debug("validations")) console.log("Validated " + validated + " item(s).")
            if (itemsToValidate.length === validated) {
                peers.forEach(peer => {
                    peer.sendItems(itemsToValidate);
                    itemsToValidate = [];
                });
            }
        });
    }

    // Send our validated items to peers
    if (items.length > 0) {
        validateItems(true).then(validated => {
            if (debug("validations")) console.log("Revalidated " + validated + " item(s).")
            if (items.length === validated) {
                peers.forEach(peer => {
                    peer.sendItems(items); // Temp, will be optimized later
                });
            }
        });
    }

    // Save data to disk
    toDisk("items.json", items, true).then(res => {
        console.log('Database: Written ' + items.length + ' items to disk.');
        toDisk("pending_items.json", itemsToValidate, true).then(res => {
            console.log('Database: Written ' + itemsToValidate.length + ' pending items to disk.');
            toDisk("smelted_items.json", itemsSmelted, true).then(res => {
                console.log('Database: Written ' + itemsSmelted.length + ' smelted items to disk.');
            });
        });
    });
}, 30000);

// Setup the wallet variables
let addy = "";
let zenzo = null;

// Catch if the wallet RPC isn't available
function rpcError() {
    peers = [];
    safeMode = true;
}

// Load variables from disk config
fromDisk("config.json", true).then(config => {
    let rpcAuth = {user: config.wallet.user, pass: config.wallet.pass, port: config.wallet.port};
    addy = config.wallet.address;
    zenzo = new RPC('http://' + rpcAuth.user + ':' + rpcAuth.pass + '@localhost:' + rpcAuth.port);
    explorer = config.blockbook;
    if (config.maxinvalidscore) {
        maxInvalidScore = config.maxinvalidscore;
    }
    if (config.debug) {
        debugType = config.debug;
    } else {
        console.info("- Config missing 'debug' option, defaulting to 'none'.");
        debugType = "none";
    }
    console.info("\n--- Configuration ---\n - RPC Port: " + rpcAuth.port + "\n - Forge Address: " + addy + "\n - Debugging Mode: " + debugType + "\n - Max Invalidation Score: " + maxInvalidScore + "\n");
    zenzo.call("help").then(msg => {
        console.log("Connected to ZENZO-RPC successfully!");

        // Incase the zenzod daemon was restarted, re-lock our collateral UTXOs to prevent accidental spends
        lockCollateralUTXOs().then(locked => {
            if (locked) console.info("All collaterals locked successfully!");
        });

        // Let's bootstrap the validator with seednodes
        const seednodes = ["45.12.32.114", "144.91.87.251:8000"];
        for (let i=0; i<seednodes.length; i++) {
            let seednode = new Peer(seednodes[i]);
            seednode.connect(true);
        }
    }).catch(function(){
        console.error("Failed to connect to ZENZO-RPC, running Forge in Safe Mode.");
        rpcError();
    });
});

// Save our AuthKey to disk to allow other applications to access the user's Forge node during private actions
/* This is insecure, and will be revamped in the future to have a permission-based system, instead of private key based */
toDisk("auth.key", authToken, false).then(res => {
    console.log('Database: Written AuthKey to disk.');
});