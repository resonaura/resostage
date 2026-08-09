import { Tabs as HeroTabs } from "@heroui/react";
import { createContext, use, useMemo, type ComponentProps } from "react";
import { isTone, type Tone } from "./tones";

type HeroTabsRootProps = ComponentProps<typeof HeroTabs.Root>;

export type TabsVariant = "nav" | "ghost" | Tone;

export interface TabsProps extends Omit<HeroTabsRootProps, "variant"> {
  /**
   * Visual style variant or tone for Tabs:
   * - `nav`: Main navigation capsule style with surface indicator
   * - `ghost`: Transparent container style
   * - Tone (`accent`, `accent-soft`, `success`, `danger`, ...): Container with card surface background, indicator styled with the tone color
   */
  variant?: TabsVariant;
  tone?: Tone;
}

interface TabsContextValue {
  variant: TabsVariant;
}

const TabsContext = createContext<TabsContextValue>({
  variant: "ghost",
});

function splitVariant(
  variant: TabsVariant | undefined,
  tone: Tone | undefined,
): TabsVariant {
  if (tone) return tone;
  if (!variant) return "ghost";
  return variant;
}

function getToneClasses(variant: TabsVariant): {
  container: string;
  list: string;
} {
  if (variant === "nav") {
    return {
      container: "bg-transparent p-0 border-none rounded-none",
      list: [
        "bg-background-secondary p-1 rounded-full border-background-tertiary border-1",
        "**:data-[slot=tabs-tab]:rounded-full",
        "**:data-[slot=tabs-indicator]:rounded-full",
        "**:data-[slot=tabs-indicator]:bg-accent-soft",
        "**:data-[slot=tabs-indicator]:shadow-sm",
        "**:data-[slot=tabs-tab]:data-[selected=true]:text-accent-soft-foreground",
      ].join(" "),
    };
  }

  if (variant === "ghost") {
    return {
      container: "bg-transparent p-0 border-none rounded-none",
      list: "",
    };
  }

  if (isTone(variant)) {
    const listBase = [
      "border-background-tertiary border-1 p-1 rounded-full",
      "**:data-[slot=tabs-tab]:rounded-full",
      "**:data-[slot=tabs-indicator]:rounded-full",
      "**:data-[slot=tabs-indicator]:shadow-none",
    ].join(" ");

    switch (variant) {
      case "accent":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-accent",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-accent-foreground",
          ].join(" "),
        };
      case "accent-soft":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-accent-soft",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-accent-soft-foreground",
          ].join(" "),
        };
      case "success":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-success",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-success-foreground",
          ].join(" "),
        };
      case "success-soft":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-success-soft",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-success-soft-foreground",
          ].join(" "),
        };
      case "warning":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-warning",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-warning-foreground",
          ].join(" "),
        };
      case "warning-soft":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-warning-soft",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-warning-soft-foreground",
          ].join(" "),
        };
      case "danger":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-danger",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-danger-foreground",
          ].join(" "),
        };
      case "danger-soft":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-danger-soft",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-danger-soft-foreground",
          ].join(" "),
        };
      case "default":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-default",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-default-foreground",
          ].join(" "),
        };
      case "default-soft":
        return {
          container: "bg-transparent p-0 border-none rounded-none",
          list: [
            listBase,
            "**:data-[slot=tabs-indicator]:bg-default-soft",
            "**:data-[slot=tabs-tab]:data-[selected=true]:text-foreground",
          ].join(" "),
        };
    }
  }

  return { container: "", list: "" };
}

export function TabsRoot({
  variant,
  tone,
  className,
  children,
  ...rest
}: TabsProps) {
  const activeVariant = splitVariant(variant, tone);

  const value = useMemo(() => ({ variant: activeVariant }), [activeVariant]);

  return (
    <TabsContext value={value}>
      <HeroTabs.Root className={className} {...rest}>
        {children}
      </HeroTabs.Root>
    </TabsContext>
  );
}

export function TabsListContainer({
  className,
  children,
  ...rest
}: ComponentProps<typeof HeroTabs.ListContainer>) {
  const { variant } = use(TabsContext);
  const toneClasses = getToneClasses(variant);

  const containerClasses = [className, toneClasses.container]
    .filter(Boolean)
    .join(" ");

  return (
    <HeroTabs.ListContainer className={containerClasses} {...rest}>
      {children}
    </HeroTabs.ListContainer>
  );
}

export function TabsList({
  className,
  children,
  ...rest
}: ComponentProps<typeof HeroTabs.List>) {
  const { variant } = use(TabsContext);
  const toneClasses = getToneClasses(variant);

  const listClasses = [className, toneClasses.list].filter(Boolean).join(" ");

  return (
    <HeroTabs.List className={listClasses} {...rest}>
      {children}
    </HeroTabs.List>
  );
}

export const Tabs = Object.assign(TabsRoot, {
  ListContainer: TabsListContainer,
  List: TabsList,
  Tab: HeroTabs.Tab,
  Indicator: HeroTabs.Indicator,
  Separator: HeroTabs.Separator,
  Panel: HeroTabs.Panel,
});
