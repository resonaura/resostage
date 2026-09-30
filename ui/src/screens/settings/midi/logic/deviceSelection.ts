export function toggleDeviceSelection(selected: string[], deviceName: string): string[] {
  return selected.includes(deviceName)
    ? selected.filter((name) => name !== deviceName)
    : [...selected, deviceName];
}

export function toggleMidiInputSelection(selected: string[], deviceName: string): string[] {
  if (deviceName === "All Inputs")
    return selected.includes(deviceName) ? [] : [deviceName];

  const withoutAllInputs = selected.filter((name) => name !== "All Inputs");
  return toggleDeviceSelection(withoutAllInputs, deviceName);
}

export function sameDeviceSelection(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}
