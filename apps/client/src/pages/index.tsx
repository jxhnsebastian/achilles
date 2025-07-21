import Sidebar from "@/components/Sidebar";
import Image from "next/image";

export default function Home() {
  return (
    <Sidebar>
      <div className={`flex flex-1 items-center justify-center`}>
        <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
          <Image
            className="dark:invert"
            src="/favicon.ico"
            alt="Achilles"
            width={300}
            height={68}
            priority
          />
        </main>
      </div>
    </Sidebar>
  );
}
