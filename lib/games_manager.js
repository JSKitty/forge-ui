'use strict';
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
let rimraf = require("rimraf");

// System Application data directory
let appdata = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : '/var/local');
appdata = appdata.replace(/\\/g, '/') + '/forge/';

// ZENZO Core data directory
let appdataZC = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support/Zenzo/' : process.env.HOME + '/.zenzo/');
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
        // Is the game fully installed?
        if (fs.existsSync(appdata + 'data/games/' + nGame.data_name + "/" + nGame.name + ".exe")) {
            // Game is fully installed, nothing more to check
            return true;
        } else {
            // Nope, do we atleast have a compressed version?
            if (fs.existsSync(appdata + 'data/games/' + nGame.data_name + "/compressed_game.exe")) {
                // Yep, so "playGame" will auto-install this at runtime
                return true;
            } else {
                // Nope, the game needs installing
                return false;
            }
        }
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
                if (err) console.error("Game Manager: Installation failed at decompress: " + err);
                // done!
                downloadingGame.db.installed =  true;
                downloadingGame.db.installing = false;
            });
        }, 1000);
    })
    .pipe(fs.createWriteStream(appdata + 'data/games/' + downloadingGame.data_name + "/compressed_game.exe"));
}

// Track the time of the last game launch
let lastGameLaunch = 0;

// Starts an Arcade game child process
async function playGame(name) {
    // To prevent accidently opening a game twice, add a small 2 second 'cooldown' using the last game launch time
    if (lastGameLaunch + 2000 > Date.now()) return false;
    lastGameLaunch = Date.now();

    // Launch the game!
    let nGame = getGame(name);
    exec(appdata + 'data/games/' + nGame.data_name + "/" + nGame.name + ".exe", function(err, data) {
        if (err === null) {
            console.log("Games Manager: Playing " + nGame.name + "!");
        } else {
            console.error("Games Manager: Failed to play " + nGame.name + "!\nError: " + err);
            // That's not fun... but let's diagnose!
            // Do we have the compressed installer?
            if (fs.existsSync(appdata + 'data/games/' + nGame.data_name + "/compressed_game.exe")) {
                console.warn("Game Manager: Unable to play " + nGame.name + ", but attempting a recovery via compressed game files...");
                nGame.db.installed =  false;
                nGame.db.installing = true;
                // Yay, finish the installation process now
                _7z.unpack(appdata + 'data/games/' + nGame.data_name + "/compressed_game.exe", appdata + 'data/games/' + nGame.data_name + "/", err => {
                    // Double-check the install worked fine
                    if (fs.existsSync(appdata + 'data/games/' + nGame.data_name + "/" + nGame.name + ".exe")) {
                        // Done, play the game!
                        console.warn("Game Manager: Recovery successful, re-attempting to launch " + nGame.name);
                        nGame.db.installed =  true;
                        nGame.db.installing = false;
                        playGame(name);
                    } else {
                        // Something is irrecoverably wrong, welp, nuking the directories and allowing re-installation
                        console.warn("Game Manager: Unable to recover " + nGame.name + ", nuking installation and allowing re-install.");
                        uninstallGame(nGame.name);
                    }
                });
            } else {
                // Welp, nothing we can do, clean up the directories and allow re-installation
                console.warn("Game Manager: Unable to recover " + nGame.name + ", nuking installation and allowing re-install.");
                uninstallGame(nGame.name);
            }
        }
    });
}

// Uninstalls a game from the system
async function uninstallGame(name) {
    let nGame = getGame(name);

    // Uninstall the game's directory recursively, mark the game as uninstalled
    rimraf.sync(appdata + 'data/games/' + nGame.data_name);
    nGame.db.installed =    false;
    nGame.db.installed =    false;
    nGame.db.downloading =  false;
    return true;
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
exports.uninstallGame =    uninstallGame;
exports.getGame =          getGame;