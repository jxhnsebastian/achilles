import * as React from "react";
import {
  IconChartBar,
  IconDashboard,
  IconDatabase,
  IconFolder,
  IconHelp,
  IconReport,
  IconSearch,
  IconSettings,
  IconUsers,
  IconHome,
  IconPropeller,
  IconDroplet,
  IconRobot,
  IconEyeDollar,
} from "@tabler/icons-react";

import { NavDocuments } from "@/components/sidebar/nav-documents";
import { NavMain } from "@/components/sidebar/nav-main";
import { NavSecondary } from "@/components/sidebar/nav-secondary";
import { NavUser } from "@/components/sidebar/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import Image from "next/image";
import { useSession } from "next-auth/react";
import { Bot } from "lucide-react";
import Link from "next/link";

export interface SidebarItem {
  title: string;
  url: string;
  icon: any;
  pages?: SidebarItem[];
}

interface SidebarData {
  [item: string]: SidebarItem[];
}
const data: SidebarData = {
  navMain: [
    {
      title: "Home",
      url: "/",
      icon: IconHome,
    },
    {
      title: "Dashboard",
      url: "/dashboard",
      icon: IconDashboard,
    },
    {
      title: "Parlays",
      url: "/parlays",
      icon: IconEyeDollar,
    },
    {
      title: "Pools",
      url: "#",
      icon: IconDroplet,
      pages: [
        {
          title: "Bots",
          url: "/lp/bots",
          icon: Bot,
        },
        {
          title: "Pollers",
          url: "/lp/pollers",
          icon: IconPropeller,
        },
      ],
    },
    {
      title: "Market Maker",
      url: "#",
      icon: IconDroplet,
      pages: [
        {
          title: "New",
          url: "/mm/new",
          icon: IconRobot,
        },
      ],
    },
    {
      title: "Analytics",
      url: "#",
      icon: IconChartBar,
    },
    {
      title: "Projects",
      url: "#",
      icon: IconFolder,
    },
    {
      title: "Team",
      url: "#",
      icon: IconUsers,
    },
  ],
  navSecondary: [
    {
      title: "Settings",
      url: "#",
      icon: IconSettings,
    },
    {
      title: "Get Help",
      url: "#",
      icon: IconHelp,
    },
    {
      title: "Search",
      url: "#",
      icon: IconSearch,
    },
  ],
  documents: [
    {
      title: "Data Library",
      url: "#",
      icon: IconDatabase,
    },
    {
      title: "Reports",
      url: "#",
      icon: IconReport,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession();
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
              <Link href="/" className="relative">
                <Image
                  src={"/favicon.ico"}
                  alt={"Achilles"}
                  width={25}
                  height={25}
                  sizes="w-5 h-5"
                  className="object-contain"
                />
                <span className="text-base font-semibold">Achilles</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavDocuments items={data.documents} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={{
            name: session?.user?.name ?? "",
            email: session?.user?.email ?? "",
            avatar: session?.user?.image ?? "",
          }}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
