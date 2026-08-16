import { Chip, Spinner } from "@heroui/react";
import { Globe, Laptop, Radio, RefreshCw, Server, ShieldCheck, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, Switch } from "./ui";
import { IS_ELECTRON } from "../lib/electron";

interface DiscoveredDevice {
  name: string;
  platform: string;
  ip: string;
  port: number;
  protocolVersion: string;
  discoveryEnabled: boolean;
}

const REQUIRED_PROTOCOL_VERSION = "1.0.0";

export function RemoteSettingsSection() {
  const [discoveryEnabled, setDiscoveryEnabled] = useState(true);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("2899");
  const [isRemoteMode, setIsRemoteMode] = useState(false);
  const [activeRemoteHost, setActiveRemoteHost] = useState<string | null>(null);

  const fetchStatusAndDevices = async () => {
    setLoading(true);
    try {
      if (IS_ELECTRON && window.resostageElectron?.getDiscoveredDevices) {
        const list = await window.resostageElectron.getDiscoveredDevices();
        setDevices(list || []);
      } else {
        // Fallback demo/web scanning
        const localDevice: DiscoveredDevice = {
          name: "ResoStage Core (Local)",
          platform: "darwin",
          ip: "127.0.0.1",
          port: 2899,
          protocolVersion: "1.0.0",
          discoveryEnabled: true,
        };
        setDevices([localDevice]);
      }

      if (IS_ELECTRON && window.resostageElectron?.getRemoteStatus) {
        const status = await window.resostageElectron.getRemoteStatus();
        setIsRemoteMode(status.isRemoteMode);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatusAndDevices();
    const interval = setInterval(() => {
      void fetchStatusAndDevices();
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleConnect = async (host: string, port: number) => {
    if (IS_ELECTRON && window.resostageElectron?.connectRemote) {
      await window.resostageElectron.connectRemote(host, port);
      setIsRemoteMode(true);
      setActiveRemoteHost(`${host}:${port}`);
    } else {
      window.location.href = `http://${host}:${port}/`;
    }
  };

  const handleDisconnect = async () => {
    if (IS_ELECTRON && window.resostageElectron?.disconnectRemote) {
      await window.resostageElectron.disconnectRemote();
      setIsRemoteMode(false);
      setActiveRemoteHost(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Active Remote Session Card */}
      {isRemoteMode && (
        <Card className="border-warning/50 bg-warning/10 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Radio className="h-5 w-5 text-warning animate-pulse" />
              <div>
                <div className="font-semibold text-warning">
                  Active Remote Session
                </div>
                <div className="text-xs text-foreground/70">
                  Connected to remote host: {activeRemoteHost || "Remote Device"} (Audio muted on local node)
                </div>
              </div>
            </div>
            <Button tone="warning" size="sm" onPress={handleDisconnect}>
              Disconnect & Return Local
            </Button>
          </div>
        </Card>
      )}

      {/* Discovery Toggle Card */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <Globe className="h-4 w-4 text-accent" />
              <span>Allow LAN Discovery & Remote Access</span>
            </div>
            <p className="text-xs text-foreground/60">
              When disabled, port 2899 is restricted to localhost (127.0.0.1) and LAN broadcasts are stopped.
            </p>
          </div>
          <Switch
            isSelected={discoveryEnabled}
            onChange={(checked) => setDiscoveryEnabled(checked)}
            aria-label="Toggle LAN Discovery"
          />
        </div>
      </Card>

      {/* Discovered LAN Devices */}
      <Card className="p-4">
        <div className="mb-4 flex items-center justify-between border-b border-default/20 pb-3">
          <div className="flex items-center gap-2 font-semibold">
            <Server className="h-4 w-4 text-accent" />
            <span>Discovered LAN Instances</span>
            {loading && <Spinner size="sm" className="ml-2" />}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => void fetchStatusAndDevices()}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Rescan
          </Button>
        </div>

        {devices.length === 0 ? (
          <div className="py-8 text-center text-xs text-foreground/50">
            No active ResoStage LAN instances discovered. Make sure other devices have discovery enabled.
          </div>
        ) : (
          <div className="space-y-2">
            {devices.map((dev, idx) => {
              const isCompatible = dev.protocolVersion === REQUIRED_PROTOCOL_VERSION;
              return (
                <div
                  key={`${dev.ip}-${dev.port}-${idx}`}
                  className="flex items-center justify-between rounded-lg bg-default/20 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Laptop className="h-5 w-5 text-foreground/70" />
                    <div>
                      <div className="flex items-center gap-2 font-medium text-sm">
                        <span>{dev.name}</span>
                        <Chip size="sm" variant="soft">
                          {dev.platform}
                        </Chip>
                        {isCompatible ? (
                          <Chip size="sm" color="success" variant="soft">
                            <ShieldCheck className="mr-1 inline h-3 w-3" />
                            v{dev.protocolVersion}
                          </Chip>
                        ) : (
                          <Chip size="sm" color="danger" variant="soft">
                            <ShieldAlert className="mr-1 inline h-3 w-3" />
                            Incompatible (v{dev.protocolVersion})
                          </Chip>
                        )}
                      </div>
                      <div className="text-xs text-foreground/50">
                        {dev.ip}:{dev.port}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    tone="accent-soft"
                    isDisabled={!isCompatible}
                    onPress={() => void handleConnect(dev.ip, dev.port)}
                  >
                    Connect
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Manual Connection Card */}
      <Card className="p-4">
        <div className="mb-3 font-semibold text-sm">Manual Connection</div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Host / IP (e.g. 192.168.5.117)"
            value={manualHost}
            onChange={(e) => setManualHost(e.target.value)}
            className="flex-1 rounded-lg border border-default/30 bg-default/20 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="text"
            placeholder="Port"
            value={manualPort}
            onChange={(e) => setManualPort(e.target.value)}
            className="w-24 rounded-lg border border-default/30 bg-default/20 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <Button
            size="sm"
            tone="accent-soft"
            isDisabled={!manualHost.trim()}
            onPress={() => void handleConnect(manualHost.trim(), parseInt(manualPort, 10) || 2899)}
          >
            Connect
          </Button>
        </div>
      </Card>
    </div>
  );
}
