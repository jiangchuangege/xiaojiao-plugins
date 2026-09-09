/**
 * Branded opaque identifiers minted by {@link BrowserSessionService}.
 * Implemented locally for this plugin; it follows the same shape as the
 * harness's branding without importing it, so the definition layer stays
 * free of runtime dependencies beyond Cordis.
 * @module @dsh-browser-automation/dsh-browser/brand
 */

declare const sessionIdBrand: unique symbol
declare const pageIdBrand: unique symbol
declare const observationIdBrand: unique symbol
declare const elementRefBrand: unique symbol

/** Opaque identity of one owner-scoped isolated browser session. */
export type BrowserSessionId = string & { readonly [sessionIdBrand]: true }
/** Opaque identity of the single page inside a session. */
export type BrowserPageId = string & { readonly [pageIdBrand]: true }
/** Opaque identity of one bounded semantic observation. */
export type ObservationId = string & { readonly [observationIdBrand]: true }
/** Opaque reference to one observed actionable element; never a selector. */
export type ElementRef = string & { readonly [elementRefBrand]: true }

/** Brand a fresh backend-independent id. Callers never mint their own values. */
export const BrowserSessionId = (value: string): BrowserSessionId => value as BrowserSessionId

/** Brand a fresh backend-independent id. Callers never mint their own values. */
export const BrowserPageId = (value: string): BrowserPageId => value as BrowserPageId

/** Brand a fresh backend-independent id. Callers never mint their own values. */
export const ObservationId = (value: string): ObservationId => value as ObservationId

/** Brand a fresh backend-independent id. Callers never mint their own values. */
export const ElementRef = (value: string): ElementRef => value as ElementRef
