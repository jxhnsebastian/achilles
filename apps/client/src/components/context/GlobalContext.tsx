"use client";

import { Bot, BotDialogData, Poller } from "@/lib/types";
import { FordefiWallets } from "@/lib/types";
import { convertBotConfig } from "@achilles/utils";
import { Memory } from "@achilles/utils";
import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useRef,
} from "react";
import { tokenRegistry } from "@/lib/tokens";

interface PriceData {
  [address: string]: number;
}

interface GlobalContextProps {
  loading: boolean;
  setLoading: (value: boolean) => void;
  botsLoading: boolean;
  setBotsLoading: (value: boolean) => void;
  botDialog: BotDialogData;
  setBotDialog: React.Dispatch<React.SetStateAction<BotDialogData>>;
  wallets: FordefiWallets;
  setWallets: React.Dispatch<React.SetStateAction<FordefiWallets>>;
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  pollers: Poller[];
  setPollers: React.Dispatch<React.SetStateAction<Poller[]>>;
  prices: PriceData;
  setPrices: React.Dispatch<React.SetStateAction<PriceData>>;

  getFordefiWallets: () => Promise<void>;
  getBots: () => Promise<void>;
  getPollers: () => Promise<void>;
}

const GlobalContext = createContext<GlobalContextProps | undefined>(undefined);

interface GlobalProviderProps {
  children: ReactNode;
}

export const GlobalProvider: React.FC<GlobalProviderProps> = ({ children }) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [botsLoading, setBotsLoading] = useState<boolean>(false);
  const [botDialog, setBotDialog] = useState<BotDialogData>({
    open: false,
  });
  const [wallets, setWallets] = useState<FordefiWallets>({});
  const [bots, setBots] = useState<Bot[]>([]);
  const [pollers, setPollers] = useState<Poller[]>([]);
  const [prices, setPrices] = React.useState<PriceData>({});

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const getFordefiWallets = async () => {
    if (loading) return;
    setLoading(true);

    try {
      const response = await fetch("/api/wallets");

      if (!response.ok) {
        throw new Error(`Failed to fetch wallets: ${response.status}`);
      }

      const data = (await response.json()) as FordefiWallets;
      setWallets(data);
      setLoading(false);
    } catch (error) {
      console.error("Error fetching Fordefi wallets:", error);
      setLoading(false);
    }
  };

  const getBots = async () => {
    setBotsLoading(true);

    try {
      const memory = new Memory();
      const response = await fetch("/api/bots");

      if (!response.ok) {
        throw new Error(`Failed to fetch bots: ${response.status}`);
      }

      const data = (await response.json()) as any[];
      const parsedData: Bot[] = data.map((item) => ({
        positions: item.positions.map((position: any) =>
          memory.convertFromDatabase(position)
        ),
        ...convertBotConfig(item),
      }));
      console.log(parsedData);

      const tokens = Array.from(
        new Set<string>(
          parsedData.flatMap((bot) => [
            bot.params.coinA.coinType,
            bot.params.coinB.coinType,
          ])
        )
      );

      const priceObject: PriceData = {};
      tokens.forEach((token) => (priceObject[token] = 0));
      setPrices(priceObject);

      setBots(parsedData);
      setBotsLoading(false);
    } catch (error) {
      console.error("Error fetching bots:", error);
      setBotsLoading(false);
    }
  };

  const getPollers = async (poolId?: string) => {
    try {
      const response = await fetch(
        `/api/pool/pollers${poolId ? `/${poolId}` : ""}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch pollers: ${response.status}`);
      }

      const data = (await response.json()) as Poller[];
      console.log(data);

      setPollers(data);
    } catch (error) {
      console.error("Error fetching bots:", error);
      setBotsLoading(false);
    }
  };

  const fetchPrices = async () => {
    if (Object.keys(prices).length === 0) return;

    try {
      const tokenArray = Object.keys(prices);
      await tokenRegistry.indexTokens(tokenArray);
      const newPrices = await tokenRegistry.getTokensPrices(tokenArray);
      setPrices(newPrices);
    } catch (error) {
      console.error("Error fetching prices:", error);
    }
  };

  useEffect(() => {
    console.log("prices length changed,", prices);
    if (Object.keys(prices).length > 0) {
      fetchPrices();

      intervalRef.current = setInterval(() => {
        fetchPrices();
      }, 10000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [Object.keys(prices).length]);

  return (
    <GlobalContext.Provider
      value={{
        loading,
        setLoading,
        botsLoading,
        setBotsLoading,
        botDialog,
        setBotDialog,
        wallets,
        setWallets,
        bots,
        setBots,
        pollers,
        setPollers,
        getFordefiWallets,
        getBots,
        getPollers,
        prices,
        setPrices,
      }}
    >
      {children}
    </GlobalContext.Provider>
  );
};

export const useGlobalContext = () => {
  const context = useContext(GlobalContext);
  if (!context) {
    throw new Error("useGlobalContext must be used within a GlobalProvider");
  }
  return context;
};
