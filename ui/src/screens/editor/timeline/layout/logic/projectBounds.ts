/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Free canvas past the end of the last song.
 *
 * Out of bounds, not part of the project: the transport will not run into it
 * and it is drawn dimmed. It exists so the last song's end marker has
 * somewhere to be dragged TO -- you cannot extend a song into space that
 * isn't there -- and so the arrangement does not feel like it hits a wall.
 *
 * Both a time and a pixel floor, because either alone breaks at an extreme of
 * the zoom range: 30s is invisible at MIN_PX_PER_SEC, and 240px is a
 * meaningless sliver of a set at MAX_PX_PER_SEC.
 */
export const TRAILING_SLACK_SECONDS = 30;
export const TRAILING_SLACK_MIN_PX = 240;
