import { useEffect, useRef, useState } from "react";
import type { WebUiState } from "@/lib/state/types";

export interface HardwareAlarmToast {
  id: string;
  title: string;
  message: string;
}

/** Converts post-startup hardware alarm edges into short-lived shell notifications. */
export function useHardwareAlarmToasts(hardwareAlarm: WebUiState["hardwareAlarm"]) {
  const [notifications, setNotifications] = useState<HardwareAlarmToast[]>([]);
  const isInitialLoadRef = useRef(true);
  const prevAlarmRef = useRef(hardwareAlarm);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevAlarmRef.current = hardwareAlarm;
      return;
    }

    if (!prevAlarmRef.current && hardwareAlarm) {
      const id = Date.now().toString();
      setNotifications((previous) => [
        ...previous,
        {
          id,
          title: "Audio Device Error",
          message: "AUDIO DEVICE DISCONNECTED -- fell back to default output",
        },
      ]);

      const timer = setTimeout(() => {
        setNotifications((previous) => previous.filter((toast) => toast.id !== id));
      }, 5000);

      return () => clearTimeout(timer);
    }

    prevAlarmRef.current = hardwareAlarm;
  }, [hardwareAlarm]);

  const dismiss = (id: string) =>
    setNotifications((previous) => previous.filter((toast) => toast.id !== id));

  return { notifications, dismiss };
}
