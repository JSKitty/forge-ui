/* 
    GAMES MANAGER
    -------------
    This file hosts the management functionality for the Forge's built-in Game Manager, this acts as
    an all-in-one downloader + updater + launcher for ZENZO games

    Games are stored in: appdata/games/%game_name%/
*/

// Libraries
const fs =     require('fs');
const db =     require('./database.js');
let request =  require('request');
let progress = require('request-progress');
const _7z =    require('7zip-min');
let exec =     require('child_process').execFile;

// System Application data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Application Support/Zenzo/' : process.env.HOME + '/.zenzo/');
if (appdataZC === process.env.APPDATA) appdataZC += '/Zenzo/'; // Append '/Zenzo/' to the windows appdata directory
appdataZC = appdataZC.replace(/\\/g, '/');

// A hardcoded list of ZENZO games and their content
// TODO: Make this an online list that polls the Arcade for new/updated games
let games = [
    {
        name: "King Of The Apocalypse",      // The display name
        data_name: "king_of_the_apocalypse", // The name used for disk data (dir, file names, etc)
        images: {
            // 600 x 800 'CD cover' image
            cover: "https://images.prd.dlivecdn.com/category/dyyvkgzmdjuk6ow9iuq"
        },
        download_url: "https://arcade.zenzo.io/game-storage/KOTA_Installer.exe",
        db: {
            installed: false,
            downloading: false,
            installing: false,
            progress: 0,
            time_left: null,
            errors: null
        }
    }
];

// Game currently being downloaded (can be null if none are being downloaded)
let downloadingGame = null;

// Perform initialization checks
async function init() {
    try {
    // Ensure the games directory exists
    if (!fs.existsSync(appdata + 'data/games/')) {
        console.warn("Games Manager Init: dir 'data/games/' doesn't exist, creating new directory...");
        fs.mkdirSync(appdata + 'data/games'); /* /forge/data/games/ */
        console.info("Games Manager DB: Created data directory at '" + appdata + "data/games/'");
    }

    for (let i=0; i<games.length; i++) {
        let nInstalled = await isInstalled(games[i].name);
        if (nInstalled) {
            games[i].db.installed = true;
        }
    }

    // All good!
    return true;
    } catch(e) {
        // Error, ouch!
        console.error("Games Manager Init: " + e);
        return false;
    }
}

// Check if a game is installed on disk
async function isInstalled(name) {
    let nGame = getGame(name);
    // Is the game's data-directory installed?
    if (fs.existsSync(appdata + 'data/games/' + nGame.data_name + "/")) {
        return true;
    } else {
        return false;
    }
}

// Start the downloading process of an Arcade game
function startDownloading(name) {
    let nGame = getGame(name);
    if (nGame.db.downloading) return "already downloading";
    if (nGame.db.installing) return  "installing";
    if (nGame.db.installed) return   "installed";
    // Prepare data directory
    try {
        fs.mkdirSync(appdata + 'data/games/' + nGame.data_name);
    } catch (e) {
        // Directory probably already exists, ignore...
    }
    // Begin download
    downloadingGame = nGame;
    downloadingGame.db.downloading = true;
    downloadingGame.db.installing =  false;
    downloadingGame.db.progress =    0;
    progress(request(downloadingGame.download_url), {

    })
    .on('progress', function (state) {
        // Called once a second to provide download state
        downloadingGame.db.downloading =   true;
        downloadingGame.db.installing =    false;
        if (state.percent > 0)
            downloadingGame.db.progress =  (state.percent * 100).toFixed(1);
        if (state.time.remaining !== null && state.time.remaining > 0)
            downloadingGame.db.time_left = state.time.remaining;
        downloadingGame.db.errors =        null;
    })
    .on('error', function (err) {
        // Called when an error occurred
        downloadingGame.db.downloading = false;
        downloadingGame.db.installing =  false;
        downloadingGame.db.progress =    0;
        downloadingGame.db.errors =      err;
    })
    .on('end', function () {
        // Prepare the compressed game for extraction + installation
        downloadingGame.db.downloading = false;
        downloadingGame.db.installing =  true;
        downloadingGame.db.progress =    0;
        downloadingGame.db.errors =      null;
        // A small delay to let the writing stream finish...
        setTimeout(() => {
            _7z.unpack(appdata + 'data/games/' + downloadingGame.data_name + "/compressed_game.exe", appdata + 'data/games/' + downloadingGame.data_name + "/", err => {
                // done!
                downloadingGame.db.installed =  true;
                downloadingGame.db.installing = false;
            });
        }, 1000);
    })
    .pipe(fs.createWriteStream(appdata + 'data/games/' + downloadingGame.data_name + "/compressed_game.exe"));
}

// Starts an Arcade game child process
async function playGame(name) {
    let nGame = getGame(name);
    exec(appdata + 'data/games/' + nGame.data_name + "/" + nGame.name + ".exe", function(err, data) {
        if (err === null) {
            console.log("Games Manager: Playing " + nGame.name + "!");
        } else {
            console.error("Games Manager: Failed to play " + nGame.name + "!\nError: " + err);
        }
    });
}

// Finds a game by it's properties (name, data_name, etc)
function getGame(query) {
    for (let i=0; i<games.length; i++) {
        if (query === games[i].name || query === games[i].data_name) return games[i];
    }
    return null;
}


exports.games =            games;
exports.init =             init;
exports.isInstalled =      isInstalled;
exports.startDownloading = startDownloading;
exports.playGame =         playGame;
exports.getGame =          getGame;