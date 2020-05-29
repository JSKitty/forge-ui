# ZENZO Forge Game - Guía de Integración

## Integración Básica de ZFI basada en una Instancia
**Descripción:** Esta integración básica permite generar clones físicos dentro del prefabricado del juego, que se ha registrado como un elemento en Forge.

**Glosario**
> * **Forge**: ZENZO Forge (P2P Metadata Network)
> * **ZFI**: ZENZO Forge Item (Blockchain-backed Asset)


 ### Capacidades de integración:
* Detectar el inventario de Forge del gamer y generar sus activos propios.
* Crear nuevos activos del gamer en tiempo real.
* Detectar y leer activos de la red global (p. ej, elementos multijugador).


### Prerequisitos:
1.	Instalar el plugin `SimpleJSON`. Esto permite que la integración de Forge lea las respuestas JSON.

1.	Para usar SimpleJSON en Unity, copie el achivo `SimpleJSON.cs` en la carpeta "plugins" de su proyecto dentro de su carpeta de activos.
    - **Wiki**:    http://wiki.unity3d.com/index.php/SimpleJSON#Usage
    - **Archivo**: https://raw.githubusercontent.com/Bunny83/SimpleJSON/master/SimpleJSON.cs

## Guía de Integración (Paso a Paso):
**1.** Cree un archivo C# en Unity llamado `ForgeIntegration`.

**2.** Copie y pegue el siguiente código en el archivo y guárdelo (Unity importará nuevos cambios en el código automáticamente). 
**2a.** Archivo: https://cdn.discordapp.com/attachments/543638439652753409/711168461954351104/ForgeIntegration.cs

**3.**  Ubique este elemento en un *solo* objeto del juego (preferiblemente la cámara del jugador), ya que esto a menudo persiste durante todo el juego.

**4.** (Opcional) Agregue una interfaz de usuario de "texto" al juego. Arrastre y suelte ese elemento en la variable `ForgeStatus` en el inspector de Unity Script.

> El script ya viene preconfigurado, con dos ejemplos de elementos en la cadena: `peg.sword` y `peg.parrot`. Se recomienda poner el prefijo `game_name`  a todos los elementos del juego como una forma actual de identificar rápidamente a qué DApp está vinculado un ZFI específico. **Este método es solo temporal hasta que se agregue compatibilidad adicional con metadatos al protocolo Forge.*

**5.** Para pruebas rápidas, cree un objeto de juego prefabricado (el que desee) y arrastre el objeto prefabricado a la variable `swordObj` del inspector de scripts.

**6.** Ahora puede personalizar la localización de la variable `swordObj`.

> El script viene con una funcionalidad `aleatoria`, que permite que los elementos se generen en ubicaciones `aleatorias`, pero prefabricadas. Puede establecer la lista de apariciones a solo `1`, luego arrastrar y soltar un objeto en el juego (preferiblemente un objeto invisible). Los elementos recién generados utilizarán la posición de estos objetos.

Ahora cree un objeto llamado `peg.sword` en su Forge y abra el juego. El objeto `swordObj` debería aparecer en el juego. Ese es su ZFI (elemento basado en blockchain).

## Felicitaciones!

*Para preguntas y solución de problemas, únase al Discord oficial de [ZENZO](https://discord.gg/MBXPSDH) y navegue hasta el canal **#:fire:-forge**.
