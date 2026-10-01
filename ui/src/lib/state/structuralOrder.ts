/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { WebUiState } from "@/lib/state/types";

/** Orders HTTP/WS structural snapshots independently of latest-wins UDP. */
export class StructuralSnapshotOrder {
  private session = "";
  private revision = -1;
  private retiredSessions: string[] = [];
  private connectionGeneration = 0;
  private lastRequest = 0;

  reset(): void {
    ++this.connectionGeneration;
    this.session = "";
    this.revision = -1;
    this.retiredSessions = [];
    this.lastRequest = 0;
  }
  generation(): number { return this.connectionGeneration; }
  accept(snapshot: Partial<WebUiState>, generation: number, request = 0): boolean {
    if (generation !== this.connectionGeneration || (request > 0 && request < this.lastRequest)) return false;
    const session = snapshot.stateSessionId;
    if (session && this.retiredSessions.includes(session)) return false;
    if (session && this.session !== session) {
      if (this.session) this.retiredSessions = [...this.retiredSessions.slice(-3), this.session];
      this.session = session;
      this.revision = -1;
    }
    const revision = snapshot.stateRevision;
    if (revision !== undefined && revision < this.revision) return false;
    if (revision !== undefined) this.revision = revision;
    if (request > 0) this.lastRequest = request;
    return true;
  }
}
