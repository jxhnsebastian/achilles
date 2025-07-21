import Sidebar from "@/components/Sidebar";
import { PollerTable } from "@/components/bots/pollers";
import { useGlobalContext } from "@/components/context/GlobalContext";
import { useEffect } from "react";

export default function Page() {
  const {pollers, getPollers } = useGlobalContext();
  useEffect(() => {
    if (!pollers.length) getPollers();
  }, []);
  return (
    <Sidebar>
      <div className="@container/main flex flex-1 flex-col gap-2">
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PollerTable />
        </div>
      </div>
    </Sidebar>
  );
}
