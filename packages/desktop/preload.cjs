// Pont minimal entre l'interface et le système : seulement ce dont l'UI a besoin.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayDesktop", {
  /** Sélecteur de dossier natif (emplacement d'un projet, import d'un dossier existant). */
  pickFolder: (title) => ipcRenderer.invoke("relay:pick-folder", title),
});
