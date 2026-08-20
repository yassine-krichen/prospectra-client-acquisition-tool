import type { Column } from '@tanstack/react-table';

// Standard TanStack Table column-pinning style helper (docs pattern). None of
// this app's tables actually pin a column today - `data-table.tsx` (ported
// from tablecn, see its own header comment) calls this unconditionally on
// every cell/header, so it needs to exist and safely no-op for the common
// unpinned case rather than every column definition having to opt out.
export function getColumnPinningStyle<TData, TValue>({
  column,
}: {
  column: Column<TData, TValue>;
}): React.CSSProperties {
  const isPinned = column.getIsPinned();
  if (!isPinned) return {};

  return {
    left: isPinned === 'left' ? `${column.getStart('left')}px` : undefined,
    right: isPinned === 'right' ? `${column.getAfter('right')}px` : undefined,
    position: 'sticky',
    zIndex: 1,
  };
}
