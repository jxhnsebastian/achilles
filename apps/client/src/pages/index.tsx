import Sidebar from "@/components/Sidebar";

export default function Home() {
  return (
    <Sidebar>
      <div className={`flex flex-1 items-center justify-center`}>
        <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
          <h1 className="text-4xl font-bold">Achilles</h1>
        </main>
      </div>
    </Sidebar>
  );
}
