import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import BotDialog from "./bots/bot-dialog";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <BotDialog />
      <SidebarInset>
        <SiteHeader />
        <div className={`flex flex-1 flex-col overflow-auto`}>{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
