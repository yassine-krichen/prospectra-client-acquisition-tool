import '@tanstack/react-table';

// TanStack Table's `ColumnMeta` is an empty interface by design, meant to be
// augmented by consumers. `data-table-view-options.tsx` (ported from
// tablecn) reads `columnDef.meta?.label` for the column-visibility toggle's
// display name, falling back to the raw column id when a column doesn't set
// one.
declare module '@tanstack/react-table' {
  interface ColumnMeta<_TData, _TValue> {
    label?: string;
  }
}
