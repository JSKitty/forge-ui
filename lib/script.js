// ZENZO Forge stack-based scripting language
const { isString, isBuffer, isObjectLike, isObject } = require('lodash');
var _ = require('lodash');

/* DEFINITIONS */
const opcodes = {
    // Arithmetic
    ADD: "ADD",                   /* Adds together number 'A' to number 'B' */
    SUB: "SUB",                   /* Subtracts number 'B' from number 'A' */
    MUL: "MUL",                   /* Multiplies number 'A' with number 'B' */
    DIV: "DIV",                   /* Divides number 'A' by number 'B' */
    DUP: "DUP",                   /* Duplicates 'a', adding it as a cloned element */
    // Operators and Conditionals
    EQUAL: "EQUAL",               /* Returns 1 if 'A' is equal to 'B', otherwise returns 0 */
    LESSTHAN: "LESSTHAN",         /* Returns 1 if 'A' is less than 'B', otherwise returns 0 */
    GREATERTHAN: "GREATERTHAN",   /* Returns 1 if 'A' is greater than 'B', otherwise returns 0 */
    CONTINUETRUE: "CONTINUETRUE", /* Continues the script if the last stack is true, otherwise exits as valid */
    // Time
    EPOCH: "EPOCH",               /* Returns the current Unix Epoch in Seconds */
    CHAINEPOCH: "CHAINEPOCH",     /* Returns the Epoch of the item's included block, or OP_EPOCH if unconfirmed */

    // --- START CONTEXTUAL --- \\
    // Contextual OPcodes require a context, in terms of blockchain and item inventory.
    // These codes are naturally much more intensive, thus, more expensive to compute by the VM.
    // ---

    // Blockchain
    GETBESTBLK: "GETBESTBLK",     /* Returns the best block number, the newest block on the chain */
    // Items
    ISNAMEUSED: "ISNAMEUSED",     /* (ZFI-1) Returns 1 if item with name 'a' exists, otherwise returns 0 */
    GETITEMEPOCH: "GETITEMEPOCH"  /* (ZFI-1) Returns the Epoch of the item 'a', if it doesn't exist, returns 0 */

}

let stack = []; // An empty stack

function getOpcodes() {
    return opcodes;
}

function getStack() {
    return stack;
}


// Returns a list of contextual codes, if none exist, returns null
function containsContextualCodes(script) {
    let resList = [];
    if (script.includes(opcodes.GETBESTBLK)) resList.push(opcodes.GETBESTBLK);
    if (script.includes(opcodes.ISNAMEUSED)) resList.push(opcodes.ISNAMEUSED);
    if (script.includes(opcodes.GETITEMEPOCH)) resList.push(opcodes.GETITEMEPOCH);
    return resList.length === 0 ? null : resList;
}

function pInt(i) {
    return Number((Number(i)).toFixed(6));
}

function res(r, t, s) {
    return {result: r, text: t, success: s};
}


/* PARSING & EXECUTION */
async function execute(script, contextualData) {
    // Start basic parsing checks
    if (!script) return res(false, "Script is empty", false);
    if (typeof script !== "string") return res(false, "Script is not a string", false);
    if (script.length === 0 || script === "") return res(false, "Script is an empty string", false);

    // Basic checks passed, onto parsing the data into an array
    const scriptParams = script.split(" ");
    // Sanity check...
    if (scriptParams.length <= 1) return res(false, "Script has too few params, unable to execute a meaningful operation", false);

    let ret = await evaluate(scriptParams, contextualData);
    if (discontinue) {
        stack = [];
        discontinue = false;
        return res(1, "Script executed successfully, discontinued by condition", true);
    }
    if (ret.error) {
        stack = [];
        return res(ret, ret.error, false);
    }
    const stackResult = stack[0];
    stack = []; // TMP, clear the stack
    return res(stackResult, "Script executed successfully", true);
}

let discontinue = false;
async function evaluate(scriptParams, contextualData) {
    let i = 0;
    let evalRet;
    for await (let nParam of scriptParams) {
        const scriptLeft = _.slice(scriptParams, i, scriptParams.length - 1);
        let ret = await pushToStack(nParam, scriptLeft, contextualData);
        if (discontinue) {
            // Discontinue (A script executed successfully and a condition returned the interpreter early)
            evalRet = ret;
            break;
        } else
        if (ret === false) {
            return {error: "Stack processor failure at operation \"" + nParam + "\""};
        }
        evalRet = ret;
        i++;
    }
    return evalRet;
}

async function pushToStack(data, script, contextualData) {
    // Determine what the input is and execute accordingly
    
    /* Arithmetic */
    if (data === opcodes.ADD) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = pInt(stack[0] + stack[1]);
        stack.push(ret);
        console.info("--- STACK: Added number: '" + stack[0] + "' to '" + stack[1] + "', result of '" + ret + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.SUB) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = pInt(stack[0] - stack[1]);
        stack.push(ret);
        console.info("--- STACK: Subtracted number: '" + stack[1] + "' from '" + stack[0] + "', result of '" + ret + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.MUL) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = pInt(stack[0] * stack[1]);
        stack.push(ret);
        console.info("--- STACK: Multiplied number: '" + stack[0] + "' with '" + stack[1] + "', result of '" + ret + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.DIV) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = pInt(stack[0] / stack[1]);
        stack.push(ret);
        console.info("--- STACK: Divided number: '" + stack[0] + "' by '" + stack[1] + "', result of '" + ret + "'");
        stack.shift();
        stack.shift();
        return true;
    }

    else if (data === opcodes.DUP) {
        if (stack.length === 0) return false;
        stack.push(_.cloneDeep(stack[stack.length - 1]));
        console.info("--- STACK: Duplicated stack '" + stack[stack.length - 1] + "'");
        return true;
    }
    
    /* Operators and Conditionals */
    else if (data === opcodes.EQUAL) {
        const ret = stack[0] === stack[1] ? 1 : 0;
        stack.push(ret);
        console.info("--- STACK: '" + stack[0] + "' is " + (ret === 1 ? "EQUAL TO" : "NOT EQUAL TO") + " '" + stack[1] + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.LESSTHAN) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = stack[0] < stack[1] ? 1 : 0;
        stack.push(ret);
        console.info("--- STACK: '" + stack[0] + "' is " + (ret === 1 ? "LESS THAN" : "NOT LESS THAN") + " '" + stack[1] + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.GREATERTHAN) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = stack[0] > stack[1] ? 1 : 0;
        stack.push(ret);
        console.info("--- STACK: '" + stack[0] + "' is " + (ret === 1 ? "GREATER THAN" : "NOT GREATER THAN") + " '" + stack[1] + "'");
        stack.shift();
        stack.shift();
        return true;
    }

    else if (data === opcodes.CONTINUETRUE) {
        if (stack.length === 0) return false;
        if (stack[stack.length - 1] !== 1) {
            discontinue = true;
            return true;
        }
        // Stack is 1, continue script execution
        stack.pop();
        console.info("--- STACK: Top stack is true, continuing execution...");
        return true;
    }

    /* Time-based operations */
    else if (data === opcodes.EPOCH) {
        const ret = Math.floor(Date.now() / 1000);
        stack.push(ret);
        console.info("--- STACK: Pushed EPOCH number: '" + ret + "'");
        return true;
    } 
    else if (data === opcodes.CHAINEPOCH) {
        let ret = 0;
        if (isNaN(contextualData.this.timestamp)) {
            // No Timestamp... this item may be pending or within mempool.
            // It's fine to assume the timestamp is Date.now(), otherwise the item would be
            // ... nuked upon first validations.
            ret = Math.floor(Date.now() / 1000);
        } else {
            // Timestamp of the block this item was included in
            ret = contextualData.this.timestamp;
        }
        // Sanity checks...
        if (isNaN(ret) || ret < 0) return false;
        stack.push(ret);
        console.info("--- STACK: Pushed CHAIN EPOCH number: '" + ret + "'");
        return true;
    }

    /* Blockchain-based operations (CONTEXTUAL) */
    else if (data === opcodes.GETBESTBLK) {
        if (isNaN(contextualData.bestBlock)) return false;
        const ret = contextualData.bestBlock;
        stack.push(ret);
        console.info("--- STACK: Pushed BEST BLOCK: '" + ret + "'");
        return true;
    }

    /* Item-based operations (CONTEXTUAL) */
    // ISNAMEUSED - Implemented from the ZFI-1 spec
    else if (data === opcodes.ISNAMEUSED) {
        // Ensure we have the 'a' arguement, which corresponds to the string name of the item as HEX buffer.
        if (!isBuffer(stack[0]) || stack[0].byteLength < 1) return false;
        // Loop through all of our context items for a match
        let i, len = contextualData.signedItems.length;
        let foundItem = null;
        for (i=0; i<len; i++) {
            if (contextualData.signedItems[i].tx === contextualData.this.tx) continue;
            const itemNameBuffer = Buffer.from(contextualData.signedItems[i].name, "utf8");
            // 'a' is the hex representation of 'itemNameBuffer', which is utf8; this is an intended comparison
            // ... as technically the comparison is correct.
            if (stack[0].equals(itemNameBuffer)) {
                // We have found an exact match in item name
                foundItem = contextualData.signedItems[i];
                break;
            }
        }
        const ret = (foundItem === null ? 0 : 1);
        console.info("--- STACK: Item name " + stack[0] + " is '" + (ret === 0 ? "un" : "") + "used'");
        stack.shift();
        if (ret)
            stack.push(foundItem.tx); // TX-ID (if found)
        stack.push(ret);              // Return bool (true if used, false if unused)
        return true;
    }
    // GETITEMEPOCH - Implemented from the ZFI-1 spec
    else if (data === opcodes.GETITEMEPOCH) {
        // Ensure we have the 'a' arguement, which corresponds to the item's TX-ID string.
        if (!isString(stack[stack.length - 1]) || stack[stack.length - 1].length !== 64) return false;
        // Loop through all of our context items for a match
        let i, len = contextualData.signedItems.length;
        let foundItem = null;
        for (i=0; i<len; i++) {
            if (stack[stack.length - 1] === contextualData.signedItems[i].tx) {
                // We have found an exact match in item name
                foundItem = contextualData.signedItems[i];
                break;
            }
        }
        if (!foundItem.timestamp || isNaN(foundItem.timestamp)) return false;
        stack.pop();
        stack.push(foundItem.timestamp);
        console.info("--- STACK: Pushed item EPOCH '" + foundItem.timestamp + "'");
        return true;
    }

    /* Native data input */
    // (Numbers)
    else if (!isNaN(pInt(data))) {
        stack.push(pInt(data));
        console.info("--- STACK: Pushed number: '" + pInt(data) + "'");
        return true;
    }

    // (HEX Strings)
    else if (data.length >= 1) {
        // If this is already a HEX buffer, return it, otherwise we encode the string as a HEX buffer ourselves.
        const ret = Buffer.isBuffer(data) ? data : Buffer.from(data, "hex");
        if (ret.byteLength < 1) return false;
        stack.push(ret);
    }
    
    // Nothing found, return a script failure
    else {
        return false;
    }
}

exports.containsContextualCodes = containsContextualCodes;
exports.getOpcodes = getOpcodes;
exports.getStack = getStack;
exports.execute = execute;