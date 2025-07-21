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
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheckFilled,
  IconGripVertical,
  IconLayoutColumns,
  IconLoader,
  IconPlus,
} from "@tabler/icons-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import Decimal from "decimal.js";
import { Bot } from "@/lib/types";
import { BotMemoryEntry, BotStatus, ChaserInfo, InRangeInfo } from "@/lib/types";
import { ProtocolLabels, StatusLabels, StrategyLabels } from "@achilles/utils";
import { useGlobalContext } from "../context/GlobalContext";
import Image from "next/image";
import { tokenRegistry } from "@/lib/tokens";
import { Edit2Icon } from "lucide-react";
import Pagination from "./pagination";

export function DragHandle({ id }: { id: string }) {
  const { attributes, listeners } = useSortable({
    id,
  });

  return (
    <Button
      {...attributes}
      {...listeners}
      variant="ghost"
      size="icon"
      className="text-muted-foreground size-7 hover:bg-transparent"
    >
      <IconGripVertical className="text-muted-foreground size-3" />
      <span className="sr-only">Drag to reorder</span>
    </Button>
  );
}

const StatusBadge = ({ status }: { status: number }) => {
  return (
    <Badge variant="outline" className="text-muted-foreground px-1.5">
      {status === BotStatus.RUN ? (
        <IconCircleCheckFilled className="fill-green-500 dark:fill-green-400 mr-1" />
      ) : status === BotStatus.STOP ? (
        <IconCircleCheckFilled className="fill-red-500 dark:fill-red-400 mr-1" />
      ) : (
        <IconLoader className="mr-1 animate-spin" />
      )}
      {StatusLabels[status]}
    </Badge>
  );
};

export const ProtocolBadge = ({ protocol }: { protocol: number }) => {
  return (
    <Badge variant="outline" className="text-muted-foreground px-1.5">
      {ProtocolLabels[protocol]}
    </Badge>
  );
};

const StrategyBadge = ({ strategy }: { strategy: number }) => {
  return (
    <Badge variant="outline" className="text-muted-foreground px-1.5">
      {StrategyLabels[strategy]}
    </Badge>
  );
};

export const CoinIcon = ({ url }: { url: string | undefined }) => {
  return url ? (
    <Image
      src={url}
      alt={"coin"}
      width={25}
      height={25}
      sizes="w-5 h-5"
      className="object-contain"
      unoptimized
    />
  ) : (
    <></>
  );
};

type PositionDetailsProps = {
  positions: BotMemoryEntry[];
  poolId: string;
};

// Component to display position details
const PositionDetails: React.FC<PositionDetailsProps> = ({ positions, poolId }) => {
  const { prices } = useGlobalContext();
  const [poolPrice, setPoolPrice] = React.useState<Decimal>(new Decimal(0));

  const fetchPoolPrice = async () => {
    try {
      const response = await fetch(`/api/pool/price?poolId=${poolId}`);
      if (!response.ok) throw new Error("Failed to fetch price");
      const data = await response.json();
      if (data.price) setPoolPrice(new Decimal(data.price));
    } catch (error) {
      console.error("Error fetching price:", error);
    }
  };

  const openPositions = positions.filter((pos) => pos.action === "open");

  React.useEffect(() => {
    if (!poolId || !openPositions.length) return;
    fetchPoolPrice();

    const interval = setInterval(fetchPoolPrice, 10000);

    return () => clearInterval(interval);
  }, [openPositions.length, poolId]);

  if (openPositions.length === 0) {
    return <div className="p-4 text-center">No open positions found</div>;
  }

  const coinA = tokenRegistry.getTokenData(openPositions[0].coinA.coinType);
  const coinB = tokenRegistry.getTokenData(openPositions[0].coinB.coinType);

  const PositionItem = ({ position }: { position: BotMemoryEntry }) => {
    const [inrange, setInrange] = React.useState<boolean>(false);
    const strategyInfo = position.strategy as ChaserInfo | InRangeInfo;
    const positionDetails = strategyInfo.position;

    React.useEffect(() => {
      if (
        positionDetails &&
        poolPrice.greaterThanOrEqualTo(positionDetails.lower_price ?? 0) &&
        poolPrice.lessThanOrEqualTo(positionDetails.upper_price ?? 0)
      )
        setInrange(true);
      else setInrange(false);
    }, [poolPrice]);

    return (
      <div className="bg-background rounded-md p-4">
        <div className="grid grid-cols-4 md:grid-cols-4 gap-4 mb-2">
          <div>
            <h4 className="text-sm font-medium text-muted-foreground">Status</h4>
            <div
              className={`${
                inrange ? "bg-green-900" : "bg-red-900"
              } w-fit rounded p-1 flex items-center justify-center`}
            >
              <div className="flex gap-2 items-center-safe">
                <div
                  className={`w-2 h-2 rounded-full  ${inrange ? "bg-green-500" : "bg-red-500"}`}
                />
                <span className="text-xs">{inrange ? "live" : "out of range"}</span>
              </div>
            </div>
          </div>
          {strategyInfo.type === "chaser" && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">Step</h4>
              <p>{(strategyInfo as ChaserInfo).step}</p>
            </div>
          )}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground">Coin A</h4>
            <p className="relative flex items-center gap-1">
              <CoinIcon url={coinA.iconUrl} />
              {coinA.symbol || position.coinA.coinType.slice(0, 4)}:{" "}
              {position.coinA.amount.abs().toFixed(2)} ($
              {position.coinA.amount
                .abs()
                .mul(prices[position.coinA.coinType] ?? 0)
                .toFixed(2)}
              )
            </p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-muted-foreground">Coin B</h4>
            <p className="relative flex items-center gap-1">
              <CoinIcon url={coinB.iconUrl} />
              {coinB.symbol || position.coinB.coinType.slice(0, 4)}:{" "}
              {position.coinB.amount.abs().toFixed(2)} ($
              {position.coinB.amount
                .abs()
                .mul(prices[position.coinB.coinType] ?? 0)
                .toFixed(2)}
              )
            </p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-muted-foreground">Liquidity</h4>
            <p className="relative flex items-center gap-2">
              $
              {position.coinA.amount
                .abs()
                .mul(prices[position.coinA.coinType] ?? 0)
                .add(position.coinB.amount.abs().mul(prices[position.coinB.coinType] ?? 0))
                .toFixed(4)}
            </p>
          </div>
        </div>

        {positionDetails && (
          <div className="grid grid-cols-4 md:grid-cols-4 gap-4">
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">Position ID</h4>
              <p className="truncate" title={positionDetails.position_id}>
                {positionDetails.position_id.length > 10
                  ? `${positionDetails.position_id.slice(
                      0,
                      6,
                    )}...${positionDetails.position_id.slice(-4)}`
                  : positionDetails.position_id}
              </p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">Lower Price</h4>
              <p>{positionDetails.lower_price.toString()}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">Upper Price</h4>
              <p>{positionDetails.upper_price.toString()}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">Created At</h4>
              <p className="relative flex items-center gap-2">
                {new Date(position.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="px-4 py-2 space-y-4 bg-muted/30">
      <h3 className="font-semibold text-sm">
        Position Details | Current price: {poolPrice.toFixed(2)} {coinB.symbol} per {coinA.symbol}
      </h3>
      {openPositions.map((position, index) => (
        <PositionItem position={position} key={index} />
      ))}
    </div>
  );
};

// Component to display each row with expandable content
function BotRow({ row, columns }: { row: Row<Bot>; columns: number }) {
  const { transform, transition, setNodeRef, isDragging } = useSortable({
    id: row.original.botId,
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
              <PositionDetails positions={row.original.positions} poolId={row.original.poolId} />
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </React.Fragment>
    </Collapsible>
  );
}

export function BotDataTable() {
  const { bots: data, setBots: setData, wallets, setBotDialog, prices } = useGlobalContext();

  const columns: ColumnDef<Bot>[] = [
    {
      id: "drag",
      header: () => null,
      cell: ({ row }) => <DragHandle id={row.original.botId} />,
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
      accessorKey: "botId",
      header: "Bot ID",
      cell: ({ row }) => {
        return <span>{row.original.botId}</span>;
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "sender",
      accessorFn: (row) => {
        const sender = row.sender;
        const id = wallets?.[sender]?.id ?? "";
        return `${id} ${sender}`;
      },
      header: "Wallet",
      cell: ({ row }) => {
        const wallet = row.original.sender;
        // Shorten wallet address for display
        const shortWallet =
          wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-6)}` : wallet;

        return <span title={wallet}>{wallets[row.original.sender]?.id ?? shortWallet}</span>;
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
      accessorKey: "strategy",
      header: "Strategy",
      cell: ({ row }) => <StrategyBadge strategy={row.original.strategy} />,
      filterFn: (row, id, filterValue) => {
        return filterValue === "all" ? true : StrategyLabels[row.original.strategy] === filterValue;
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
      accessorKey: "coins",
      accessorFn: (row) => {
        const coinA = tokenRegistry.getTokenData(row.params.coinA.coinType);
        const coinB = tokenRegistry.getTokenData(row.params.coinB.coinType);
        return `${row.params.coinA.coinType} ${row.params.coinB.coinType} ${coinA.symbol} ${coinB.symbol}`;
      },
      header: "Coins",
      cell: ({ row }) => {
        const coinA = tokenRegistry.getTokenData(row.original.params.coinA.coinType);
        const coinB = tokenRegistry.getTokenData(row.original.params.coinB.coinType);
        return (
          <span
            title={`${coinA.symbol}:${coinB.symbol}`}
            className="flex items-center gap-2 min-w-48"
          >
            <CoinIcon url={coinA.iconUrl} />{" "}
            {coinA.symbol.length > 10 ? coinA.symbol.slice(0, 5) + ".." : coinA.symbol} :
            <CoinIcon url={coinB.iconUrl} />{" "}
            {coinB.symbol.length > 10 ? coinB.symbol.slice(0, 5) + ".." : coinB.symbol}{" "}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      filterFn: (row, id, filterValue) => {
        return filterValue === "all" ? true : StatusLabels[row.original.status] === filterValue;
      },
    },
    {
      accessorKey: "liquidity",
      header: "Liquidity",
      cell: ({ row }) => (
        <span>
          $
          {row.original.positions
            .filter((pos) => pos.action === "open")
            .reduce((prev, curr) => {
              return prev.add(
                curr.coinA.amount
                  .abs()
                  .mul(prices[curr.coinA.coinType] ?? 0)
                  .add(curr.coinB.amount.abs().mul(prices[curr.coinB.coinType] ?? 0)),
              );
            }, new Decimal(0))
            .toFixed(2)}
        </span>
      ),
    },
    {
      accessorKey: "timestamp",
      header: "Created At",
      cell: ({ row }) => {
        return (
          <span>
            {row.original.positions.length
              ? new Date(row.original.positions[0]?.timestamp).toLocaleString()
              : ""}
          </span>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        return (
          <Button
            variant="ghost"
            className="data-[state=open]:bg-muted text-muted-foreground flex size-8"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              setBotDialog({ open: true, bot: row.original });
            }}
          >
            <Edit2Icon />
            <span className="sr-only">Edit</span>
          </Button>
        );
      },
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
    () => data?.map(({ botId }) => botId) || [],
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
    getRowId: (row) => row.botId,
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
          <Button
            onClick={() => {
              setBotDialog({ open: true });
            }}
            variant="outline"
            size="sm"
          >
            <IconPlus />
            <span className="hidden lg:inline">Add Bot</span>
          </Button>
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
          options={Object.values(StatusLabels)}
        />
        <TableFilter
          table={table}
          columnKey="strategy"
          label="Strategy"
          options={Object.values(StrategyLabels)}
        />
        <TableFilter
          table={table}
          columnKey="sender"
          label="Wallet"
          options={Object.values(wallets).map((wallet) => wallet.id)}
        />
        <TableFilter
          table={table}
          columnKey="coins"
          label="Asset"
          options={Array.from(
            new Set(
              data.flatMap((bot) => [
                tokenRegistry.getTokenData(bot.params.coinA.coinType).symbol,
                tokenRegistry.getTokenData(bot.params.coinB.coinType).symbol,
              ]),
            ),
          )}
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
                    <BotRow key={row.id} row={row} columns={columns.length} />
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

interface TableFilterProps {
  table: any;
  columnKey: string;
  label: string;
  options: string[];
  placeholder?: string;
}

export function TableFilter({
  table,
  columnKey,
  label,
  options,
  placeholder = "All",
}: TableFilterProps) {
  const column = table.getColumn(columnKey);

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={`${columnKey}-filter`} className="text-sm">
        {label}
      </Label>
      <Select
        value={(column?.getFilterValue() as string) || ""}
        onValueChange={(value) => column?.setFilterValue(value === "all" ? undefined : value)}
      >
        <SelectTrigger id={`${columnKey}-filter`} className="w-32">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{placeholder}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
