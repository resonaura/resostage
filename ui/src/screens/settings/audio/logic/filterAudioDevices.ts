/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SelectOption } from "@/components/ui";

export interface FilteredAudioDevices {
  outputDevices: string[];
  inputDevices: string[];
  currentOutputDevice: string;
  currentInputDevice: string;
  deviceOptions: SelectOption[];
  inputDeviceOptions: SelectOption[];
}

export function isLikelyInputOnlyDevice(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\b(microphone|mic|input)\b/.test(lower)) {
    if (!/\b(speaker|speakers|headphone|headphones|output)\b/.test(lower)) {
      return true;
    }
  }
  return false;
}

export function isLikelyOutputOnlyDevice(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\b(speaker|speakers|headphone|headphones|output|line out)\b/.test(lower)) {
    if (!/\b(microphone|mic|input)\b/.test(lower)) {
      return true;
    }
  }
  return false;
}

export function filterAudioDevices(params: {
  outputDevices?: string[];
  inputDevices?: string[];
  currentOutputDevice?: string;
  currentInputDevice?: string;
}): FilteredAudioDevices {
  const rawOutputs = params.outputDevices ?? [];
  const rawInputs = params.inputDevices ?? [];

  const inputOnlyNames = new Set(
    rawInputs.filter((inDev) => !rawOutputs.includes(inDev) || isLikelyInputOnlyDevice(inDev)),
  );
  const outputOnlyNames = new Set(
    rawOutputs.filter((outDev) => !rawInputs.includes(outDev) || isLikelyOutputOnlyDevice(outDev)),
  );

  const validOutputs = rawOutputs.filter(
    (d) => !inputOnlyNames.has(d) && !isLikelyInputOnlyDevice(d),
  );

  let currentOutput = params.currentOutputDevice ?? "";
  if (inputOnlyNames.has(currentOutput) || isLikelyInputOnlyDevice(currentOutput)) {
    currentOutput = validOutputs[0] ?? "";
  } else if (!currentOutput && validOutputs.length > 0) {
    currentOutput = validOutputs[0] ?? "";
  } else if (validOutputs.length > 0 && !validOutputs.includes(currentOutput)) {
    currentOutput = validOutputs[0] ?? "";
  }

  const outputDevices =
    validOutputs.length > 0
      ? validOutputs
      : currentOutput && !inputOnlyNames.has(currentOutput) && !isLikelyInputOnlyDevice(currentOutput)
        ? [currentOutput]
        : [];

  const deviceOptions: SelectOption[] = [
    ...(currentOutput && !outputDevices.includes(currentOutput)
      ? [{ id: currentOutput, label: currentOutput }]
      : []),
    ...outputDevices.map((d) => ({ id: d, label: d })),
  ];

  const validInputs = rawInputs.filter(
    (d) => !outputOnlyNames.has(d) && !isLikelyOutputOnlyDevice(d),
  );

  let currentInput = params.currentInputDevice ?? "";
  if (outputOnlyNames.has(currentInput) || isLikelyOutputOnlyDevice(currentInput)) {
    currentInput = "";
  }

  const inputDevices =
    validInputs.length > 0
      ? validInputs
      : currentInput && !outputOnlyNames.has(currentInput) && !isLikelyOutputOnlyDevice(currentInput)
        ? [currentInput]
        : [];

  const inputDeviceOptions: SelectOption[] = [
    { id: "", label: "None (Disabled)" },
    ...(currentInput && !inputDevices.includes(currentInput)
      ? [{ id: currentInput, label: currentInput }]
      : []),
    ...inputDevices.map((d) => ({ id: d, label: d })),
  ];

  return {
    outputDevices,
    inputDevices,
    currentOutputDevice: currentOutput,
    currentInputDevice: currentInput,
    deviceOptions,
    inputDeviceOptions,
  };
}
