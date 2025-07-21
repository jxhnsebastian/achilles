import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PoolTick, GenericPoolInfo, Protocol } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader } from "lucide-react";
import { ProtocolLabels } from "@achilles/utils";
import { tokenRegistry } from "@/lib/tokens";
import { BotMemoryEntry, ChaserInfo, InRangeInfo } from "@/lib/types";
import { Decimal } from "decimal.js";
import { IconPlus, IconMinus } from "@tabler/icons-react";
import { useGlobalContext } from "../context/GlobalContext";

interface TickRangeInputProps {
  poolInfo: GenericPoolInfo;
  protocol: Protocol;
  setTickRange: React.Dispatch<React.SetStateAction<number>>;
  initialTickRange?: number;
  disabled?: boolean;
  positions?: BotMemoryEntry[];
}

export function TickRangeInput({
  poolInfo,
  protocol,
  setTickRange,
  disabled = false,
  positions,
}: TickRangeInputProps) {
  const { botDialog } = useGlobalContext();
  const [selectedRange, setSelectedRange] = useState<number | null>(positions?.length ? null : 10);
  const [minPrice, setMinPrice] = useState<Decimal>(new Decimal(0));
  const [maxPrice, setMaxPrice] = useState<Decimal>(new Decimal(0));
  const [minPriceInput, setMinPriceInput] = useState<string>("0");
  const [maxPriceInput, setMaxPriceInput] = useState<string>("0");
  const [currentPrice, setCurrentPrice] = useState<Decimal>(new Decimal(0));
  const [loading, setLoading] = useState<boolean>(false);
  const [poolTicks, setPoolTicks] = useState<PoolTick[]>([]);

  const [minPricePercentage, setMinPricePercentage] = useState<number>(0);
  const [maxPricePercentage, setMaxPricePercentage] = useState<number>(0);

  const minPriceInputRef = useRef<HTMLInputElement>(null);
  const maxPriceInputRef = useRef<HTMLInputElement>(null);

  const presetRanges = [1, 5, 10];

  const fetchCurrentPrice = async () => {
    try {
      const response = await fetch(`/api/pool/price?poolId=${poolInfo.address}`);
      if (!response.ok) throw new Error("Failed to fetch price");
      const data = await response.json();
      if (data.price) setCurrentPrice(new Decimal(data.price));
    } catch (error) {
      console.error("Error fetching price:", error);
    }
  };

  const fetchTicks = async () => {
    try {
      setLoading(true);
      setPoolTicks([]);
      const poolDataResponse = await fetch("/api/pool/data", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          poolId: poolInfo.address,
          protocol,
          pollerId: `poller-${ProtocolLabels[protocol]}-${
            tokenRegistry.getTokenData(poolInfo.coinA.address).symbol
          }-${tokenRegistry.getTokenData(poolInfo.coinB.address).symbol}`,
        }),
      });

      if (!poolDataResponse.ok) throw new Error("Failed to fetch pool data");
      const poolData = await poolDataResponse.json();
      setPoolTicks([...poolData.ticks].sort((a, b) => a.tick - b.tick) || []);
    } catch (error) {
      console.error("Error fetching ticks:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!poolInfo) return;
    fetchTicks();
  }, [poolInfo.address]);

  useEffect(() => {
    if (!poolInfo || !poolTicks.length) return;

    fetchCurrentPrice();

    const interval = setInterval(fetchCurrentPrice, 10000);

    return () => clearInterval(interval);
  }, [poolTicks.length, poolInfo]);

  useEffect(() => {
    if (currentPrice === null || currentPrice.equals(0) || !poolTicks.length) return;

    if (selectedRange) {
      const percentage = selectedRange / 100;
      const minPriceValue = currentPrice.mul(1 - percentage);
      const maxPriceValue = currentPrice.mul(1 + percentage);
      snapPrices(new Decimal(minPriceValue), new Decimal(maxPriceValue));
    } else if (positions && positions.length && minPrice.equals(0) && maxPrice.equals(0))
      snapPrices(
        (positions[1].strategy as ChaserInfo | InRangeInfo).position?.lower_price ?? new Decimal(0),
        (positions[0].strategy as ChaserInfo | InRangeInfo).position?.upper_price ?? new Decimal(0),
      );
  }, [currentPrice, selectedRange, poolTicks]);

  useEffect(() => {
    if (!open) {
      setPoolTicks([]);
    }
  }, [botDialog.open]);

  const findNearestTick = (
    price: Decimal,
    type?: "min" | "max",
  ): { tick: number; price: Decimal } | null => {
    if (!poolTicks.length) return null;

    const nearestTick = poolTicks.find((tick) =>
      type === "min"
        ? new Decimal(tick.price).lessThanOrEqualTo(price)
        : new Decimal(tick.price).greaterThanOrEqualTo(price),
    );

    return nearestTick ? { ...nearestTick, price: new Decimal(nearestTick.price) } : null;
  };

  const getNearestValidTickPrice = (
    targetPrice: Decimal,
    type?: "min" | "max",
  ): { price: Decimal; percentage: number; tick: number } => {
    const nearestTick = findNearestTick(targetPrice, type);

    if (!nearestTick || currentPrice === null || currentPrice.equals(0)) {
      return { price: targetPrice, percentage: 0, tick: 0 };
    }

    const percentage = nearestTick.price.sub(currentPrice).div(currentPrice).mul(100).toNumber();

    return {
      price: nearestTick.price,
      percentage,
      tick: nearestTick.tick,
    };
  };

  const snapPrices = (min: Decimal, max: Decimal) => {
    if (
      document.activeElement === minPriceInputRef.current ||
      document.activeElement === maxPriceInputRef.current
    ) {
      return;
    }

    const {
      price: snappedMinPrice,
      percentage: minPercent,
      tick: minTick,
    } = getNearestValidTickPrice(min);
    const {
      price: snappedMaxPrice,
      percentage: maxPercent,
      tick: maxTick,
    } = getNearestValidTickPrice(max);

    setMinPrice(snappedMinPrice);
    setMaxPrice(snappedMaxPrice);
    setMinPriceInput(snappedMinPrice.toFixed(8));
    setMaxPriceInput(snappedMaxPrice.toFixed(8));
    setMinPricePercentage(minPercent);
    setMaxPricePercentage(maxPercent);
    setTickRange(Math.ceil(Math.abs(maxTick - minTick) / (poolInfo?.tickSpacing * 2)));
  };

  const EditTicks = ({ type }: { type: "min" | "max" }) => {
    return (
      <div className="flex">
        <Button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const tick = [...poolTicks].findLast((item) =>
              new Decimal(item.price).lessThan(type === "max" ? maxPrice : minPrice),
            );
            if (!tick) return;
            setSelectedRange(null);
            snapPrices(
              type === "max" ? minPrice : new Decimal(tick.price),
              type === "max" ? new Decimal(tick.price) : maxPrice,
            );
          }}
          variant="ghost"
          size="sm"
        >
          <IconMinus />
        </Button>
        <Button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const tick = poolTicks.find((item) =>
              new Decimal(item.price).greaterThan(type === "max" ? maxPrice : minPrice),
            );
            if (!tick) return;
            setSelectedRange(null);
            snapPrices(
              type === "max" ? minPrice : new Decimal(tick.price),
              type === "max" ? new Decimal(tick.price) : maxPrice,
            );
          }}
          variant="ghost"
          size="sm"
        >
          <IconPlus />
        </Button>
      </div>
    );
  };

  return (
    <Card className="w-full border border-border p-4">
      <CardContent className="p-0">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Current Price ({tokenRegistry.getTokenData(poolInfo.coinB.address).symbol} per{" "}
              {tokenRegistry.getTokenData(poolInfo.coinA.address).symbol})
            </span>
            <div className="flex items-center gap-2">
              {loading && <Loader size={16} className="animate-spin" />}
              <span className="font-medium">
                {currentPrice ? currentPrice.toFixed(5) : "Loading..."}
              </span>
            </div>
          </div>

          {/* Percentage Selection Buttons */}
          <div className="grid grid-cols-4 gap-2 rounded-md bg-secondary p-1">
            {presetRanges.map((range) => (
              <Button
                key={range}
                variant={selectedRange === range ? "default" : "ghost"}
                size="sm"
                className="h-9"
                onClick={() => setSelectedRange(range)}
                disabled={disabled}
              >
                ± {range}
              </Button>
            ))}
            <Input
              id="customRange"
              value={selectedRange ?? NaN}
              onChange={(e) => setSelectedRange(parseInt(e.target.value))}
              className="text-center focus-visible:ring-transparent"
              type="number"
              min="1"
              placeholder="custom"
            />
          </div>

          {/* Min and Max Price Inputs */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="minPrice" className="text-sm flex justify-between">
                Min Price
                <EditTicks type="min" />
              </Label>
              <Input
                id="minPrice"
                ref={minPriceInputRef}
                value={minPriceInput}
                onChange={(e) => setMinPriceInput(e.target.value)}
                onBlur={() => {
                  setSelectedRange(null);
                  snapPrices(new Decimal(minPriceInput), maxPrice);
                }}
                type="number"
                className="focus-visible:ring-transparent"
                disabled={disabled || loading}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="maxPrice" className="text-sm flex justify-between">
                Max Price
                <EditTicks type="max" />
              </Label>
              <Input
                id="maxPrice"
                ref={maxPriceInputRef}
                value={maxPriceInput}
                onChange={(e) => setMaxPriceInput(e.target.value)}
                onBlur={() => {
                  setSelectedRange(null);
                  snapPrices(minPrice, new Decimal(maxPriceInput));
                }}
                type="number"
                className="focus-visible:ring-transparent"
                disabled={disabled || loading}
              />
            </div>
          </div>

          {/* Position Range Visualization */}
          <div className="relative h-16 w-full bg-secondary/50 rounded-md overflow-hidden">
            {currentPrice && (
              <>
                {/* Current Price Line */}
                <div
                  className="absolute top-0 bottom-0 border-l border-primary"
                  style={{
                    left: "50%",
                    transform: "translateX(-50%)",
                  }}
                ></div>

                {/* Range Indicators */}
                {minPrice && maxPrice && (
                  <>
                    <div
                      className="absolute top-0 bottom-0 bg-primary/20"
                      style={{
                        left: `${50 - Math.abs(minPricePercentage)}%`,
                        right: `${50 - Math.abs(maxPricePercentage)}%`,
                      }}
                    ></div>
                    <div
                      className="absolute top-0 bottom-0 border-l border-amber-500"
                      style={{ left: `${50 - Math.abs(minPricePercentage)}%` }}
                    >
                      <div
                        className="bg-amber-500 text-xs text-black px-1 mt-1 relative"
                        style={{ right: `100%` }}
                      >
                        {minPricePercentage.toFixed(2)}%
                      </div>
                    </div>
                    <div
                      className="absolute top-0 bottom-0 border-l border-amber-500"
                      style={{ left: `${50 + Math.abs(maxPricePercentage)}%` }}
                    >
                      <div className="bg-amber-500 text-xs text-black px-1 mt-1">
                        +{maxPricePercentage.toFixed(2)}%
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
