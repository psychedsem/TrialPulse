import { createElement } from "react";

const STORAGE_KEY = "trialpulse.artifacts";

export function safeArtifacts(value) {
  const item = Array.isArray(value) ? value[0] : null;
  if (!item || item.type !== "image" || item.mime_type !== "image/png" ||
    typeof item.alt !== "string" || item.alt.length > 200 || typeof item.data !== "string" ||
    item.data.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) return [];
  try {
    const bytes = atob(item.data);
    const size = offset => [...bytes.slice(offset, offset + 4)].reduce((value, char) => value * 256 + char.charCodeAt(0), 0);
    const width = size(16), height = size(20);
    const valid = bytes.length >= 33 && bytes.length <= 1048576 && bytes.slice(0, 8) === "\x89PNG\r\n\x1a\n" &&
      bytes.slice(12, 16) === "IHDR" && width > 0 && width <= 1600 && height > 0 && height <= 1200;
    return valid ? [{ type: item.type, mime_type: item.mime_type, data: item.data, alt: item.alt }] : [];
  } catch { return []; }
}

export function ChatArtifacts({ artifacts }) {
  return safeArtifacts(artifacts).map((item, index) => createElement("img", {
    key: index, src: `data:image/png;base64,${item.data}`, alt: item.alt,
    style: { display: "block", maxWidth: "100%", height: "auto", marginTop: "1rem" },
  }));
}

export function loadArtifacts(storage, history = []) {
  try {
    const value = JSON.parse((storage ?? globalThis.sessionStorage).getItem(STORAGE_KEY));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(-4).filter(([key, entry]) =>
      /^\d+$/.test(key) && history[key]?.role === "assistant" && entry?.answer === history[key].content)
      .map(([key, entry]) => [key, safeArtifacts(entry.images)]));
  } catch { return {}; }
}

export function saveArtifacts(value, storage, history = []) {
  try {
    const session = storage ?? globalThis.sessionStorage;
    const entries = Object.entries(value).slice(-4).filter(([key]) => history[key]?.role === "assistant")
      .map(([key, images]) => [key, { answer: history[key].content, images: safeArtifacts(images) }]);
    if (!entries.length) {
      session.removeItem(STORAGE_KEY);
      return;
    }
    const encoded = JSON.stringify(Object.fromEntries(entries));
    if (encoded.length <= 3000000) session.setItem(STORAGE_KEY, encoded);
  } catch { /* Il grafico resta visibile anche se la persistenza non è disponibile. */ }
}
