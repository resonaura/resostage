import { Modal as HeroModal } from "@heroui/react";
import { createContext, use, type ComponentProps } from "react";

/**
 * App modal material.
 *
 * Every backdrop is blurred and every dialog uses the theme's `surface`
 * token. Keeping those defaults in this compound wrapper prevents feature
 * dialogs from gradually inventing their own overlay colors.
 */
type HeroModalProps = ComponentProps<typeof HeroModal>;
type HeroBackdropProps = ComponentProps<typeof HeroModal.Backdrop>;
type HeroContainerProps = ComponentProps<typeof HeroModal.Container>;
type HeroDialogProps = ComponentProps<typeof HeroModal.Dialog>;

export type ModalProps = HeroModalProps;
export interface ModalBackdropProps
  extends Omit<HeroBackdropProps, "variant" | "className"> {
  className?: string;
}

export type ModalSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | "2xl"
  | "3xl"
  | "4xl"
  | "cover"
  | "full";

export interface ModalContainerProps extends Omit<HeroContainerProps, "size"> {
  size?: ModalSize;
}

export interface ModalDialogProps extends Omit<HeroDialogProps, "className"> {
  className?: string;
}

const EXTENDED_SIZE_CLASSES: Record<string, string> = {
  xl: "sm:max-w-xl",
  "2xl": "sm:max-w-2xl",
  "3xl": "sm:max-w-3xl",
  "4xl": "sm:max-w-4xl",
};

const ModalSizeContext = createContext<ModalSize | undefined>(undefined);

function classes(base: string, extra?: string) {
  return [base, extra].filter(Boolean).join(" ");
}

// Exported below as one HeroUI-compatible compound component.
// eslint-disable-next-line react/only-export-components
function ModalRoot(props: ModalProps) {
  return <HeroModal {...props} />;
}

// eslint-disable-next-line react/only-export-components
function ModalBackdrop({ className, ...props }: ModalBackdropProps) {
  return (
    <HeroModal.Backdrop
      variant="blur"
      className={classes("rs-modal-backdrop", className)}
      {...props}
    />
  );
}

// eslint-disable-next-line react/only-export-components
function ModalContainer({ size, className, ...props }: ModalContainerProps) {
  const isExtended = size && size in EXTENDED_SIZE_CLASSES;
  const heroSize = isExtended
    ? undefined
    : (size as HeroContainerProps["size"]);
  return (
    <ModalSizeContext value={size}>
      <HeroModal.Container
        size={heroSize}
        className={className}
        {...props}
      />
    </ModalSizeContext>
  );
}

// eslint-disable-next-line react/only-export-components
function ModalDialog({ className, ...props }: ModalDialogProps) {
  const size = use(ModalSizeContext);
  const sizeClass =
    size && size in EXTENDED_SIZE_CLASSES
      ? EXTENDED_SIZE_CLASSES[size]
      : undefined;
  return (
    <HeroModal.Dialog
      className={classes("rs-modal-surface", classes(sizeClass ?? "", className))}
      {...props}
    />
  );
}

export const Modal = Object.assign(ModalRoot, {
  Root: ModalRoot,
  Trigger: HeroModal.Trigger,
  Backdrop: ModalBackdrop,
  Container: ModalContainer,
  Dialog: ModalDialog,
  CloseTrigger: HeroModal.CloseTrigger,
  Header: HeroModal.Header,
  Icon: HeroModal.Icon,
  Heading: HeroModal.Heading,
  Body: HeroModal.Body,
  Footer: HeroModal.Footer,
});
