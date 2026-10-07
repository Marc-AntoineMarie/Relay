// Relay desktop — Electron (CommonJS : compatible avec toute version d'Electron).
//
// Le processus principal démarre le moteur Relay (serveur local, EN INTERNE) sur un
// port libre, puis ouvre une fenêtre dessus. Aucune config réseau côté utilisateur :
// pas de port à retenir, pas de souci localhost/IPv6, pas de serveur à lancer à part.
const { app, BrowserWindow, shell } = require("electron");

// Rendu logiciel : évite les crashs GPU sur certaines configs Linux (overhead négligeable
// pour un dashboard). À retirer si tu veux l'accélération matérielle.
app.disableHardwareAcceleration();

let started;

async function createWindow() {
  // @relay/server est en ESM → import dynamique depuis ce fichier CJS.
  const { startServer } = await import("@relay/server");
  // Port fixe (origine stable → préférences mémorisées entre deux lancements),
  // port libre choisi par l'OS s'il est déjà pris.
  started = await startServer({ port: 47474 }).catch(() => startServer({ port: 0 }));

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b0e14",
    title: "Relay",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Les liens externes (obtenir une clé API…) s'ouvrent dans le navigateur système.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await win.loadURL(`http://127.0.0.1:${started.port}`);
}

app.whenReady()
  .then(createWindow)
  .catch((err) => {
    console.error("[relay-desktop] échec au démarrage :", err);
    app.quit();
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  void (async () => {
    if (started !== undefined) await started.close();
    app.quit();
  })();
});
