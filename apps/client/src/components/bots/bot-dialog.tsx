import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGlobalContext } from "../context/GlobalContext";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState, useEffect } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { Protocol, StrategyType, StrategyParams, GenericPoolInfo, BotStatus } from "@/lib/types";
import { ProtocolLabels, StrategyLabels } from "@achilles/utils";
import Decimal from "decimal.js";
import { Loader, RefreshCwIcon } from "lucide-react";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { tokenRegistry } from "@/lib/tokens";
import { CoinIcon } from "./bot-table";
import { useRouter } from "next/navigation";
import { Separator } from "../ui/separator";
import { TickRangeInput } from "./ticks";
import { Switch } from "../ui/switch";

export default function BotDialog() {
  const { botDialog, setBotDialog, getFordefiWallets, wallets, getBots, loading } =
    useGlobalContext();
  const router = useRouter();
  const isEditMode = !!botDialog.bot;

  // Form state
  const [botId, setBotId] = useState<string>(botDialog.bot?.botId || "");
  const [selectedWallet, setSelectedWallet] = useState<string>(botDialog.bot?.sender || "");
  const [protocol, setProtocol] = useState<Protocol>(botDialog.bot?.protocol || Protocol.CETUS);
  const [strategy, setStrategy] = useState<StrategyType>(
    botDialog.bot?.strategy || StrategyType.INRANGE,
  );

  const [poolId, setPoolId] = useState<string>(botDialog.bot?.poolId || "");
  const [slippage, setSlippage] = useState<number>(botDialog.bot?.slippage || 0.1);
  const [coinAAmount, setCoinAAmount] = useState<string>("");
  const [coinBAmount, setCoinBAmount] = useState<string>("");
  const [tickRange, setTickRange] = useState<number>(botDialog.bot?.params.tickRange || 10);
  const [continueFlag, setCointinueFlag] = useState<boolean>(false);

  // State
  const [poolInfo, setPoolInfo] = useState<GenericPoolInfo | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [poolLoading, setPoolLoading] = useState<boolean>(false);

  useEffect(() => {
    if (botDialog.bot) {
      setBotId(botDialog.bot.botId);
      setSelectedWallet(botDialog.bot.sender);
      setProtocol(botDialog.bot.protocol);
      setStrategy(botDialog.bot.strategy);
      setPoolId(botDialog.bot.poolId);
      setSlippage(botDialog.bot.slippage);
    }
  }, [botDialog.bot]);

  // Fetch wallets
  useEffect(() => {
    if (!Object.keys(wallets).length) getFordefiWallets();
  }, []);

  // Fetch pool info when pool ID changes
  useEffect(() => {
    const fetchPoolInfo = async () => {
      if (!poolId || !protocol) return;

      setPoolLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/pool?protocol=${protocol}&poolId=${poolId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch pool info: ${response.statusText}`);
        }

        const data: GenericPoolInfo = (await response.json()).pool;
        await tokenRegistry.indexTokens([data.coinA.address, data.coinB.address]);
        setPoolInfo(data);
      } catch (err) {
        console.log(err);
        setError("Failed to fetch pool information");
        setPoolInfo(null);
      } finally {
        setPoolLoading(false);
      }
    };

    if (poolId) {
      fetchPoolInfo();
    }
  }, [poolId, protocol]);

  const handleSubmit = async () => {
    // Validate form
    if (!botId || !selectedWallet || poolId === "" || !coinAAmount || !coinBAmount) {
      setError("Please fill in all required fields");
      return;
    }

    if (!tickRange || tickRange === 0) {
      setError("Invalid tick range!");
      return;
    }

    if (!poolInfo) {
      setError("Pool information is required. Please enter a valid pool ID.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params: StrategyParams = {
        coinA: {
          coinType: poolInfo.coinA.address,
          amount: new Decimal(coinAAmount || 0),
        },
        coinB: {
          coinType: poolInfo.coinB.address,
          amount: new Decimal(coinBAmount || 0),
        },
        tickRange: tickRange,
      };

      if (isEditMode) {
        // Update existing bot
        const response = await fetch("/api/bots/update", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            botId: botId,
            action: "update",
            params: params,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to update bot");
        }
      } else {
        // Create new bot
        const response = await fetch("/api/bots/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            botId: botId,
            sender: selectedWallet,
            protocol: protocol,
            strategy: strategy,
            poolId: poolId,
            slippage: slippage,
            params: params,
            pollerId: `poller-${ProtocolLabels[protocol]}-${
              tokenRegistry.getTokenData(poolInfo.coinA.address).symbol
            }-${tokenRegistry.getTokenData(poolInfo.coinB.address).symbol}`,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to create bot");
        }
      }

      // Close dialog on success
      setBotDialog({ open: false });
      getBots();
      router.push("/lp/bots");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const update = async (action: string) => {
    setIsLoading(true);
    setError(null);
    if (!["stop", "start"].includes(action)) {
      setError("Invalid action!");
      return;
    }
    try {
      let params: StrategyParams | undefined = undefined;

      if (action === "start") {
        if (!poolInfo) {
          setError("Failed to get Pool information.");
          return;
        }
        if (!coinAAmount || !coinBAmount) {
          setError("Coin amounts are required to restart!");
          return;
        }
        if (!tickRange || tickRange === 0) {
          setError("Invalid tick range!");
          return;
        }

        params = {
          coinA: {
            coinType: poolInfo.coinA.address,
            amount: new Decimal(coinAAmount),
          },
          coinB: {
            coinType: poolInfo.coinB.address,
            amount: new Decimal(coinBAmount),
          },
          tickRange: tickRange,
        };
      }
      const response = await fetch("/api/bots/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          botId: botId,
          action,
          params,
          continueFlag,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to ${action} bot`);
      }

      // Close dialog on success
      setBotDialog({ open: false });
      getBots();
      router.push("/lp/bots");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const sweep = async () => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/bots/sweep", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to sweep!`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    }
    setIsLoading(false);
  };

  const stopPoller = async () => {
    try {
      const response = await fetch(`/api/pool/stop?poolId=${poolInfo?.address}`);
      if (!response.ok) throw new Error("Failed to stop poller");
    } catch (error) {
      console.error("Error stopping poller:", error);
    }
  };

  return (
    <Dialog
      open={botDialog.open}
      onOpenChange={(open) => {
        if (!open) stopPoller();
        setCointinueFlag(false);
        setBotDialog((prev) => ({ ...prev, open }));
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Update Bot" : "Create New Bot"}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update your bot configuration. Click save when you're done."
              : "Configure a new bot for liquidity provisioning. Fill in all fields to continue."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 py-4">
          {/* Bot ID */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="botId" className="text-right">
              Bot ID
            </Label>
            <Input
              id="botId"
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
              className="col-span-3"
              disabled={isEditMode}
              placeholder="Enter a unique ID for your bot"
            />
          </div>

          {/* Wallet Selection */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="wallet" className="text-right">
              Wallet
            </Label>
            <div className="flex items-center gap-2">
              <Select
                value={selectedWallet}
                onValueChange={setSelectedWallet}
                disabled={isEditMode}
              >
                <SelectTrigger id="wallet" className="col-span-3">
                  <SelectValue placeholder="Select a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(wallets).map((address) => (
                    <SelectItem key={address} value={address}>
                      {wallets[address].id}
                      {` (${address.substring(0, 4)}...)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                className="data-[state=open]:bg-muted text-muted-foreground flex size-8"
                size="icon"
                disabled={loading}
                onClick={getFordefiWallets}
              >
                <RefreshCwIcon className={loading ? "animate-spin" : ""} />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 items-center gap-4">
            {/* Protocol */}
            <div className="w-full flex justify-between items-center gap-2">
              <Label htmlFor="protocol" className="text-right">
                Protocol
              </Label>
              <Select
                value={protocol.toString()}
                onValueChange={(value) => setProtocol(parseInt(value))}
                disabled={isEditMode}
              >
                <SelectTrigger id="protocol" className="col-span-3">
                  <SelectValue placeholder="Select protocol" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ProtocolLabels).map(([key, value]) => (
                    <SelectItem key={key} value={key}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Strategy */}
            <div className="w-full flex justify-between items-center gap-2">
              <Label htmlFor="strategy" className="text-right">
                Strategy
              </Label>
              <Select
                value={strategy.toString()}
                onValueChange={(value) => setStrategy(parseInt(value))}
                disabled={isEditMode}
              >
                <SelectTrigger id="strategy" className="col-span-3">
                  <SelectValue placeholder="Select strategy" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(StrategyLabels).map(([key, value]) => (
                    <SelectItem key={key} value={key}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* Pool ID */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="poolId" className="text-right">
              Pool ID
            </Label>
            <div className="col-span-3 flex items-center gap-2">
              <Input
                id="poolId"
                value={poolId}
                onChange={(e) => setPoolId(e.target.value)}
                className="flex-1 focus-visible:ring-transparent"
                disabled={isEditMode}
                placeholder="Enter pool ID"
              />
              {poolLoading && <Loader size={20} className="animate-spin" />}
            </div>
          </div>

          {/* Pool Info - Display when available */}
          {poolInfo && (
            <>
              <Label htmlFor="continueFlag" className="text-right">
                {continueFlag ? "Additional Funds" : "Starting Funds"}
              </Label>
              <CoinCard
                id={"coinAAmount"}
                label="Coin A"
                value={coinAAmount}
                setValue={setCoinAAmount}
                address={poolInfo.coinA.address}
              />
              <CoinCard
                id={"coinBAmount"}
                label="Coin B"
                value={coinBAmount}
                setValue={setCoinBAmount}
                address={poolInfo.coinB.address}
              />
              {/* Tick Range */}
              <div className="grid grid-cols-1 items-center gap-4">
                <Label htmlFor="tickRange" className="text-right">
                  Tick Range
                </Label>
                <TickRangeInput
                  poolInfo={poolInfo}
                  protocol={protocol}
                  setTickRange={setTickRange}
                  positions={botDialog.bot?.positions}
                />
              </div>
            </>
          )}

          {isEditMode && botDialog.bot?.status === BotStatus.STOP && (
            <div className="flex items-center space-x-2">
              <Switch
                checked={continueFlag}
                onCheckedChange={(checked) => setCointinueFlag(checked)}
                id="continueFlag"
              />
              <Label htmlFor="continueFlag">Continue from last close balances.</Label>
            </div>
          )}

          {/* Slippage */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="slippage" className="text-right">
              Slippage (%)
            </Label>
            <Input
              id="slippage"
              value={slippage}
              onChange={(e) => setSlippage(parseFloat(e.target.value))}
              className="col-span-3 focus-visible:ring-transparent"
              type="number"
              step="0.1"
              min="0.1"
              max="5"
              placeholder="Enter slippage percentage"
            />
          </div>
        </div>
        <Separator />
        {isEditMode && (
          <>
            <div className="w-full flex items-center gap-4">
              <Button
                variant="secondary"
                onClick={sweep}
                disabled={isLoading || botDialog.bot?.status === BotStatus.START}
                className="flex flex-1"
              >
                {isLoading ? "Processing..." : "Sweep"}
              </Button>
              <Button
                variant={botDialog.bot?.status === BotStatus.STOP ? "secondary" : "destructive"}
                onClick={() => {
                  update(botDialog.bot?.status === BotStatus.STOP ? "start" : "stop");
                }}
                disabled={
                  isLoading ||
                  (botDialog.bot?.status !== BotStatus.STOP &&
                    botDialog.bot?.status !== BotStatus.RUN)
                }
                className="flex flex-1"
              >
                {isLoading
                  ? "Processing..."
                  : botDialog.bot?.status === BotStatus.STOP
                    ? "Restart"
                    : "Rug"}
              </Button>
            </div>
            <Separator />
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              stopPoller();
              setCointinueFlag(false);
              setBotDialog((prev) => ({ ...prev, open: false }));
            }}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={handleSubmit}
            disabled={
              isLoading ||
              (botDialog.bot &&
                botDialog.bot?.status !== BotStatus.RUN &&
                botDialog.bot?.status !== BotStatus.START)
            }
          >
            {isLoading ? "Processing..." : isEditMode ? "Update Bot" : "Create Bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CoinCard = ({
  id,
  label,
  value,
  setValue,
  address,
}: {
  id: string;
  label: string;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  address: string;
}) => {
  const coin = tokenRegistry.getTokenData(address);
  return (
    <Card className="@container/card py-4 gap-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="flex gap-5 items-center text-xl font-semibold tabular-nums @[250px]/card:text-2xl">
          <div className="flex gap-2 items-center font-medium">
            <CoinIcon url={coin.iconUrl} />
            {coin.symbol}
          </div>
          <Input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="flex flex-1 focus-visible:ring-transparent"
            type="number"
            step="0.000001"
            min="0"
            placeholder={`Enter amount for ${label}`}
          />
        </CardTitle>
      </CardHeader>

      <CardFooter className="flex-col items-start gap-1.5 text-sm px-4">
        <div className="text-muted-foreground">{address}</div>
      </CardFooter>
    </Card>
  );
};
