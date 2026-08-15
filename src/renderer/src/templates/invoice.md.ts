// De-personalisation pass -- see resume.md.ts for the placeholder convention
// (plain title case, never bracketed) and the measurement that ruled brackets
// out. Two invented companies with full street addresses became "Your
// Business Name" / "Client Company" plus generic address fields.
//
// The line items, their rates, and the subtotal/tax/total arithmetic are
// deliberately left CONCRETE. They identify nobody, and blanking them would
// cost the template the thing it exists to demonstrate: a Qty/Rate/Amount
// table whose numbers actually add up to the totals underneath it. The
// invoice number is reset to INV-0001 (a plausible FIRST invoice) rather than
// placeholdered, for the same reason.
//
// The table's column widths are the exact padding remark-stringify emits, so
// editing a cell means re-running templates.test.ts's byte-identity block
// rather than eyeballing the alignment.
export const INVOICE_TEMPLATE = `# Invoice

**Invoice #:** INV-0001 · **Date:** Month Day, Year · **Due:** Month Day, Year

**From:** Your Business Name, Street Address, City, State ZIP

**Bill To:** Client Company, Street Address, City, State ZIP

## Items

| Description             | Qty | Rate      | Amount    |
| ----------------------- | --- | --------- | --------- |
| Brand identity design   | 1   | $3,200.00 | $3,200.00 |
| Website homepage mockup | 2   | $850.00   | $1,700.00 |
| Revisions (hourly)      | 4   | $95.00    | $380.00   |

**Subtotal:** $5,280.00

**Tax (8%):** $422.40

**Total Due:** $5,702.40

## Payment Terms

Payment is due within 14 days of the invoice date. Please remit payment via bank transfer to the account details provided separately.
`
