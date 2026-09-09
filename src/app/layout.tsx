import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "@fontsource-variable/sora";

import "./globals.css";

export const metadata: Metadata = {
  title: "Voidstation",
  description: "Server status dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
