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
