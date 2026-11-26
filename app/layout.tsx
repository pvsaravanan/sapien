import type { Metadata } from "next";
import { Plus_Jakarta_Sans, VT323 } from "next/font/google";
import { TopNav } from "@/components/top-nav";
import "./globals.css";

const display = VT323({ subsets: ["latin"], weight: "400", variable: "--font-display" });
/** Every non-pixel face: body text, labels and controls. */
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Sapien",
  description: "Adaptive multi-agent learning: probe, plan, teach, practice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body className="min-h-screen">
        <TopNav />
        <main>{children}</main>
      </body>
    </html>
  );
}
