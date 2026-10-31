import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

/** Accessible modal built on <dialog> (focus trapping and Esc handled by the browser). */
export function Modal({ open, title, onClose, children, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} aria-labelledby="modal-title" onClose={onClose} onCancel={onClose}>
      <header className="modal-header">
        <h2 id="modal-title">{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </header>
      <div className="modal-body">{open && children}</div>
    </dialog>
  );
}
