# ZENZO Forge troubleshooting FAQ

This Troubleshooting guide aims to assist users having unique problems with the Forge, not every circumstance will be covered here, but the guide attempts to cover as many possible scenarios as possible to give you the best chance in fixing and/or improving your Forge experience.

---

## 1. I cannot see my friend's profile
![Invalid Profile](https://media.discordapp.net/attachments/543638439652753409/805081302952574986/unknown.png)

**Cause:** Most probably the cause is "Lightnode" mode, by default, the Forge installs in Light mode to use less internet bandwidth, CPU and RAM, but this has some side-effects which can make certain ZFIs harder to interact with, like external Profiles, as these ZFIs are essentially being 'pruned' to remove the extra resource load from your computer.

**Solution:** The easiest fix is to enable "Fullnode" mode, which will allow your Forge to validate every item on the network that it's aware of.
> Step A: Open your file explorer.

> Step B: Open this path: `%appdata%/forge/data/` in the top directory bar (**NOT** search bar).

> Step C: Open `config.json` in Notepad or any other text editor.

> Step D: Find the `"fullnode":false` property, and change `false` to `true`.

> Step E: Restart the Forge, and wait a minute or two for the Forge to validate all items. **Done!**

---

## 2: I cannot craft/smelt my ZFI


**Cause:** The most likely cause is a locked wallet, ZENZO Core must sign a signature to approve the transaction, this can only be done when ZENZO Core is fully unlocked, the same applies for DApps utilizing the Forge, like KOTA, or others.

**Solution:**
> Open ZENZO Core, find the top-right "Padlock" symbol, click it, select "Unlock Wallet" and enter your password, then you may continue!

---

## 3: Games Manager: After installing a game, I click Play and it does nothing.

**Solution:** For this example, KOTA is the game. Delete the KOTA Folder in your directory and reinstall it within the ZENZO Forge again.
> Step A: Close your ZENZO Forge application, if it isn't shutdown already.

> Step B: Open your file explorer.

> Step C: Go to the directory, similar to this `C:\Users\ADMIN\AppData\Roaming\forge\data\games`

> Step D: Delete the folder of the desired game you're having issues with. For this example, delete the KOTA folder.

> Step E: Restart the ZENZO Forge and install the game again.

