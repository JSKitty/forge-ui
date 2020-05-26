// ZENZO Forge stack-based scripting language
var _ = require('lodash');

/* DEFINITIONS */
const opcodes = {
    // Arithmetic
    ADD: "ADD",                 /* Adds together number 'A' to number 'B' */
    SUB: "SUB",                 /* Subtracts number 'B' from number 'A' */
    MUL: "MUL",                 /* Multiplies number 'A' with number 'B' */
    DIV: "DIV",                 /* Divides number 'A' by number 'B' */
    // Operators and Conditionals
    EQUAL: "EQUAL",             /* Returns 1 if 'A' is equal to 'B', otherwise returns 0 */
    LESSTHAN: "LESSTHAN",       /* Returns 1 if 'A' is less than 'B', otherwise returns 0 */
    GREATERTHAN: "GREATERTHAN", /* Returns 1 if 'A' is greater than 'B', otherwise returns 0 */
    // Time
    EPOCH: "EPOCH"              /* Returns the current Unix Epoch in Seconds */

}

let stack = []; // An empty stack

function getOpcodes() {
    return opcodes;
}

function getStack() {
    return stack;
}



function pInt(i) {
    return Number((Number(i)).toFixed(6));
}

function res(r, t, s) {
    return {result: r, text: t, success: s};
}


/* PARSING & EXECUTION */
async function execute(script) {
    // Start basic parsing checks
    if (!script) return res(false, "Script is empty", false);
    if (typeof script !== "string") return res(false, "Script is not a string", false);
    if (script.length === 0 || script === "") return res(false, "Script is an empty string", false);

    // Basic checks passed, onto parsing the data into an array
    const scriptParams = script.split(" ");
    // Sanity check...
    if (scriptParams.length <= 1) return res(false, "Script has too few params, unable to execute a meaningful operation", false);

    let ret = await evaluate(scriptParams);
    if (ret.error) {
        return res(ret, ret.error, false);
    }
    const stackResult = stack[0];
    stack = []; // TMP, clear the stack
    return res(stackResult, "Script executed successfully", true);
}

async function evaluate(scriptParams) {
    let i = 0;
    let evalRet;
    for await (let nParam of scriptParams) {
        const scriptLeft = _.slice(scriptParams, i, scriptParams.length - 1);
        let ret = await pushToStack(nParam, scriptLeft);
        if (ret === false) {
            return {error: "Stack processor failure at operation \"" + nParam + "\""};
        }
        evalRet = ret;
        i++;
    }
    return evalRet;
}

async function pushToStack(data, script) {
    // Determine what the input is and execute accordingly

    /* Native data input (Numbers) */
    if (!isNaN(pInt(data))) {
        stack.push(pInt(data));
        console.info("--- STACK: Pushed number: '" + pInt(data) + "'");
        return true;
    }
    
    /* Arithmetic */
    else if (data === opcodes.ADD) {
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

    /* Time-based operations */
    else if (data === opcodes.EPOCH) {
        const ret = Math.floor(Date.now() / 1000);
        stack.push(ret);
        console.info("--- STACK: Pushed EPOCH number: '" + ret + "'");
        return true;
    }
    
    // Nothing found, return a script failure
    else {
        return false;
    }
}


exports.getOpcodes = getOpcodes;
exports.getStack = getStack;
exports.execute = execute;