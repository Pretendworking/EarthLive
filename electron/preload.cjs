const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("earthlive", {
  getFlightState: () => ipcRenderer.invoke("flight:get-state"),
  refreshFlightData: () => ipcRenderer.invoke("flight:refresh"),
  getCameraState: () => ipcRenderer.invoke("camera:get-state"),
  readClipboard: () => ipcRenderer.invoke("camera:read-clipboard"),
  saveWindyKey: (key) => ipcRenderer.invoke("camera:save-windy-key", key),
  clearWindyKey: () => ipcRenderer.invoke("camera:clear-windy-key"),
  updateCameraSettings: (settings) => ipcRenderer.invoke("camera:update-settings", settings),
  discoverWindy: () => ipcRenderer.invoke("camera:discover-windy"),
  discoverTfl: () => ipcRenderer.invoke("camera:discover-tfl"),
  getCameraMedia: (cameraKey) => ipcRenderer.invoke("camera:get-media", cameraKey),
  saveUserCamera: (camera) => ipcRenderer.invoke("camera:save-user", camera),
  importLegacyCameras: (cameras) => ipcRenderer.invoke("camera:import-legacy", cameras),
  deleteCamera: (cameraKey) => ipcRenderer.invoke("camera:delete", cameraKey),
  updateCameraStatus: (cameraKey, status, playbackVerified) =>
    ipcRenderer.invoke("camera:update-status", cameraKey, status, playbackVerified),
  openExternal: (url) => ipcRenderer.invoke("camera:open-external", url),
  onCameraProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("camera:progress", handler);
    return () => ipcRenderer.removeListener("camera:progress", handler);
  }
});
