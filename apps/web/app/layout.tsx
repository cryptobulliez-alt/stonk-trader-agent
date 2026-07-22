import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STONK TRADER SHELL",
  description: "Local permissionless StonkBroker TBA agent shell",
  icons: {
    icon: [{ url: "/favicon.ico", type: "image/png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
