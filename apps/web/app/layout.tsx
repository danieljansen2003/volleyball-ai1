import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VolleyVision AI",
  description: "Volleyball AI video analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}