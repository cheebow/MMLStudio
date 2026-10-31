import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuItem {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  /** shown as a tooltip (e.g. why the item is disabled) */
  title?: string;
  /** a separator line before this item */
  separatorBefore?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * Header menu bar (SPEC 6.2). WAI-ARIA menu button pattern: Enter / Space / ↓ open a menu,
 * ↑ ↓ Home End move, ← → switch menus, Esc closes and returns focus, a click outside closes.
 */
export function MenuBar({ menus, label }: { menus: Menu[]; label: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [focusItem, setFocusItem] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();

  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (open !== null) itemRefs.current[focusItem]?.focus();
  }, [open, focusItem]);

  const enabled = (m: number) => menus[m].items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const openMenu = (m: number, where: 'first' | 'last' = 'first') => {
    const e = enabled(m);
    setFocusItem(where === 'first' ? (e[0] ?? 0) : (e[e.length - 1] ?? 0));
    setOpen(m);
  };
  const close = (focusButton: boolean) => {
    const m = open;
    setOpen(null);
    if (focusButton && m !== null) buttonRefs.current[m]?.focus();
  };

  const onButtonKey = (e: KeyboardEvent, m: number) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(m);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(m, 'last');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      buttonRefs.current[(m + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length]?.focus();
    }
  };
  const onMenuKey = (e: KeyboardEvent, m: number) => {
    const e2 = enabled(m);
    const pos = e2.indexOf(focusItem);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusItem(e2[(pos + 1) % e2.length]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusItem(e2[(pos - 1 + e2.length) % e2.length]);
        break;
      case 'Home':
        e.preventDefault();
        setFocusItem(e2[0]);
        break;
      case 'End':
        e.preventDefault();
        setFocusItem(e2[e2.length - 1]);
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const next = (m + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length;
        buttonRefs.current[next]?.focus();
        openMenu(next);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(null);
        break;
    }
  };
  const select = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  return (
    <nav className="menubar" aria-label={label} ref={rootRef}>
      {menus.map((menu, m) => (
        <div key={menu.label} className="menu">
          <button
            ref={(el) => {
              buttonRefs.current[m] = el;
            }}
            type="button"
            className="menu-button"
            id={`${id}-b${m}`}
            aria-haspopup="menu"
            aria-expanded={open === m}
            aria-controls={open === m ? `${id}-m${m}` : undefined}
            onClick={() => (open === m ? setOpen(null) : openMenu(m))}
            onPointerEnter={() => {
              if (open !== null && open !== m) openMenu(m);
            }}
            onKeyDown={(e) => onButtonKey(e, m)}
          >
            {menu.label} <span aria-hidden="true">▾</span>
          </button>
          {open === m && (
            <div className="menu-list" role="menu" id={`${id}-m${m}`} aria-labelledby={`${id}-b${m}`} onKeyDown={(e) => onMenuKey(e, m)}>
              {menu.items.map((item, i) => (
                <div key={item.label} role="none">
                  {item.separatorBefore && <div className="menu-sep" role="separator" />}
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    tabIndex={focusItem === i ? 0 : -1}
                    aria-disabled={item.disabled || undefined}
                    title={item.title}
                    onClick={() => select(item)}
                    onPointerEnter={() => !item.disabled && setFocusItem(i)}
                  >
                    {item.label}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
