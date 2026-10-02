/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export interface CommandQueueLimits {
  maxPendingCommands: number;
  maxRetainedPayloadBytes: number;
}

/** Serializes reliable renderer commands while bounding their retained bodies. */
export class BoundedCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCommands = 0;
  private retainedPayloadBytes = 0;
  private readonly limits: CommandQueueLimits;

  constructor(limits: CommandQueueLimits) {
    this.limits = limits;
  }

  get pendingCount(): number {
    return this.pendingCommands;
  }

  get retainedBytes(): number {
    return this.retainedPayloadBytes;
  }

  run<T>(payloadBytes: number, command: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
      return Promise.reject(new Error("Invalid Core command payload size"));
    }
    if (this.pendingCommands >= this.limits.maxPendingCommands) {
      return Promise.reject(new Error("Too many pending Core commands"));
    }
    if (payloadBytes > this.limits.maxRetainedPayloadBytes - this.retainedPayloadBytes) {
      return Promise.reject(new Error("Pending Core command payload limit exceeded"));
    }

    ++this.pendingCommands;
    this.retainedPayloadBytes += payloadBytes;
    const request = this.tail.then(command).finally(() => {
      --this.pendingCommands;
      this.retainedPayloadBytes -= payloadBytes;
    });
    this.tail = request.then(() => undefined, () => undefined);
    return request;
  }
}

/** Counts the UTF-8 bytes fetch transmits without allocating a second body copy. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ++index) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      ++bytes;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff
      && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        ++index;
      } else {
        bytes += 3;
      }
    } else {
      // Lone low surrogates are encoded as U+FFFD by UTF-8 encoders.
      bytes += 3;
    }
  }
  return bytes;
}

/** Builds a deterministic per-target key without fields that carry drag values. */
export function coalescingTargetKey(
  path: string,
  body: unknown,
  changingFields: ReadonlySet<string>,
  serializedBody: string,
): string {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return `${path}:${serializedBody}`;
  const identity = Object.entries(body as Record<string, unknown>)
    .filter(([field, value]) => value !== undefined && !changingFields.has(field))
    .sort(([left], [right]) => left.localeCompare(right));
  return `${path}:${JSON.stringify(identity)}`;
}
