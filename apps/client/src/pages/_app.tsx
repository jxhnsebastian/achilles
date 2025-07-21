import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { SessionProvider } from "next-auth/react";
import { Geist, Geist_Mono } from "next/font/google";
import { GlobalProvider } from "@/components/context/GlobalContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function App({
  Component,
  pageProps: { session, ...pageProps },
}: AppProps) {
  return (
    <SessionProvider session={session}>
      <GlobalProvider>
        <div
          className={`${geistSans.className} ${geistMono.className} max-h-[100dvh] overflow-y-hidden`}
        >
          <Component {...pageProps} />
        </div>
      </GlobalProvider>
    </SessionProvider>
  );
}
