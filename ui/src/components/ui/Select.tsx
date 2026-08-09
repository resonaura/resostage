import {
  Header,
  ListBox as HeroListBox,
  Select as HeroSelect,
} from "@heroui/react";
import { useMemo, type ComponentProps, type ReactNode } from "react";
import { toneClass, type Tone } from "./tones";

/**
 * Select driven by a plain option list.
 *
 * HeroUI ships Select as five compound parts (Root / Trigger / Value /
 * Indicator / Popover) plus a ListBox, which is the right shape for a bespoke
 * picker and far too much ceremony for the ~10 places this app needs "a value,
 * a list of labels, tell me when it changes". Those places were all still
 * native `<select>` for exactly that reason, which meant OS-drawn popups that
 * ignore the theme, cannot be sized down for a mixer strip, and get clipped by
 * the console's own scroll containers.
 *
 * So the selection API here is a plain string, not React Aria's `Key`: every
 * option this app offers is already identified by a string id (a bus id, a
 * device name, a channel option id), and threading `Key | null` through each
 * call site bought nothing. The compound parts are still exported for anything
 * that genuinely needs to build its own trigger.
 */

export interface SelectOption {
  /** Stable value handed back to `onChange`. */
  id: string;
  label: ReactNode;
  /** Typeahead / accessible text; required when `label` is not a string. */
  textValue?: string;
  isDisabled?: boolean;
  /**
   * Heading this option sits under. Consecutive options naming the same
   * section share one heading -- the list is not re-sorted, so the caller's
   * order is exactly the order shown.
   */
  section?: string;
}

/**
 * Density, not a tone: `xs` is the mixer strip (22px, 9px type -- the same
 * footprint the native routing selects had, so faders stay level across
 * strips), `sm` is dense panel chrome, `md` is HeroUI's own field size.
 */
export type SelectSize = "xs" | "sm" | "md";

const SIZE_CLASS: Record<SelectSize, string> = {
  xs: "rs-select--xs",
  sm: "rs-select--sm",
  md: "",
};

// The popover is portalled to the document root, so it is NOT a descendant of
// the select and cannot inherit the size class through the DOM.
const POPOVER_SIZE_CLASS: Record<SelectSize, string> = {
  xs: "rs-select-popover--xs",
  sm: "rs-select-popover--sm",
  md: "",
};

type HeroSelectRootProps = ComponentProps<typeof HeroSelect.Root>;

export interface SelectProps
  extends Omit<
    HeroSelectRootProps,
    | "children"
    | "className"
    | "defaultSelectedKey"
    | "items"
    // React Aria's own value/onChange are Key-shaped aliases of
    // selectedKey/onSelectionChange; this wrapper reuses those two names for
    // its plain-string API, so both spellings must be taken over at once.
    | "onChange"
    | "onSelectionChange"
    | "selectedKey"
    | "value"
  > {
  options: readonly SelectOption[];
  /** Selected option id. An id not present in `options` shows the placeholder. */
  value?: string;
  onChange?: (value: string) => void;
  /** Defaults to `md`; see SelectSize. */
  size?: SelectSize;
  tone?: Tone;
  /** Rendered inside the closed control, before the value (status icons). */
  startContent?: ReactNode;
  /** Native tooltip; see the note where it is applied. */
  title?: string;
  className?: string;
  /** Extra classes on the button itself. */
  triggerClassName?: string;
  /** Extra classes on the dropdown surface. */
  popoverClassName?: string;
}

interface OptionGroup {
  section: string | undefined;
  options: SelectOption[];
}

/** Runs of consecutive options sharing a `section`, in the caller's order. */
function groupOptions(options: readonly SelectOption[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.section === option.section) last.options.push(option);
    else groups.push({ section: option.section, options: [option] });
  }
  return groups;
}

function cx(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter(Boolean).join(" ");
  return joined || undefined;
}

function OptionItem({ option }: { option: SelectOption }) {
  return (
    <HeroListBox.Item
      id={option.id}
      textValue={
        option.textValue ??
        (typeof option.label === "string" ? option.label : option.id)
      }
      isDisabled={option.isDisabled}
    >
      {option.label}
    </HeroListBox.Item>
  );
}

function SelectRoot({
  options,
  value,
  onChange,
  size = "md",
  tone,
  startContent,
  title,
  className,
  triggerClassName,
  popoverClassName,
  fullWidth = true,
  ...rest
}: SelectProps) {
  const groups = useMemo(() => groupOptions(options), [options]);

  // React Aria treats an unknown key as "nothing selected" but warns about it
  // on every render. Resolving it here means a control pointed at a value the
  // list no longer offers (a device that vanished, a bus that was deleted)
  // falls back to the placeholder quietly, which is what the native select
  // did.
  const selectedKey =
    value !== undefined && options.some((o) => o.id === value) ? value : null;

  const select = (
    <HeroSelect
      {...rest}
      fullWidth={fullWidth}
      selectedKey={selectedKey}
      onSelectionChange={(key) => {
        if (key !== null && key !== undefined) onChange?.(String(key));
      }}
      className={cx(toneClass(tone), SIZE_CLASS[size], className)}
    >
      <HeroSelect.Trigger className={triggerClassName}>
        {startContent !== undefined && startContent !== null && (
          // Wrapped rather than rendered bare so the gap between a status icon
          // and the value is one rule in the stylesheet instead of a margin
          // every caller has to remember.
          <span className="rs-select-start">{startContent}</span>
        )}
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover
        className={cx(POPOVER_SIZE_CLASS[size], popoverClassName)}
      >
        <HeroListBox>
          {groups.map((group, i) =>
            group.section === undefined ? (
              group.options.map((option) => (
                <OptionItem key={option.id} option={option} />
              ))
            ) : (
              <HeroListBox.Section key={`${group.section}:${i}`}>
                <Header>{group.section}</Header>
                {group.options.map((option) => (
                  <OptionItem key={option.id} option={option} />
                ))}
              </HeroListBox.Section>
            ),
          )}
        </HeroListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );

  // React Aria runs every prop through filterDOMProps, which drops `title` --
  // on the root and on the trigger alike. A tooltip is resolved by walking up
  // from the hovered element, so an ancestor carrying it works; `display:
  // contents` keeps that ancestor out of layout entirely, so a select inside a
  // flex column is laid out exactly as it is without a tooltip.
  if (!title) return select;
  return (
    <div className="contents" title={title}>
      {select}
    </div>
  );
}

// Compound component, same shape HeroUI itself exports. The lint rule can't
// see a component through Object.assign.
// eslint-disable-next-line react/only-export-components
export const Select = Object.assign(SelectRoot, {
  Root: HeroSelect.Root,
  Trigger: HeroSelect.Trigger,
  Value: HeroSelect.Value,
  Indicator: HeroSelect.Indicator,
  Popover: HeroSelect.Popover,
  List: HeroListBox,
  Item: HeroListBox.Item,
  Section: HeroListBox.Section,
});
