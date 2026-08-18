import { loadDeviceConfig, execOnDevice } from "./lib/deviceRunner.mjs";

async function main() {
  const devices = loadDeviceConfig();
  const win = devices.find(d => d.id === "win-laptop");
  if (!win) throw new Error("No win-laptop configured");

  const winJs = `
const dgram = require('dgram');
const s = dgram.createSocket('udp4');
const msg = Buffer.from(JSON.stringify({
  type: 'RESOSTAGE_DISCOVERY',
  name: 'LAPTOP-3N5MAAT1',
  platform: 'win32',
  port: 2899,
  protocolVersion: '1.0.0',
  discoveryEnabled: true
}));

s.bind(0, () => {
  s.setBroadcast(true);
  s.send(msg, 0, msg.length, 28991, '192.168.5.184', (e1) => {
    console.log('WIN_TX_DIRECT_MAC:', e1 || 'OK');
  });
  s.send(msg, 0, msg.length, 28991, '255.255.255.255', (e2) => {
    console.log('WIN_TX_BCAST:', e2 || 'OK');
  });
  s.send(msg, 0, msg.length, 28991, '192.168.5.255', (e3) => {
    console.log('WIN_TX_SUBNET_BCAST:', e3 || 'OK');
    setTimeout(() => { s.close(); }, 500);
  });
});
`;

  const b64 = Buffer.from(winJs).toString("base64");
  execOnDevice(win, `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) ^| Out-File -Encoding utf8 C:\\\\Users\\\\tkach\\\\send_test.js"`, { stdio: "inherit" });
  execOnDevice(win, `node C:\\Users\\tkach\\send_test.js`, { stdio: "inherit" });
}

main().catch(console.error);
