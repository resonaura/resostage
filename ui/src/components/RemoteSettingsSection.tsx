import { Chip, Spinner } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Globe, Laptop, Radio, RefreshCw, Server, ShieldCheck, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Switch } from "./ui";
import { IS_ELECTRON } from "../lib/electron";
import { apiFetch, setRemoteBackend } from "../lib/backend";

interface DiscoveredDevice {
  name: string;
  platform: string;
  ip: string;
  port: number;
  protocolVersion: string;
  discoveryEnabled: boolean;
}

import type { Variants } from "framer-motion";

const REQUIRED_PROTOCOL_VERSION = "1.0.0";

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
};

const deviceItemVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring", stiffness: 400, damping: 28 },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -8,
    transition: { duration: 0.2, ease: "easeInOut" },
  },
};

export function RemoteSettingsSection() {
  const [discoveryEnabled, setDiscoveryEnabled] = useState(true);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("2899");
  const [isRemoteMode, setIsRemoteMode] = useState(false);
  const [activeRemoteHost, setActiveRemoteHost] = useState<string | null>(null);
  const isTogglingRef = useRef(false);

  const fetchStatusAndDevices = async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      // 1. Fetch discovery toggle state (only if not actively toggling)
      if (!isTogglingRef.current) {
        if (IS_ELECTRON && window.resostageElectron?.getDiscoveryEnabled) {
          const enabled = await window.resostageElectron.getDiscoveryEnabled();
          if (!isTogglingRef.current) setDiscoveryEnabled(enabled);
        } else {
          try {
            const discRes = await apiFetch("/api/v1/remote/discovery");
            if (discRes.ok) {
              const data = await discRes.json<{ enabled?: boolean }>();
              if (typeof data?.enabled === "boolean" && !isTogglingRef.current) {
                setDiscoveryEnabled(data.enabled);
              }
            }
          } catch {
            /* fallback */
          }
        }
      }

      // 2. Fetch discovered devices
      let list: DiscoveredDevice[] = [];
      if (IS_ELECTRON && window.resostageElectron?.getDiscoveredDevices) {
        try {
          const electronList = await window.resostageElectron.getDiscoveredDevices();
          if (Array.isArray(electronList)) list = electronList;
        } catch {}
      }
      if (!list || list.length === 0) {
        try {
          const res = await apiFetch("/api/v1/remote/discovered-devices");
          if (res.ok) {
            const data = await res.json<DiscoveredDevice[]>();
            if (Array.isArray(data)) list = data;
          }
        } catch {
          /* fallback */
        }
      }
      setDevices(Array.isArray(list) ? list : []);

      if (IS_ELECTRON && window.resostageElectron?.getRemoteStatus) {
        const status = await window.resostageElectron.getRemoteStatus();
        setIsRemoteMode(Boolean(status?.isRemoteMode));
        if (status?.activeRemoteHost) {
          setRemoteBackend(status.activeRemoteHost);
          setActiveRemoteHost(status.activeRemoteHost);
        } else if (!status?.isRemoteMode) {
          setRemoteBackend(null);
          setActiveRemoteHost(null);
        }
      }
    } catch {
      /* ignore */
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const handleToggleDiscovery = async (enabled: boolean) => {
    isTogglingRef.current = true;
    setDiscoveryEnabled(enabled);
    try {
      if (IS_ELECTRON && window.resostageElectron?.setDiscoveryEnabled) {
        await window.resostageElectron.setDiscoveryEnabled(enabled);
      } else {
        await apiFetch("/api/v1/remote/discovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
      }
    } catch {
      /* fallback */
    } finally {
      setTimeout(() => {
        isTogglingRef.current = false;
      }, 1000);
    }
  };

  // Rescan every 1 second when the Remote Settings tab is open
  useEffect(() => {
    void fetchStatusAndDevices(true);
    const interval = setInterval(() => {
      void fetchStatusAndDevices(false);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get("remote");
    if (r) {
      setRemoteBackend(r);
      setIsRemoteMode(true);
      setActiveRemoteHost(r);
    } else if (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      setRemoteBackend(window.location.host);
      setIsRemoteMode(true);
      setActiveRemoteHost(window.location.host);
    }
  }, []);

  const handleConnect = async (rawHost: string, defaultPort: number) => {
    let host = rawHost.trim().replace(/^https?:\/\//i, "").replace(/^wss?:\/\//i, "").replace(/\/+.*$/, "");
    let port = defaultPort || 2899;
    if (host.includes(":")) {
      const parts = host.split(":");
      host = parts[0];
      const parsedPort = parseInt(parts[1], 10);
      if (!isNaN(parsedPort) && parsedPort > 0) {
        port = parsedPort;
      }
    }
    if (!host) return;

    const target = `${host}:${port}`;
    setRemoteBackend(target);
    setIsRemoteMode(true);
    setActiveRemoteHost(target);

    if (IS_ELECTRON && window.resostageElectron?.connectRemote) {
      await window.resostageElectron.connectRemote(host, port);
    }
  };

  const handleDisconnect = async () => {
    setRemoteBackend(null);
    setIsRemoteMode(false);
    setActiveRemoteHost(null);

    if (IS_ELECTRON && window.resostageElectron?.disconnectRemote) {
      await window.resostageElectron.disconnectRemote();
    }
  };

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Active Remote Session Banner */}
      <AnimatePresence>
        {isRemoteMode && (
          <motion.div
            key="active-remote-banner"
            initial={{ opacity: 0, height: 0, scale: 0.98 }}
            animate={{ opacity: 1, height: "auto", scale: 1 }}
            exit={{ opacity: 0, height: 0, scale: 0.98 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <Card className="border-warning/50 bg-warning/10 p-4 shadow-sm">
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
          </motion.div>
        )}
      </AnimatePresence>

      {/* Discovery Toggle Card */}
      <motion.div variants={cardVariants}>
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
              onChange={(checked) => void handleToggleDiscovery(checked)}
              aria-label="Toggle LAN Discovery"
            />
          </div>
        </Card>
      </motion.div>

      {/* Discovered LAN Devices */}
      <motion.div variants={cardVariants}>
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
              onPress={() => void fetchStatusAndDevices(true)}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Rescan
            </Button>
          </div>

          <AnimatePresence mode="wait">
            {devices.length === 0 ? (
              <motion.div
                key="empty-state"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="py-8 text-center text-xs text-foreground/50"
              >
                No active ResoStage LAN instances discovered. Make sure other devices have discovery enabled.
              </motion.div>
            ) : (
              <motion.div key="devices-list" layout className="space-y-2">
                <AnimatePresence>
                  {devices.map((dev) => {
                    const isCompatible = dev.protocolVersion === REQUIRED_PROTOCOL_VERSION;
                    const itemKey = `${dev.ip}:${dev.port}`;
                    const isCurrentActive =
                      isRemoteMode &&
                      (activeRemoteHost === itemKey ||
                        activeRemoteHost === dev.ip ||
                        (activeRemoteHost != null && activeRemoteHost.startsWith(`${dev.ip}:`)));
                    return (
                      <motion.div
                        key={itemKey}
                        layout
                        variants={deviceItemVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        whileHover={{ scale: 1.008, transition: { duration: 0.15 } }}
                        className={`flex items-center justify-between rounded-lg border p-3.5 backdrop-blur-sm transition-colors ${
                          isCurrentActive
                            ? "border-warning/50 bg-warning/10"
                            : "border-default/10 bg-default/20 hover:border-default/30 hover:bg-default/30"
                        }`}
                      >
                        <div className="flex items-center gap-3.5">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                              isCurrentActive ? "bg-warning/20 text-warning" : "bg-accent/10 text-accent"
                            }`}
                          >
                            <Laptop className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 font-medium text-sm">
                              <span className="font-semibold">{dev.name}</span>
                              <Chip size="sm" variant="soft">
                                {dev.platform}
                              </Chip>
                              {isCurrentActive ? (
                                <Chip size="sm" color="warning" variant="soft">
                                  <Radio className="mr-1 inline h-3 w-3 animate-pulse" />
                                  Connected
                                </Chip>
                              ) : isCompatible ? (
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
                            <div className="mt-0.5 text-xs text-foreground/50">
                              {dev.ip}:{dev.port}
                            </div>
                          </div>
                        </div>
                        {isCurrentActive ? (
                          <Button
                            size="sm"
                            tone="warning"
                            onPress={handleDisconnect}
                          >
                            Disconnect
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            tone="accent-soft"
                            isDisabled={!isCompatible}
                            onPress={() => void handleConnect(dev.ip, dev.port)}
                          >
                            Connect
                          </Button>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>
      </motion.div>

      {/* Manual Connection Card */}
      <motion.div variants={cardVariants}>
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
      </motion.div>
    </motion.div>
  );
}
