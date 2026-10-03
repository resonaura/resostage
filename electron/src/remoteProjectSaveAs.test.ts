/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it, vi } from "vitest";
import {
  exportRemoteProjectAs,
  type RemoteProjectSaveAsDependencies,
} from "@/remoteProjectSaveAs.js";

function createDependencies(
  overrides: Partial<RemoteProjectSaveAsDependencies> = {},
) {
  return {
    startExport: vi.fn(async () => ({ ok: true, status: 200 })),
    waitForExport: vi.fn(async () => ({ fileName: "Project.rsnraset" })),
    chooseDestination: vi.fn(async () => ({
      canceled: false,
      filePath: "/tmp/Project.rsnraset",
    })),
    downloadExport: vi.fn(async () => ({ ok: true, status: 200, bytes: new Uint8Array([1, 2]) })),
    writeFile: vi.fn(),
    showError: vi.fn(async () => undefined),
    cancelPendingSaveAs: vi.fn(async () => true),
    ...overrides,
  } satisfies RemoteProjectSaveAsDependencies;
}

describe("Remote project Save As lifecycle", () => {
  it("writes the downloaded project and settles Core without adopting the local path", async () => {
    const dependencies = createDependencies();
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.chooseDestination).toHaveBeenCalledWith("Project.rsnraset");
    expect(dependencies.writeFile).toHaveBeenCalledWith(
      "/tmp/Project.rsnraset",
      new Uint8Array([1, 2]),
    );
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("settles Core when the user cancels the local destination dialog", async () => {
    const dependencies = createDependencies({
      chooseDestination: vi.fn(async () => ({ canceled: true })),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.writeFile).not.toHaveBeenCalled();
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("settles Core and reports a remote export rejection", async () => {
    const dependencies = createDependencies({
      startExport: vi.fn(async () => ({ ok: false, status: 503 })),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.showError).toHaveBeenCalledWith(
      "Remote export failed",
      "The remote host could not start an export (HTTP 503).",
    );
    expect(dependencies.chooseDestination).not.toHaveBeenCalled();
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("does not offer a stale export when the remote render never becomes ready", async () => {
    const dependencies = createDependencies({
      waitForExport: vi.fn(async () => null),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.chooseDestination).not.toHaveBeenCalled();
    expect(dependencies.downloadExport).not.toHaveBeenCalled();
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("does not write and settles Core when the project download is rejected", async () => {
    const dependencies = createDependencies({
      downloadExport: vi.fn(async () => ({ ok: false, status: 503 })),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.writeFile).not.toHaveBeenCalled();
    expect(dependencies.showError).toHaveBeenCalledWith(
      "Download failed",
      "Could not download the exported project (HTTP 503).",
    );
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("settles Core when the native destination dialog rejects", async () => {
    const dependencies = createDependencies({
      chooseDestination: vi.fn(async () => {
        throw new Error("native dialog failed");
      }),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.showError).toHaveBeenCalledWith(
      "Remote project Save As failed",
      "native dialog failed",
    );
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("settles Core and reports a destination write failure", async () => {
    const dependencies = createDependencies({
      writeFile: vi.fn(() => {
        throw new Error("disk is full");
      }),
    });
    await exportRemoteProjectAs(dependencies);

    expect(dependencies.showError).toHaveBeenCalledWith(
      "Remote project Save As failed",
      "disk is full",
    );
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });

  it("does not let a message-box failure strand Core's pending callback", async () => {
    const dependencies = createDependencies({
      startExport: vi.fn(async () => ({ ok: false, status: 500 })),
      showError: vi.fn(async () => {
        throw new Error("window is gone");
      }),
    });
    await expect(exportRemoteProjectAs(dependencies)).resolves.toBeUndefined();
    expect(dependencies.cancelPendingSaveAs).toHaveBeenCalledOnce();
  });
});
