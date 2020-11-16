'use strict';
/* 
    NETWORK FUNCTIONS
    -----------------
    This file hosts the P2P networking functionality of the Forge
*/

// Libraries
const superagent = require('superagent');
var _ =            require('lodash');

let params =   require('./params.js');
let database = require('./database.js');
let util =     require('./util.js');

let debug = false;

function setDebug(bool) {
    debug = bool;
}

// The list of all known peers
let peers = [];

// The list of hardcoded, developer-approved seednodes
const seednodes = ["144.91.87.251:8000", "164.68.102.142:45001"];

// Have other nodes connected to us previously? (We assume not, until we actually receive some data)
let canReceiveData = false;

// The peer class (encapsulates a single peer and it's state in a single object)
class Peer {
    constructor(host, protocol) {
        this.host = "http://" + host; // The host (http URL) of the peer
        this.protocol = params.parse(protocol); // The protocol of the peer
        this.lastPing = 0; // The timestamp of the last succesful ping to this peer
        this.index = ((peers.length != 0) ? peers[peers.length - 1].index + 1 : 0); // The order in which we connected to this peer
        this.sendOnly = false; // A peer is sendOnly if we cannot communicate to them, but they can reach us
    }

    isSendOnly() {
        return this.sendOnly;
    }

    setSendOnly(bool) {
        this.sendOnly = bool;
    }

    connect(shouldPing) {
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
                            if (debug) console.warn("Peer " + this.host + " has an invalid protocol, cancelling connection...");
                            return;
                        }
                        // Check the peer's protocol is within consensus of ours
                        let pver = params.parse(res.text);
                        if (!params.hasConsensus(pver)) {
                            if (debug) console.warn("Peer " + this.host + " doesn't meet local protocol consensus, cancelling connection...");
                            return;
                        }
                        
                        // Protocol is valid and has met consensus, finish the connection!
                        this.lastPing = Date.now();
                        peers.push(this);
                        console.info(`Peer "${this.host}" (${this.index}) responded to ping, appended to peers list!\n- Starting item Sync with peer.`);
                    })
                    .catch((err) => {
                        if (getPeer(this.index) === null) {
                            // Non-handshaked peer didn't respond, don't add to peers list
                        } else {
                            // Handshaked peer didn't respond
                            if (this.lastPing + 60000 < Date.now()) {
                                // No successful pings in over 60 seconds, assume peer is offline and disconnect
                                disconnectPeer(this.host);
                            } else if (!this.isSendOnly() && canReceiveData) {
                                // Peer has pinged us in the past 60 seconds, assume peer is sendOnly   
                                this.setSendOnly(true);
                                if (debug) console.info("Peer \"" + this.host + "\" (" + this.index + ") cannot be reached, but has pinged us recently, assuming sendOnly");
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
            if (debug) console.info(`Successfully sent message "${name}" to peer "${this.host}"`);
        })
        .catch((err) => {
            if (debug) console.warn(`Unable to send "${name}" message to peer "${this.host}" --> ${err.message}`);
        });
    }

    ping() {
        return superagent
            .post(this.host + "/ping")
            .send({protocol: params.protocolVersion}) // Send peer our protocol
            .then((res) => {
                this.lastPing = Date.now();
                if (debug) console.info(`Peer "${this.host}" (${this.index}) responded to ping.`);
            })
            .catch((err) => {
                if (getPeer(this.index) === null) {
                    // Non-handshaked peer didn't respond, don't add to peers list
                } else {
                    // Handshaked peer didn't respond
                    if (this.lastPing + 60000 < Date.now()) {
                        // No successful pings in over 60 seconds, assume peer is offline and disconnect
                        disconnectPeer(this.host);
                    } else if (!this.isSendOnly() && canReceiveData) {
                        // Peer has pinged us in the past 60 seconds, assume peer is sendOnly   
                        this.setSendOnly(true);
                        if (debug) console.info("Peer \"" + this.host + "\" (" + this.index + ") cannot be reached, but has pinged us recently, assuming sendOnly");
                    }
                }
                // If the peer is send-only, allow pings to fail silently to prevent spamming the net logs
                if (!this.isSendOnly() && debug) console.warn(`Unable to ping peer "${this.host}" --> ${err.message}`);
            });
    }

    sendItems(itemsToSend = null, smelts = null) {
        if (this.isSendOnly())
            return false;

        // Deprecate the 'pending/unsigned' lists, we only send one 'items' list alongside 'smelts'
        itemsToSend = {
            items: util.cleanItems(itemsToSend),
            pendingItems: [],
            unsignedItems: [],
            smeltedItems: (smelts === null ? [] : smelts)
        }

        return superagent
            .post(this.host + "/forge/receive")
            .send(itemsToSend)
            .then((res) => {
                this.lastPing = Date.now();
                if (debug) console.info(`Peer "${this.host}" (${this.index}) responded to items with "${res.text}".`);
            })
            .catch((err) => {
                if (debug) console.warn(`Unable to send items to peer "${this.host}" --> ${err.message}`);
            });
    }
}

// Cleanse the IP of unimportant stuff
function cleanIP(ip) {
    return ip.replace(/::ffff:/g, "");
}

// Clear the peers list
function clear() {
    peers = [];
}

// Return the list of connected peers
function getPeers() {
    return peers;
}

// Get a peer object from our list by it's host or index
function getPeer(peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg || peers[i].index === peerArg) return peers[i];
    }
    return null;
}

// Updates the contents of a peer object
function updatePeer(peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg.host || peers[i].index === peerArg.index) {
            peers[i] = peerArg;
            return true;
        }
    }
    return false;
}

// Removes a peer from the peers list
function disconnectPeer(peerArg) {
    for (let i=0; i<peers.length; i++) {
        if (peers[i].host === peerArg || peers[i].index === peerArg) {
            peers.splice(i, 1);
            if (debug) console.warn("Removed peer, we now have " + peers.length + " peer" + (peers.length === 1 ? "" : "s"));
        }
    }
    // Re-index peers to prevent "holes" in the peers array when accessed from a peer class
    for (let index=0; index<peers.length; index++) {
        peers[index].index = index;
    }
}

// Sets "canReceiveData" to true
function receivedPing() {
    canReceiveData = true;
}

// Sends item(s) to every connected peer
function sendItemsToNetwork (itemsToSend) {
    peers.forEach(peer => {
        peer.sendItems(itemsToSend);
    });
}

// Attempt to connect to hardcoded seednodes
function connectSeednodes() {
    for (let i=0; i<seednodes.length; i++) {
        // Assume seednodes use the same protocol as us
        let seednode = new Peer(seednodes[i], params.protocolVersion);
        seednode.connect(true);
    }
}


// Module Exports
exports.Peer =               Peer;
exports.setDebug =           setDebug;
exports.cleanIP =            cleanIP;
exports.clear =              clear;
exports.getPeers =           getPeers;
exports.getPeer =            getPeer;
exports.updatePeer =         updatePeer;
exports.disconnectPeer =     disconnectPeer;
exports.receivedPing =       receivedPing;
exports.sendItemsToNetwork = sendItemsToNetwork;
exports.connectSeednodes =   connectSeednodes;