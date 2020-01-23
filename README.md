# ZENZO Forge

## Developer Setup

```Coming Soon```

## User Setup

1. Download the ZENZO Forge binaries:

- Windows: https://mega.nz/#!JKwmBCZa!FIq_n9beYSLwkqH0MQvl-XN4UhzJ72svGW1-pOQdGY4

2. Open `%appdata%/Zenzo/zenzo.conf` in a text editor, copy/paste the below config:

```
txindex=1
rpcuser=user
rpcpassword=pass
listen=1
server=1
```

3. (Re)start ZENZO Core.

4. Start ZENZO Forge, wait for a white screen, close ZENZO Forge (File --> Exit)

5. Open `%appdata%/forge/data/` and paste the below file contents into it:

```
{
    "wallet": {
        "user": "user",
        "pass": "pass",
        "port": 26211,
        "address": "Z..........."
    },
    "blockbook": "https://blockbook.zenzo.io/"
}
```

6. Replace the "Z...~" in the "address" field with an address from your ZENZO Core

7. Save file, open ZENZO Forge and start crafting!