import { Modal as HeroModal } from "@heroui/react";
import type { ComponentProps } from "react";

/**
 * App modal material.
 *
 * Every backdrop is blurred and every dialog uses the theme's `surface`
 * token. Keeping those defaults in this compound wrapper prevents feature
 * dialogs from gradually inventing their own overlay colors.
 */
type HeroModalProps = ComponentProps<typeof HeroModal>;
type HeroBackdropProps = ComponentProps<typeof HeroModal.Backdrop>;
type HeroDialogProps = ComponentProps<typeof HeroModal.Dialog>;

export type ModalProps = HeroModalProps;
export interface ModalBackdropProps
  extends Omit<HeroBackdropProps, "variant" | "className"> {
  className?: string;
}
export interface ModalDialogProps extends Omit<HeroDialogProps, "className"> {
  className?: string;
}

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
function ModalDialog({ className, ...props }: ModalDialogProps) {
  return (
    <HeroModal.Dialog
      className={classes("rs-modal-surface", className)}
      {...props}
    />
  );
}

export const Modal = Object.assign(ModalRoot, {
  Root: ModalRoot,
  Trigger: HeroModal.Trigger,
  Backdrop: ModalBackdrop,
  Container: HeroModal.Container,
  Dialog: ModalDialog,
  CloseTrigger: HeroModal.CloseTrigger,
  Header: HeroModal.Header,
  Icon: HeroModal.Icon,
  Heading: HeroModal.Heading,
  Body: HeroModal.Body,
  Footer: HeroModal.Footer,
});
