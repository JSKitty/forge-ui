// ZENZO Forge stack-based scripting language

/* DEFINITIONS */
const opcodes = {
    ADD: "ADD",    /* Adds together number 'A' to number 'B' */
    SUB: "SUB",    /* Subtracts number 'B' from number 'A' */
    MUL: "MUL",    /* Multiplies number 'A' with number 'B' */
    EQUAL: "EQUAL" /* Returns 1 if 'A' is equal to 'B', otherwise returns 0 */

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

    let i = 0;
    for await (let nParam of scriptParams) {
        let ret = await pushToStack(nParam);
        if (ret === false) {
            return res(ret, "Stack processor failure at stack " + i + ", operation \"" + nParam + "\"", false);
        }
        i++;
    }
    const stackResult = stack[0];
    stack = []; // TMP, clear the stack
    return res(stackResult, "Script executed successfully", true);
}

async function pushToStack(data) {
    // Determine what the input is and execute accordingly
    if (!isNaN(pInt(data))) {
        stack.push(pInt(data));
        console.info("--- STACK: Pushed number: '" + pInt(data) + "'");
        return true;
    } else if (data === opcodes.ADD) {
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
    }  else if (data === opcodes.MUL) {
        if (isNaN(stack[0]) || isNaN(stack[1])) return false;
        const ret = pInt(stack[0] * stack[1]);
        stack.push(ret);
        console.info("--- STACK: Multiplied number: '" + stack[0] + "' with '" + stack[1] + "', result of '" + ret + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.EQUAL) {
        const ret = stack[0] === stack[1] ? 1 : 0;
        stack.push(ret);
        console.info("--- STACK: '" + stack[0] + "' is " + (ret === 1 ? "EQUAL TO" : "NOT EQUAL TO") + " '" + stack[1] + "'");
        stack.shift();
        stack.shift();
        return ret === 1 ? true : false;
    } else {
        return false;
    }
}


exports.getOpcodes = getOpcodes;
exports.getStack = getStack;
exports.execute = execute;