## components/ui

Generic reusable UI primitives: tables, dialogs, switches, selectors, shell
chrome, theme controls, toasts, skeletons, and small interaction helpers.

These components are domain-neutral. Feature-specific DNS/admin behavior belongs
under `components/domain` or the relevant `app/` route segment.

Two of them carry a convention every list follows:

- `row-disclosure` - the row-detail accordion: `useRowDisclosure()` keeps one
  open row per table, `<DisclosureChevron>` goes in front of the first column's
  value (it rotates, carries `aria-expanded` / `aria-controls` and a
  Show/Hide accessible name), `rowDetailId()` builds the shared panel id, and
  `<RowDisclosurePanel>` is the labelled region revealed beneath the row,
  usually through `<DataTable renderRowDetail>`. Use it instead of a per-row
  `expanded` set or a `<Disclosure>` in a "Detail" cell.
- `toggle-chip` - the `aria-pressed` filter pill with a status dot and a count
  (skeleton while the count is unknown) used in status strips. Tones are
  `error | warn | success | muted | accent`.
