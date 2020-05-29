/* 
    FORGE PARAMS
    ------------
    This file hosts the parameters that the Forge follows for consensus, changing these will
    affect the consensus of the P2P network and main-chain, DO NOT modify these if you don't
    intend on forking off the ZENZO Forge mainnet!
*/

// Metadata
const maxMetadataBytes = 2048; // 2KB

// Smart Contracts
const maxContractBytes = 1024; // 1KB

// Formatted as "VersionVersionVersion-Mandatory", each protocol update increments the
// protocol version by one, so incrementing from 000-x would be 001-x, or 009-x to 010-x.
// The "Mandatory" tailing flag determines if the protocol is mandatory or not, if it is,
// the highest Mandatory protocol will immediately disconnect from all older protocols.
const protocolVersion = "005-0";

// Checks if a protocol string meets our defined protocol criteria
function isValidProtocol(pver) {
    // Sanity check ensuring pver is a non-empty string
    if (pver && typeof pver === "string" && pver.length === protocolVersion.length) {
        // Parse the version
        let tmp = pver.split("-");
        const ver = Number(tmp[0]);
        if (ver < 1 || isNaN(ver)) return false;
        //const mandatory = (Number(tmp[1]) === 1 ? true : false);
        //console.info("params.js isValidProtocol(): pver is valid, version " + ver +  " is " + (mandatory === true ? "mandatory" : "non-mandatory"));
        return true;
    } else {
        return false;
    }
}

// Check if a parsed protocol version meets our protocol consensus
function hasConsensus(theirPver) {    
    const ourPver = parse(protocolVersion);
    // Compare our versions
    if (theirPver.version > ourPver.version) {
        // Check if their protocol is too high, or mandatory
        if (theirPver.mandatory) return false;
        if (theirPver.version > ourPver.version + 1) return false;
        // Their protocol is non-mandatory and we are within 1 update to them, consensus is met
        return true;
    } else if (theirPver.version < ourPver.version) {
        // Check if they're too low, or ours is mandatory
        if (ourPver.mandatory) return false;
        if (ourPver.version > theirPver.version + 1) return false;
        // Their protocol is non-mandatory and we are within 1 update to them, consensus is met
        return true;
    } else {
        // Version is equal, honest nodes have full consensus
        return true;
    }
}

// Parse a stringified protocol version into a readable object
function parse(pver) {
    let tmp = pver.split("-");
    const ver = Number(tmp[0]);
    const mandatory = (Number(tmp[1]) === 1 ? true : false);
    return {version: ver, mandatory: mandatory};
}

exports.maxMetadataBytes = maxMetadataBytes;
exports.maxContractBytes = maxContractBytes;

exports.protocolVersion = protocolVersion;
exports.isValidProtocol = isValidProtocol;
exports.hasConsensus = hasConsensus;
exports.parse = parse;