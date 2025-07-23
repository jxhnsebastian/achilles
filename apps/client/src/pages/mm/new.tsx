import { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  Play,
  Square,
  Settings,
  TrendingUp,
  TrendingDown,
  Activity,
  DollarSign,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { BotStatus } from "@achilles/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tickers } from "@/lib/tokens";

export interface BotParameters {
  id: string;
  orderSize: number;
  maxPositionSize: number;
  gamma: number;
  ticker: string;
  exchange: string;
  duration: number;
  status: BotStatus;
}

interface BotMetrics {
  timestamp: string;
  currentGamma: number;
  sigma: number;
  qstar: number;
  qValue: number;
  unrealizedPnl: number;
  totalPnl: number;
  inventoryValue: number;
  midprice: number;
  spread: number;
  bidPrice: number;
  askPrice: number;
  inventory: number;
  realizedPnl: number;
  positionValue: number;
  fillRateLong: number;
  fillRateShort: number;
}

export default function MarketMakerPage() {
  const [isActive, setIsActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parameters, setParameters] = useState<BotParameters>({} as BotParameters);

  const [metrics, setMetrics] = useState<BotMetrics[]>([]);

  // Simple dummy data - easily replaceable with real bot data
  const [currentMetrics, setCurrentMetrics] = useState<BotMetrics>({
    timestamp: new Date().toISOString(),
    currentGamma: 4.8,
    sigma: 0.18,
    qstar: 0.0,
    qValue: -0.05,
    unrealizedPnl: 25.5,
    totalPnl: 187.25,
    inventoryValue: -150.3,
    midprice: 117150.25,
    spread: 120.5,
    bidPrice: 117090.0,
    askPrice: 117210.5,
    inventory: -0.00128,
    realizedPnl: 161.75,
    positionValue: -150.3,
    fillRateLong: 85.2,
    fillRateShort: 78.9,
  });

  // Load initial parameters from API
  useEffect(() => {
    // Generate bot ID on client to avoid hydration mismatch
    if (!parameters.id) {
      setParameters((prev) => ({
        ...prev,
      }));
    }

    loadParameters();
    checkBotStatus();
  }, []);

  // Real-time metrics updates when bot is active
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch("/api/market-maker/metrics?latest=true");
        if (response.ok) {
          const latestMetric = await response.json();

          // Convert API response to our metrics format
          const formattedMetric: BotMetrics = {
            timestamp: latestMetric.timestamp,
            currentGamma: latestMetric.gamma,
            sigma: latestMetric.sigma,
            qstar: latestMetric.qStar,
            qValue: latestMetric.qStarDynamic,
            unrealizedPnl: latestMetric.unrealizedPnl,
            totalPnl: latestMetric.totalPnl,
            inventoryValue: latestMetric.positionValue,
            midprice: latestMetric.midprice,
            spread: latestMetric.spread,
            bidPrice: latestMetric.bidPrice,
            askPrice: latestMetric.askPrice,
            inventory: latestMetric.inventory,
            realizedPnl: latestMetric.realizedPnl,
            positionValue: latestMetric.positionValue,
            fillRateLong: latestMetric.fillRateLong,
            fillRateShort: latestMetric.fillRateShort,
          };

          setCurrentMetrics(formattedMetric);
          setMetrics((prev) => [...prev.slice(-50), formattedMetric]);
        }
      } catch (error) {
        console.error("Failed to fetch metrics:", error);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isActive]);

  const loadParameters = async () => {
    try {
      const response = await fetch("/api/market-maker/parameters");
      if (response.ok) {
        const params = await response.json();
        setParameters(params);
      }
    } catch (error) {
      console.error("Failed to load parameters:", error);
      toast.error("Failed to load saved parameters");
    }
  };

  const checkBotStatus = async () => {
    try {
      const response = await fetch("/api/market-maker/control");
      if (response.ok) {
        const status = await response.json();
        setIsActive(status.isActive);
      }
    } catch (error) {
      console.error("Failed to check bot status:", error);
    }
  };

  const handleParameterChange = (key: keyof BotParameters, value: number | string) => {
    setParameters((prev) => ({ ...prev, [key]: value }));
  };

  const handleStartBot = async () => {
    setLoading(true);
    console.log(parameters);
    try {
      const response = await fetch("/api/mm/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parameters }),
      });

      if (response.ok) {
        // setIsActive(true);
        toast.success("Market maker bot started successfully");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to start bot");
      }
    } catch (error) {
      console.error("Failed to start bot:", error);
      toast.error("Failed to start bot");
    } finally {
      setLoading(false);
    }
  };

  const handleStopBot = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/market-maker/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });

      if (response.ok) {
        setIsActive(false);
        toast.success("Market maker bot stopped successfully");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to stop bot");
      }
    } catch (error) {
      console.error("Failed to stop bot:", error);
      toast.error("Failed to stop bot");
    } finally {
      setLoading(false);
    }
  };

  const refreshMetrics = async () => {
    try {
      const response = await fetch("/api/market-maker/metrics?count=50");
      if (response.ok) {
        const historicalMetrics = await response.json();
        const formattedMetrics = historicalMetrics.map((m: any) => ({
          timestamp: m.timestamp,
          currentGamma: m.gamma,
          sigma: m.sigma,
          qstar: m.qStar,
          qValue: m.qStarDynamic,
          unrealizedPnl: m.unrealizedPnl,
          totalPnl: m.totalPnl,
          inventoryValue: m.positionValue,
          midprice: m.midprice,
          spread: m.spread,
          bidPrice: m.bidPrice,
          askPrice: m.askPrice,
          inventory: m.inventory,
          realizedPnl: m.realizedPnl,
          positionValue: m.positionValue,
          fillRateLong: m.fillRateLong,
          fillRateShort: m.fillRateShort,
        }));
        setMetrics(formattedMetrics);
        toast.success("Metrics refreshed");
      }
    } catch (error) {
      console.error("Failed to refresh metrics:", error);
      toast.error("Failed to refresh metrics");
    }
  };
  const exchanges = ["Binance", "Bybit", "Hyperliquid"];
  return (
    <Sidebar>
      <div className="@container/main flex flex-1 flex-col gap-4 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Market Making Bot</h1>
            <p className="text-muted-foreground">
              Control orderbook market making parameters and monitor performance
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={isActive ? "default" : "secondary"}>
              {isActive ? "Active" : "Inactive"}
            </Badge>
            {isActive ? (
              <Button onClick={handleStopBot} variant="destructive" size="sm" disabled={loading}>
                {loading ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 mr-2" />
                )}
                Stop Bot
              </Button>
            ) : (
              <Button onClick={handleStartBot} size="sm" disabled={loading}>
                {loading ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-2" />
                )}
                Start Bot
              </Button>
            )}
          </div>
        </div>

        <Tabs defaultValue="control" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="control">Control Panel</TabsTrigger>
            <TabsTrigger value="monitoring">Live Monitoring</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>

          {/* Control Panel Tab */}
          <TabsContent value="control" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Bot Parameters
                </CardTitle>
                <CardDescription>Configure the market making bot parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="mb-4 p-3 bg-muted rounded-lg">
                  <Label className="text-sm font-medium">Bot ID</Label>
                  <div className="font-mono text-lg">{parameters.id ?? "New Bot"}</div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Main Parameters - Focus on gamma, q, qstar */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-base">Core Parameters</h3>
                    <div className="space-y-2">
                      <Label htmlFor="gamma">Gamma (Risk Aversion)</Label>
                      <Input
                        id="gamma"
                        type="number"
                        step="0.1"
                        value={parameters.gamma}
                        onChange={(e) =>
                          handleParameterChange("gamma", parseFloat(e.target.value) || 0)
                        }
                        placeholder="4.8"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="orderSize">Q (Order Size)</Label>
                      <Input
                        id="orderSize"
                        type="number"
                        step="0.001"
                        value={parameters.orderSize}
                        onChange={(e) =>
                          handleParameterChange("orderSize", parseFloat(e.target.value) || 0)
                        }
                        placeholder="0"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxPositionSize">Q Max (Max Position Size)</Label>
                      <Input
                        id="maxPositionSize"
                        type="number"
                        step="0.001"
                        value={parameters.maxPositionSize}
                        onChange={(e) =>
                          handleParameterChange("maxPositionSize", parseFloat(e.target.value) || 0)
                        }
                        placeholder="0"
                      />
                    </div>
                  </div>

                  {/* Additional Parameters - Collapsible or secondary */}
                  <div className="space-y-4 md:col-span-2">
                    <h3 className="font-semibold text-base">Additional Parameters</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="duration">Duration(minutes)</Label>
                        <Input
                          id="duration"
                          type="number"
                          value={parameters.duration}
                          onChange={(e) =>
                            handleParameterChange("duration", parseInt(e.target.value) || 0)
                          }
                          placeholder="1000"
                        />
                      </div>
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="exchange" className="text-right">
                          Ticker
                        </Label>
                        <div className="flex items-center gap-2">
                          <Select
                            value={parameters.ticker}
                            onValueChange={(value) => handleParameterChange("ticker", value || "")}
                            // disabled={isEditMode}
                          >
                            <SelectTrigger id="ticker" className="col-span-3">
                              <SelectValue placeholder="Select a ticker" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.keys(tickers).map((address) => (
                                <SelectItem key={address} value={address}>
                                  {address}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="exchange" className="text-right">
                          Exchange
                        </Label>
                        <div className="flex items-center gap-2">
                          <Select
                            value={parameters.exchange}
                            onValueChange={(value) =>
                              handleParameterChange("exchange", value || "")
                            }
                            // disabled={isEditMode}
                          >
                            <SelectTrigger id="exchange" className="col-span-3">
                              <SelectValue placeholder="Select a exchange" />
                            </SelectTrigger>
                            <SelectContent>
                              {exchanges.map((address) => (
                                <SelectItem key={address} value={address}>
                                  {address}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <Separator />
                <div className="flex gap-4">
                  {/* <Button onClick={handleSaveParameters} variant="outline" disabled={loading}>
                    {loading ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Save Parameters
                  </Button> */}
                  <Button onClick={handleStartBot} disabled={isActive || loading}>
                    Apply & Start
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Live Monitoring Tab */}
          <TabsContent value="monitoring" className="space-y-6">
            {/* Refresh Button */}
            <div className="flex justify-end">
              <Button onClick={refreshMetrics} variant="outline" size="sm">
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh Data
              </Button>
            </div>

            {/* Main Metrics Cards - Only the ones user specifically requested */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-muted-foreground">Total PNL</span>
                  </div>
                  <div className="text-2xl font-bold">
                    ${currentMetrics?.totalPnl?.toFixed(2) || "0.00"}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-blue-500" />
                    <span className="text-sm text-muted-foreground">Unrealized PNL</span>
                  </div>
                  <div className="text-2xl font-bold">
                    ${currentMetrics?.unrealizedPnl?.toFixed(2) || "0.00"}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-purple-500" />
                    <span className="text-sm text-muted-foreground">Current Gamma</span>
                  </div>
                  <div className="text-2xl font-bold">
                    {currentMetrics?.currentGamma?.toFixed(3) || "0.000"}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="w-4 h-4 text-orange-500" />
                    <span className="text-sm text-muted-foreground">Inventory Value</span>
                  </div>
                  <div className="text-2xl font-bold">
                    ${currentMetrics?.inventoryValue?.toFixed(2) || "0.00"}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* User's Specific Metrics - Only what was requested */}
            <div className="grid grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Core Parameters</CardTitle>
                  <CardDescription>The specific metrics you requested</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sigma:</span>
                    <span className="font-mono">{currentMetrics?.sigma?.toFixed(4) || "N/A"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Q*:</span>
                    <span className="font-mono">{currentMetrics?.qstar?.toFixed(4) || "N/A"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Q Value:</span>
                    <span className="font-mono">{currentMetrics?.qValue?.toFixed(4) || "N/A"}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Market Prices</CardTitle>
                  <CardDescription>Current bid/ask levels</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Bid Price:</span>
                    <span className="font-mono">
                      ${currentMetrics?.bidPrice?.toFixed(2) || "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ask Price:</span>
                    <span className="font-mono">
                      ${currentMetrics?.askPrice?.toFixed(2) || "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mid Price:</span>
                    <span className="font-mono">
                      ${currentMetrics?.midprice?.toFixed(2) || "N/A"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Analytics Tab */}
          <TabsContent value="analytics" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* PNL Chart */}
              <Card>
                <CardHeader>
                  <CardTitle>PNL Over Time</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={metrics}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                      />
                      <YAxis />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleString()}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, "PNL"]}
                      />
                      <Line
                        type="monotone"
                        dataKey="totalPnl"
                        stroke="#8884d8"
                        strokeWidth={2}
                        dot={false}
                        name="Total PNL"
                      />
                      <Line
                        type="monotone"
                        dataKey="unrealizedPnl"
                        stroke="#82ca9d"
                        strokeWidth={2}
                        dot={false}
                        name="Unrealized PNL"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Inventory Chart */}
              <Card>
                <CardHeader>
                  <CardTitle>Inventory Position</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={metrics}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                      />
                      <YAxis />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleString()}
                        formatter={(value: number) => [value.toFixed(4), "Inventory"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="inventory"
                        stroke="#ffc658"
                        fill="#ffc658"
                        fillOpacity={0.3}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Fill Rates */}
              <Card>
                <CardHeader>
                  <CardTitle>Fill Rates</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={metrics}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                      />
                      <YAxis />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleString()}
                        formatter={(value: number) => [`${value.toFixed(1)}%`, "Fill Rate"]}
                      />
                      <Line
                        type="monotone"
                        dataKey="fillRateLong"
                        stroke="#ff7300"
                        name="Long Fill Rate"
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="fillRateShort"
                        stroke="#00ff73"
                        name="Short Fill Rate"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Gamma Evolution */}
              <Card>
                <CardHeader>
                  <CardTitle>Gamma Evolution</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={metrics}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                      />
                      <YAxis />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleString()}
                        formatter={(value: number) => [value.toFixed(3), "Gamma"]}
                      />
                      <Line
                        type="monotone"
                        dataKey="currentGamma"
                        stroke="#8884d8"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </Sidebar>
  );
}
