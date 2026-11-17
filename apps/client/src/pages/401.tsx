import { Button } from "@/components/ui/button";
import { GalleryVerticalEnd } from "lucide-react";
import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="bg-dark relative hidden lg:block">
        <div className="absolute inset-0 flex items-center justify-center text-5xl font-bold text-white">Achilles</div>
      </div>
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <a href="#" className="flex items-center gap-2 font-medium">
            <div className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md">
              <GalleryVerticalEnd className="size-4" />
            </div>
            Achilles
          </a>
        </div>
        <div className="flex flex-1 gap-2 items-center justify-center">
          <span>Access Denied!</span>
          <Button
            variant="ghost"
            asChild
            size="sm"
            className="hidden sm:flex dark:text-foreground"
            // onClick={() => signOut()}
          >
            <Link href="/login">login again</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
