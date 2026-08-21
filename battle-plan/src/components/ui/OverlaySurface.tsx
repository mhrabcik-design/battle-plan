import { motion } from 'framer-motion';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const overlayStack: string[] = [];
let modalCount = 0;
let previousBodyOverflow = '';
const inertedElements = new Map<HTMLElement, boolean>();

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type OverlaySurfaceProps = {
  children: ReactNode;
  title: string;
  onRequestClose: () => void;
  variant?: 'dialog' | 'sheet';
  className?: string;
  closeOnBackdrop?: boolean;
};

export function OverlaySurface({
  children,
  title,
  onRequestClose,
  variant = 'dialog',
  className = '',
  closeOnBackdrop = true,
}: OverlaySurfaceProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onRequestClose);
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.dataset.overlayHost = id;
    return element;
  });

  useEffect(() => {
    closeRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host, id]);

  useEffect(() => {
    overlayStack.push(id);
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalCount += 1;
    if (modalCount === 1) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement) || child === host) continue;
        inertedElements.set(child, child.inert);
        child.inert = true;
      }
    }

    const focusPanel = requestAnimationFrame(() => {
      const autofocus = panelRef.current?.querySelector<HTMLElement>('[autofocus]');
      const first = autofocus ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first ?? panelRef.current)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (overlayStack.at(-1) !== id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(focusPanel);
      document.removeEventListener('keydown', onKeyDown, true);
      const index = overlayStack.lastIndexOf(id);
      if (index >= 0) overlayStack.splice(index, 1);
      modalCount = Math.max(0, modalCount - 1);
      if (modalCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
        for (const [element, previous] of inertedElements) element.inert = previous;
        inertedElements.clear();
      }
      requestAnimationFrame(() => returnFocusRef.current?.isConnected && returnFocusRef.current.focus());
    };
  }, [host, id]);

  const panelMotion = variant === 'sheet'
    ? { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 18 } }
    : { initial: { opacity: 0, y: 16, scale: 0.985 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 10, scale: 0.99 } };

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className={`fixed inset-0 z-[200] flex bg-slate-950/80 backdrop-blur-md ${variant === 'sheet' ? 'items-stretch justify-end md:left-64' : 'items-center justify-center p-4'}`}
      onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onRequestClose(); }}
    >
      <motion.div
        {...panelMotion}
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.7 }}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={className}
      >
        <h2 id={titleId} className="sr-only">{title}</h2>
        {children}
      </motion.div>
    </motion.div>,
    host,
  );
}
