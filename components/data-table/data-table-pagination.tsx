import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

// tablecn's stock DataTablePagination (https://github.com/sadmann7/tablecn)
// assumes the entire dataset is loaded client-side (`table.getPageCount()`,
// `table.setPageIndex()`) - this app's tables deliberately fetch one page at
// a time from the server via an opaque cursor (see prospects.repository.ts's
// own doc comment on why: cursor pagination is the only kind that stays
// correct when sorting by a field whose value can change between page
// fetches). There is no "jump to page 7" or "total row count" to show
// without abandoning that design, so this is a from-scratch footer matching
// tablecn's visual layout, not an adaptation of its pagination logic - next/
// previous only, driven by the caller's own cursor state.

interface DataTableCursorPaginationProps extends React.ComponentProps<'div'> {
  pageNumber: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  rowCount: number;
}

export function DataTableCursorPagination({
  pageNumber,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  pageSize,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  rowCount,
  className,
  ...props
}: DataTableCursorPaginationProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex w-full flex-col-reverse items-center justify-between gap-4 overflow-auto p-1 sm:flex-row sm:gap-8',
        className
      )}
      {...props}
    >
      <div className="text-muted-foreground flex-1 text-sm whitespace-nowrap">{rowCount} row(s) on this page.</div>
      <div className="flex flex-col-reverse items-center gap-4 sm:flex-row sm:gap-6 lg:gap-8">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium whitespace-nowrap">Rows per page</p>
          <Select value={`${pageSize}`} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger className="h-8 w-18">
              <SelectValue placeholder={pageSize} />
            </SelectTrigger>
            <SelectContent side="top">
              <SelectGroup>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={`${option}`}>
                    {option}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-center text-sm font-medium">Page {pageNumber}</div>
        <div className="flex items-center space-x-2">
          <Button
            aria-label="Go to previous page"
            variant="outline"
            size="icon-sm"
            onClick={onPrevious}
            disabled={!canGoPrevious}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
          <Button aria-label="Go to next page" variant="outline" size="icon-sm" onClick={onNext} disabled={!canGoNext}>
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        </div>
      </div>
    </div>
  );
}
