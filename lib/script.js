// ZENZO Forge stack-based scripting language

/* DEFINITIONS */
const opcodes = {
    ADD: "ADD", /* Adds together two numbers in the stack */
    SUB: "SUB" /* Subtracts number 'B' from number 'A' */
}

let stack = []; // An empty stack

function getOpcodes() {
    return opcodes;
}

function getStack() {
    return stack;
}





/* PARSING & EXECUTION */
async function execute(script) {
    // Start basic parsing checks
    if (!script) return res("Script is empty", false);
    if (typeof script !== "string") return res("Script is not a string", false);
    if (script.length === 0 || script === "") return res("Script is an empty string", false);

    // Basic checks passed, onto parsing the data into an array
    const scriptParams = script.split(" ");
    // Sanity check...
    if (scriptParams.length <= 1) return res("Script has too few params, unable to execute a meaningful operation", false);

    await asyncForEach(scriptParams, async (param) => {
        await pushToStack(param).catch(function(){return res("Stack processor failure", false);});
    });
    return res("Script executed successfully", true);
}

async function pushToStack(data) {
    // Determine what the input is and execute accordingly
    if (pInt(data) > 0) {
        stack.push(pInt(data));
        console.info("--- STACK: Pushed number: '" + pInt(data) + "'");
        return true;
    } else if (data === opcodes.ADD) {
        const res = pInt(stack[0] + stack[1]);
        stack.push(res);
        console.info("--- STACK: Added number: '" + stack[0] + "' to '" + stack[1] + "', result of '" + res + "'");
        stack.shift();
        stack.shift();
        return true;
    } else if (data === opcodes.SUB) {
        const res = pInt(stack[0] - stack[1]);
        stack.push(res);
        console.info("--- STACK: Subtracted number: '" + stack[1] + "' from '" + stack[0] + "', result of '" + res + "'");
        stack.shift();
        stack.shift();
        return true;
    } else {
        return false;
    }
}

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

function pInt(i) {
    return Number((Number(i)).toFixed(6));
}

function res(t, s) {
    return {text: t, success: s};
}

exports.getOpcodes = getOpcodes;
exports.getStack = getStack;
exports.execute = execute;