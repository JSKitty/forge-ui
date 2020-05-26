/* 
    UTILITY FUNCTIONS
    -----------------
    This file hosts non-essential, independent utility functions.
*/

// Ensure an object only contains keys that are considered valid. (E.g: For preventing property pollution)
function areKeysValid(validKeys, obj) {
    for (let [key] of Object.entries(obj)) {
        if (!validKeys.includes(key)) {
            return key;
        }
    }
    return true;
}

exports.areKeysValid = areKeysValid;