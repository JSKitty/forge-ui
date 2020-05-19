# ZENZO Forge Game Integration Guide

## Basic Instantiation-based ZFI Integration
**Description:** This basic integration allows for spawning physical, in-game clones of a prefab, which the game has registered as an item on the Forge.

**Glossary**
> * **Forge**: ZENZO Forge (P2P Metadata Network)
> * **ZFI**: ZENZO Forge Item (Blockchain-backed Asset)


 ### Integration Capabilities:
* Detect the player's Forge inventory and spawn their owned assets.
* Create new player assets in real-time.
* Detect and read assets from the global network (i.e.: multiplayer items).


### Prerequisites:
1. Install the `SimpleJSON` plugin. This allows the Forge integration to read the Forge's JSON responses.

1. To use SimpleJSON in Unity, copy the `SimpleJSON.cs` file into
    your project's "plugins" folder inside your assets folder.

    - **Wiki**: http://wiki.unity3d.com/index.php/SimpleJSON#Usage
    - **File**: https://raw.githubusercontent.com/Bunny83/SimpleJSON/master/SimpleJSON.cs

## Integration Guide (Step by Step):
**1.** Create a C# file in Unity called `ForgeIntegration`.

**2.** Copy/Paste the below code into the file and save it (Unity will import new code changes automatically).
**2a.**  File: https://cdn.discordapp.com/attachments/543638439652753409/711168461954351104/ForgeIntegration.cs

**3.** Put this item on *only* one game object (preferably the player camera), as this is often persisted through the entire game.

**4.** (Optional) Add a "text" UI to the game. Drag and drop that element into the `ForgeStatus` variable in the Unity Script inspector.

> The script has already come pre-configured, with two on-chain item examples `peg.sword` and `peg.parrot`. It is recommended to prefix *all* in-game items with `game_name` as the current way of quickly identifying what DApp a specific ZFI is tied to. **This method is only temporary until additional metadata support is added to the Forge protocol.*

**5.** For quick testing, create a prefab game object (whatever you want) and drag the prefab into the script inspector's `swordObj` variable.

**6.** Now, you may customize the spawn location of the `swordObj`. 

> The script comes with a `randomized` functionality, which allows items to spawn in `random`, yet pre-made locations. You can set `spawns` list to only `1`, then drag and drop an in-game object (preferably an invisible object). The newly spawned items will use the `position` of these objects

Now craft an item called `peg.sword` in your Forge and launch the game. The `swordObj` prefab should spawn in-game. That is your ZFI (blockchain-based item).

## Congratulations! 

*For any questions and troubleshooting, join the official [ZENZO Discord](https://discord.gg/MBXPSDH) and navigate to the **#:fire:-forge** channel.
