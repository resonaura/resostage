// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Tabs } from "@heroui/react";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

const el = createElement(
  Tabs.Root,
  { className: "tabs rs-tone rs-tone--accent-soft" },
  createElement(
    Tabs.ListContainer,
    null,
    createElement(
      Tabs.List,
      null,
      createElement(
        Tabs.Tab,
        { id: "a" },
        "A",
        createElement(Tabs.Indicator, null)
      )
    )
  )
);

console.log(renderToString(el));
