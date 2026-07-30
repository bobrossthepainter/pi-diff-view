#!/usr/bin/env node
import { createInterface } from "node:readline";

const info = {
  screen: { width: 1280, height: 900, scaleFactor: 1 },
  screens: [{ width: 1280, height: 900, scaleFactor: 1 }],
  appearance: { darkMode: false, accentColor: "#007aff", reduceMotion: false, increaseContrast: false },
  cursor: { x: 0, y: 0 },
  cursorTip: null,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function exerciseProxy(initialUrl) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pageResponse = await fetch(initialUrl);
  const page = await pageResponse.text();
  const origin = new URL(initialUrl).origin;
  const stream = await fetch(`${origin}/events`).then((response) => response.text());

  const webSocketResult = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/socket`);
    const timer = setTimeout(() => reject(new Error("WebSocket test timed out")), 3000);
    socket.addEventListener("open", () => socket.send("relay-ping"));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const value = String(event.data);
      socket.close();
      resolve(value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket test failed"));
    });
  });

  send({ type: "message", data: { page, stream, webSocketResult } });
}

send({ type: "ready", ...info });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "html") {
    const html = Buffer.from(message.html, "base64").toString("utf8");
    const match = html.match(/location\.replace\((.+?)\)<\/script>/);
    if (!match) {
      send({ type: "message", data: { error: "Missing proxy URL" } });
      return;
    }
    void exerciseProxy(JSON.parse(match[1])).catch((error) => {
      send({ type: "message", data: { error: error instanceof Error ? error.message : String(error) } });
    });
  } else if (message.type === "close") {
    send({ type: "closed" });
    process.exit(0);
  }
});
