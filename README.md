# ZENZO Forge

## Developer Setup

### For GUI developers (Such as Windows/Linux/Mac or Github Desktop)

1. Download Node.js and Github Desktop

2. In Github Desktop go to `File --> Clone Repo... --> URL`, paste the github URL of your Forge repo and hit "Clone"

3. After cloning, go to the top-bar `Repository --> Open in Command Prompt/Terminal`, type `npm i` to install Forge dependencies

4. After dependencies finish downloading, you can type `npm start` to run the GUI on-the-fly, or `npm run-script build.OS_HERE` to compile binaries for the OS you are using (E.g: A Windows `.exe` binary)

5. (If you plan on compiling binaries, please run `npm i electron-packager -g` and then run `npm run-script build.windows` afterwards and replace windows for your os ie: linux or mac)

### For CLI developers (Such as Linux and git CLI)

1. Install Node.js and Git

2. `git clone` your Forge repo, `cd` into the root of the repo and run `npm i`

3. You may now execute `node lib/index.js` to run the Forge in headless and/or CLI mode

## User Setup

1. Download the ZENZO Forge zip, and unzip the folder:

- Windows: https://www.dropbox.com/s/jx07y63bdce4zl9/ZENZO%20Forge-win32-x64.zip?dl=1

2. Run the ZENZO Forge and follow the setup guide, you may run the "Automated Setup" or do a manual setup

3. Finished! Remember to unlock ZENZO Core (if password protected) so that the Forge can perform Crafting and Transfers
