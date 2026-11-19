import { ClientPageSwitch, type ClientPageName } from "./client-pages.generated";

/** A component that takes no props infers `unknown` here, which JSX would reject. */
type PropsOf<C> = C extends (props: infer P) => unknown ? (unknown extends P ? object : P) : never;

/**
 * A dashboard page's client half, loaded only when that page is open. All pages share one
 * catch-all route, and a client component imported directly would reach every page's bundle.
 *
 * Use it with a type-only import, so the types stay exact: clientPage<typeof Client>("audit").
 */
export function clientPage<C extends (props: never) => unknown>(name: ClientPageName) {
  return function ClientPage(props: PropsOf<C>) {
    return <ClientPageSwitch name={name} props={props as object} />;
  };
}
