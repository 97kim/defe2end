"use client";

import { useRef, type ReactNode } from "react";

// React side of transitions.css: re-mount a piece when its value changes so the CSS enter animation runs.
// The first render never animates (a page full of badges shouldn't all move on load).

export interface ChangeState {
  value: unknown;
  count: number;
}

/** Counts changes of a value (pure; the hook below keeps the state between renders). */
export function nextChange(state: ChangeState, value: unknown): ChangeState {
  return Object.is(state.value, value) ? state : { value, count: state.count + 1 };
}

/** `key` changes with `value`; `changed` is false until the value first changes after mount. */
export function useChangeKey(value: unknown): { key: number; changed: boolean } {
  const state = useRef<ChangeState>({ value, count: 0 });
  state.current = nextChange(state.current, value);
  return { key: state.current.count, changed: state.current.count > 0 };
}

/** text-states-swap: the content re-enters (slight rise + blur) whenever `value` changes. */
export function SwapIn({ value, children }: { value: unknown; children: ReactNode }) {
  const { key, changed } = useChangeKey(value);
  return (
    <span key={key} className={`t-text-swap${changed ? " is-entering" : ""}`}>
      {children}
    </span>
  );
}

/** number-pop-in: a counter that pops in from below whenever `value` changes. */
export function PopIn({ value, children }: { value: unknown; children: ReactNode }) {
  const { key, changed } = useChangeKey(value);
  return (
    <span key={key} className={`t-digit-group${changed ? " is-animating" : ""}`}>
      {children}
    </span>
  );
}
