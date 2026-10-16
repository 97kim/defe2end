import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False during server rendering and hydration, true afterwards. Dates and clocks in client components render
 * only once this is true: the server's time zone and ICU data differ from the browser's, which breaks hydration.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
