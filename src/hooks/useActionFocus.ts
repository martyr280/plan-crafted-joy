import { useCallback, useEffect, useMemo, useRef } from "react";

type Owner = { id: number; trigger: HTMLElement | null; abandoned: boolean };

/**
 * Focus ownership for one async action at a time.
 *
 * `claim(trigger)` when the action starts. While it runs, focusing or typing
 * in anything other than the trigger gives ownership up. `restore(el)` then
 * moves focus to `el` only when the action still owns focus and focus was lost
 * (it sits on BODY because the trigger was disabled or unmounted). It never
 * pulls focus away from a control the user is on.
 */
export function useActionFocus() {
  const owner = useRef<Owner | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const giveUp = (e: Event) => {
      const o = owner.current;
      if (!o || o.abandoned) return;
      const t = e.target;
      if (t === o.trigger || t === document.body || t === document || t === window) return;
      o.abandoned = true;
    };
    document.addEventListener("focusin", giveUp, true);
    document.addEventListener("keydown", giveUp, true);
    document.addEventListener("input", giveUp, true);
    return () => {
      document.removeEventListener("focusin", giveUp, true);
      document.removeEventListener("keydown", giveUp, true);
      document.removeEventListener("input", giveUp, true);
    };
  }, []);

  const claim = useCallback((trigger: HTMLElement | null): number => {
    const id = ++seq.current;
    owner.current = { id, trigger, abandoned: false };
    return id;
  }, []);

  const owns = useCallback((id: number): boolean => {
    const o = owner.current;
    if (!o || o.id !== id || o.abandoned) return false;
    const active = document.activeElement;
    return active == null || active === document.body;
  }, []);

  const restore = useCallback(
    (id: number, el: HTMLElement | null | undefined): boolean => {
      const ok = owns(id) && !!el?.isConnected;
      if (owner.current?.id === id) owner.current = null;
      if (!ok || !el) return false;
      el.focus();
      return document.activeElement === el;
    },
    [owns],
  );

  return useMemo(() => ({ claim, restore }), [claim, restore]);
}
