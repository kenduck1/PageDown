import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView at all (a long-standing jsdom gap,
// not specific to this project) — polyfill it as a no-op so components that
// call it (e.g. HomeScreen's Recent/Templates nav) don't throw under test.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {})
