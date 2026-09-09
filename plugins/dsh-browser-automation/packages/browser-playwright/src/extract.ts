/**
 * Frozen DOM extraction used to build bounded semantic snapshots. The script
 * is provider-internal, trusted code: it receives no user or model input and
 * its results are always treated as untrusted web content. It returns only
 * bounded metadata (role, accessible name, visible text, tag, internal path);
 * it never returns HTML, attribute dumps, script text, hidden values, or
 * password-field contents.
 * @module @dsh-browser-automation/dsh-browser-playwright/extract
 */

/** Bounds handed to the extraction script. */
export interface ExtractBounds {
  readonly maxNodes: number
  readonly maxTextBytes: number
  readonly maxNameChars: number
  readonly maxDepth: number
}

/** One extracted element before fingerprinting. */
export interface ExtractedElement {
  readonly tag: string
  readonly role: string
  readonly name: string
  readonly text: string
  readonly interactive: boolean
  readonly editable: boolean
  readonly disabled: boolean
  readonly path: string
}

/** The extraction result envelope; mutable while the walker fills it. */
export interface ExtractResult {
  title: string
  nodeCount: number
  truncated: boolean
  elements: ExtractedElement[]
}

/**
 * Extract a bounded semantic snapshot; runs inside the page context with no
 * access to the Node module scope. Exported as a real self-contained function
 * so Playwright serializes and invokes it verbatim in the page; it closes over
 * nothing and its results are always treated as untrusted web content.
 *
 * Coverage: this function only ever executes inside the browser process, so
 * Node-side instrumentation cannot see it. Its behavior (snapshot bounds,
 * password/hidden-field exclusion, name/role computation, truncation) is
 * asserted by the real-Chrome suite in `provider.spec.ts`.
 */
/* v8 ignore start */
export function extractPage(bounds: ExtractBounds): ExtractResult {
  const out: ExtractResult = { title: document.title, nodeCount: 0, truncated: false, elements: [] }
  let textBytes = 0

  function cssPath(el: Element): string {
    const parts: string[] = []
    let current: Element | null = el
    while (current !== null && current.nodeType === 1 && parts.length < 32) {
      let selector = current.tagName.toLowerCase()
      const parent: Element | null = current.parentElement
      if (parent !== null) {
        const siblings = [...parent.children].filter(child => child.tagName === current!.tagName)
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1
          selector += `:nth-of-type(${index})`
        }
      }
      parts.unshift(selector)
      current = parent
    }
    return parts.join(' > ')
  }

  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])
  const ignoredTags = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'path'])
  const skippedInputTypes = new Set(['hidden', 'password', 'submit', 'reset', 'file', 'image'])

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit !== null && explicit !== '') return explicit.toLowerCase()
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : tag
      case 'button': return 'button'
      case 'input': {
        const type = (el as HTMLInputElement).type
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        return 'textbox'
      }
      case 'select': return 'combobox'
      case 'textarea': return 'textbox'
      case 'h1': case 'h2': case 'h3': return 'heading'
      case 'nav': return 'navigation'
      case 'main': return 'main'
      default: return tag
    }
  }

  function nameOf(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel !== null) return ariaLabel
    const alt = el.getAttribute('alt')
    if (alt !== null) return alt
    const title = el.getAttribute('title')
    if (title !== null) return title
    const htmlEl = el as HTMLInputElement
    if (typeof htmlEl.labels !== 'undefined' && htmlEl.labels !== null) {
      for (const label of htmlEl.labels) {
        const text = (label.textContent ?? '').trim()
        if (text !== '') return text
      }
    }
    const text = (el.textContent ?? '').trim().slice(0, 80)
    return text.length <= 40 ? text : ''
  }

  function interactiveOf(el: Element): boolean {
    if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return true
    const role = el.getAttribute('role')
    if (role !== null && /^(button|link|checkbox|radio|menuitem|tab|switch|option|combobox|textbox)$/i.test(role)) return true
    if (!interactiveTags.has(el.tagName.toLowerCase())) return false
    if (el.tagName.toLowerCase() === 'input') {
      const type = (el as HTMLInputElement).type.toLowerCase()
      if (skippedInputTypes.has(type)) return false
    }
    return true
  }

  function editableOf(el: Element): boolean {
    if (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'select') return true
    if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return true
    if (el.tagName.toLowerCase() === 'input') {
      const input = el as HTMLInputElement
      const type = input.type.toLowerCase()
      if (skippedInputTypes.has(type)) return false
      return !input.disabled && !input.readOnly
    }
    return false
  }

  function walk(root: Element, depth: number): void {
    if (out.truncated) return
    if (depth > bounds.maxDepth) {
      out.truncated = true
      return
    }
    for (const child of root.children) {
      if (out.elements.length >= bounds.maxNodes) {
        out.truncated = true
        return
      }
      const tag = child.tagName.toLowerCase()
      if (ignoredTags.has(tag)) continue
      const visible = isVisible(child)
      const interactive = visible && interactiveOf(child)
      if (interactive || (visible && (tag === 'h1' || tag === 'h2' || tag === 'h3'))) {
        const name = nameOf(child).slice(0, bounds.maxNameChars)
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
        const bounded = text.slice(0, Math.max(0, bounds.maxTextBytes - textBytes))
        textBytes += bounded.length
        if (textBytes >= bounds.maxTextBytes) out.truncated = true
        const el = child as HTMLInputElement
        out.elements.push({
          tag,
          role: roleOf(child),
          name,
          text: bounded,
          interactive,
          editable: interactive && editableOf(child),
          disabled: typeof el.disabled === 'boolean' ? el.disabled : false,
          path: cssPath(child),
        })
      }
      walk(child, depth + 1)
    }
  }

  walk(document.documentElement, 0)
  out.nodeCount = out.elements.length
  return out
}
/* v8 ignore stop */
