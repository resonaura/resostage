// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

/**
 * Return the list order that a drag would produce, without mutating the live
 * list. `dropSlot` is measured before removal, so forward moves subtract one
 * from the slot to account for the item being removed first.
 */
export function previewDropReorder<T>(
  items: T[],
  fromIndex: number,
  dropSlot: number,
): T[] {
  const toIndex = dropSlot > fromIndex ? dropSlot - 1 : dropSlot;
  if (
    toIndex === fromIndex ||
    fromIndex < 0 ||
    fromIndex >= items.length
  ) {
    return items;
  }

  const preview = [...items];
  const [moved] = preview.splice(fromIndex, 1);
  preview.splice(toIndex, 0, moved);
  return preview;
}
