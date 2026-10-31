import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pokescan",
  description: "Self-hosted Pokémon TCG collection manager",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#080b12",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
