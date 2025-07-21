import Sidebar from "@/components/Sidebar";
import { BotDataTable } from "@/components/bots/bot-table";
import { useGlobalContext } from "@/components/context/GlobalContext";
import { useEffect } from "react";

export default function Page() {
  const { bots, getBots } = useGlobalContext();
  useEffect(() => {
    if (!bots.length) getBots();
  }, []);
  return (
    <Sidebar>
      <div className="@container/main flex flex-1 flex-col gap-2">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <BotDataTable />
        </div>
      </div>
    </Sidebar>
  );
}
