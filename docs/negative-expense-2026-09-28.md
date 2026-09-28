# Signed expenses and optional remarks

User-approved scope: a minus toggle beside expense amounts, plus optional remarks for bottle-deposit returns and other negative receipts.

- Replaces the existing ambiguous expense/return sign toggle with a visible − button. Numeric keypad remains available; the button toggles the actual signed value and exposes pressed state.
- Supports regular sales-report entry, employee quick entry, and existing-entry editing.
- Saves remarks to the existing memo column and shows them in entry lists.
- Rejects non-integer/out-of-range amounts and remarks exceeding 1,000 characters. Negative amounts remain signed in vendor, date and monthly sums.
- No schema or permission changes, and no operational expense records were modified for testing.

Validation: 518 automated tests, 509 passed, 9 environment-dependent skips, 0 failures; production build and diff check passed. Tests cover both registration paths with -20,000 and a remark, negative edit validation, invalid lone minus, and vendor/date net totals of 280,000 from 300,000 minus 20,000.

The renderSalesReportForm preservation hash was updated only for the explicitly requested expense input controls; other protected functions are unchanged. Physical phone and authenticated operational save were not exercised.
