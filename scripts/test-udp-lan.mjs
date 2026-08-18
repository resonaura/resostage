import dgram from "node:dgram";
import { loadDeviceConfig, execOnDevice } from "./lib/deviceRunner.mjs";

const PORT = 28991;

async function run() {
  console.log("=== LAN UDP DISCOVERY DIAGNOSTIC ===");
  const devices = loadDeviceConfig();
  const win = devices.find(d => d.id === "win-laptop");
  if (!win) throw new Error("No win-laptop configured");

  // Start local receiver on Mac
  const macSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  macSocket.on("message", (msg, rinfo) => {
    console.log(`[Mac RX] Heard from ${rinfo.address}:${rinfo.port}: ${msg.toString()}`);
  });

  await new Promise(r => macSocket.bind(PORT, () => {
    macSocket.setBroadcast(true);
    console.log(`[Mac] Bound to UDP port ${PORT}`);
    r();
  }));

  // Create temporary win-udp-test.js on Windows laptop
  const scriptContent = `
const dgram = require('dgram');
const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
s.on('message', (m, r) => console.log('WIN_RX from ' + r.address + ': ' + m.toString()));
s.bind(${PORT}, () => {
  s.setBroadcast(true);
  const msg = JSON.stringify({ type: 'RESOSTAGE_DISCOVERY', name: 'Win-Test', platform: 'win32', port: 2899, protocolVersion: '1.0.0', discoveryEnabled: true });
  s.send(msg, ${PORT}, '255.255.255.255', (err) => console.log('WIN_TX_BCAST:', err || 'OK'));
  s.send(msg, ${PORT}, '192.168.5.184', (err) => console.log('WIN_TX_DIRECT:', err || 'OK'));
});
setTimeout(() => { s.close(); console.log('WIN_DONE'); }, 3000);
`;

  const b64 = Buffer.from(scriptContent).toString('base64');
  execOnDevice(win, `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | Out-File -Encoding utf8 C:\\Users\\tkach\\win_udp.js"`, { stdio: 'inherit' });

  // Send packet from Mac to 255.255.255.255 and directed to win.host
  const payload = JSON.stringify({ type: "RESOSTAGE_DISCOVERY", name: "Mac-Test", platform: "darwin", port: 2899, protocolVersion: "1.0.0", discoveryEnabled: true });
  macSocket.send(payload, PORT, "255.255.255.255", (err) => {
    console.log("[Mac TX] Sent broadcast to 255.255.255.255", err || "OK");
  });
  macSocket.send(payload, PORT, win.host, (err) => {
    console.log(`[Mac TX] Sent direct to ${win.host}`, err || "OK");
  });

  // Run on Windows
  console.log("[Windows] Running node C:\\Users\\tkach\\win_udp.js on Windows...");
  const winRes = execOnDevice(win, `node C:\\Users\\tkach\\win_udp.js`, { stdio: 'pipe' });
  console.log("[Windows Output]:\n" + (winRes.stdout || winRes.stderr));

  await new Promise(r => setTimeout(r, 1000));
  macSocket.close();
  console.log("=== DONE ===");
}

run().catch(console.error);
