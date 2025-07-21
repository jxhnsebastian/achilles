import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconChevronDown, IconChevronRight, IconLayoutColumns } from "@tabler/icons-react";
import {
  ColumnDef,
  ColumnFiltersState,
  Row,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Poller } from "@/lib/types";
import { PollerStatusLabels, ProtocolLabels } from "@achilles/utils";
import { useGlobalContext } from "../context/GlobalContext";
import { DragHandle, ProtocolBadge, TableFilter } from "./bot-table";
import Pagination from "./pagination";

const BadgeItem = ({ item }: { item: string }) => {
  return (
    <Badge variant="outline" className="text-muted-foreground px-1.5">
      {item}
    </Badge>
  );
};

// Component to display each row with expandable content
function PollerRow({ row, columns }: { row: Row<Poller>; columns: number }) {
  const { transform, transition, setNodeRef, isDragging } = useSortable({
    id: row.original.poolId,
  });

  return (
    <Collapsible
      asChild
      open={row.getIsExpanded()}
      onOpenChange={(isOpen) => row.toggleExpanded(isOpen)}
    >
      <React.Fragment>
        <CollapsibleTrigger asChild>
          <TableRow
            data-state={row.getIsSelected() && "selected"}
            data-dragging={isDragging}
            ref={setNodeRef}
            className="relative z-0 data-[dragging=true]:z-10 data-[dragging=true]:opacity-80"
            style={{
              transform: CSS.Transform.toString(transform),
              transition: transition,
            }}
          >
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <TableRow className="bg-muted/20">
            <TableCell colSpan={columns} className="p-0">
              <div>Pool Details</div>
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </React.Fragment>
    </Collapsible>
  );
}

export function PollerTable() {
  const { pollers: data, setPollers: setData } = useGlobalContext();

  const columns: ColumnDef<Poller>[] = [
    {
      id: "drag",
      header: () => null,
      cell: ({ row }) => <DragHandle id={row.original.poolId} />,
    },
    {
      id: "select",
      header: ({ table }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label="Select all"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select row"
          />
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: "expander",
      header: () => null,
      cell: ({ row }) => (
        <CollapsibleTrigger className="flex w-full justify-start">
          {row.getIsExpanded() ? (
            <IconChevronDown className="size-4" />
          ) : (
            <IconChevronRight className="size-4" />
          )}
        </CollapsibleTrigger>
      ),
    },
    {
      accessorKey: "pollerId",
      header: "Poller ID",
      cell: ({ row }) => {
        return <span>{row.original.pollerId}</span>;
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "protocol",
      header: "Protocol",
      cell: ({ row }) => <ProtocolBadge protocol={row.original.protocol} />,
      filterFn: (row, id, filterValue) => {
        return filterValue === "all" ? true : ProtocolLabels[row.original.protocol] === filterValue;
      },
    },
    {
      accessorKey: "poolId",
      header: "Pool ID",
      cell: ({ row }) => {
        const poolId = row.original.poolId;
        const shortPoolId =
          poolId.length > 12 ? `${poolId.slice(0, 6)}...${poolId.slice(-6)}` : poolId;
        return <span title={poolId}>{shortPoolId}</span>;
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <BadgeItem item={PollerStatusLabels[row.original.status]} />,
      filterFn: (row, id, filterValue) => {
        return filterValue === "all"
          ? true
          : PollerStatusLabels[row.original.status] === filterValue;
      },
    },
    {
      accessorKey: "runtimeStatus",
      header: "Runtime",
      cell: ({ row }) => <BadgeItem item={row.original.runtimeStatus} />,
      filterFn: "includesString",
    },
  ];

  const [rowSelection, setRowSelection] = React.useState({});
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: 10,
  });
  const [globalFilter, setGlobalFilter] = React.useState("");
  const sortableId = React.useId();
  const sensors = useSensors(
    useSensor(MouseSensor, {}),
    useSensor(TouchSensor, {}),
    useSensor(KeyboardSensor, {}),
  );

  const dataIds = React.useMemo<UniqueIdentifier[]>(
    () => data?.map(({ poolId }) => poolId) || [],
    [data],
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination,
      globalFilter,
    },
    getRowId: (row) => row.poolId,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getExpandedRowModel: getExpandedRowModel(),

    // Enable expanding rows
    getSubRows: () => undefined,
  });

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (active && over && active.id !== over.id) {
      setData((data) => {
        const oldIndex = dataIds.indexOf(active.id);
        const newIndex = dataIds.indexOf(over.id);
        return arrayMove(data, oldIndex, newIndex);
      });
    }
  }

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search all columns..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="max-w-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <IconLayoutColumns />
                <span className="hidden lg:inline">Customize Columns</span>
                <span className="lg:hidden">Columns</span>
                <IconChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {table
                .getAllColumns()
                .filter((column) => typeof column.accessorFn !== "undefined" && column.getCanHide())
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 px-4 lg:px-6">
        <TableFilter
          table={table}
          columnKey="protocol"
          label="Protocol"
          options={Object.values(ProtocolLabels)}
        />
        <TableFilter
          table={table}
          columnKey="status"
          label="Status"
          options={Object.values(PollerStatusLabels)}
        />
        <TableFilter
          table={table}
          columnKey="runtimeStatus"
          label="Runtime"
          options={["RUNNING", "RESTARTING", "STOPPED", "NOT_INITIALIZED"]}
        />
      </div>

      <div className="overflow-hidden rounded-lg border mx-4 lg:mx-6">
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
          sensors={sensors}
          id={sortableId}
        >
          <Table>
            <TableHeader className="bg-muted sticky top-0 z-10">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id} colSpan={header.colSpan}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody className="**:data-[slot=table-cell]:first:w-8">
              {table.getRowModel().rows?.length ? (
                <SortableContext items={dataIds} strategy={verticalListSortingStrategy}>
                  {table.getRowModel().rows.map((row) => (
                    <PollerRow key={row.id} row={row} columns={columns.length} />
                  ))}
                </SortableContext>
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    No results.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DndContext>
      </div>
      <Pagination table={table} />
    </div>
  );
}
