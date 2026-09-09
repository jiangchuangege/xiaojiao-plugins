/**
 * Schema specs for the ten browser tools. Every nested object declares
 * `additionalProperties: false`; the harness parameter root stays an implicit
 * open object, so each executor rejects unknown root keys against its
 * manifest key set.
 * @module @dsh-browser-automation/dsh-tool-browser/schemas
 */

import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

const PRESS_KEYS = ['Enter', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'] as const

/** Opaque element reference from a `browser_snapshot` result. */
export const elementRefParam = {
  type: 'string',
  description: 'Element ref from a browser_snapshot result; stale after navigation, mutation, or observation expiry.',
  required: true,
} as const

export const startParameters = {
  backend: { type: 'string', description: 'Backend type to select when more than one browser backend is registered.' },
} as const satisfies ParameterSchemaSpec

export const navigateParameters = {
  url: {
    type: 'string',
    description: 'Exact public http(s) URL to open. No userinfo, query, or fragment; the page navigates in the current session.',
    required: true,
  },
} as const satisfies ParameterSchemaSpec

export const snapshotParameters = {} as const satisfies ParameterSchemaSpec

export const screenshotParameters = {} as const satisfies ParameterSchemaSpec

export const clickParameters = {
  ref: elementRefParam,
} as const satisfies ParameterSchemaSpec

export const fillParameters = {
  ref: elementRefParam,
  text: {
    type: 'string',
    description: 'Plain text to type into the field. Never enter secrets, credentials, OTP codes, or payment data.',
    required: true,
  },
} as const satisfies ParameterSchemaSpec

export const pressParameters = {
  ref: elementRefParam,
  key: {
    type: 'string',
    description: 'Single key to press after focusing the target: Enter, Space, Tab, arrow keys, Backspace, Escape, Home, End, PageUp, PageDown.',
    required: true,
    enum: PRESS_KEYS,
  },
} as const satisfies ParameterSchemaSpec

export const scrollParameters = {
  target: {
    type: 'object',
    description: 'Scroll target: the page, or one observed element.',
    additionalProperties: false,
    properties: {
      page: { type: 'boolean', description: 'True to scroll the page itself.' },
      element: { type: 'string', description: 'Element ref to scroll into view.' },
    },
    required: true,
  },
  deltaY: {
    type: 'number',
    description: 'Vertical scroll distance in pixels; negative scrolls up. Bounded by the provider budget.',
    required: true,
  },
} as const satisfies ParameterSchemaSpec

export const waitParameters = {
  ms: {
    type: 'integer',
    description: 'Time to wait in milliseconds, at least 1; bounded by the provider budget.',
    required: true,
  },
} as const satisfies ParameterSchemaSpec

export const closeParameters = {} as const satisfies ParameterSchemaSpec
