import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { accentStyles, adminThemeCss, loadBranding } from "../core/auth/branding";
import { documentLanguage } from "../core/i18n/admin";
import "../styles/admin.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Tansy",
  description: "Self-hosted content backend",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Forces dynamic rendering, which the per-request CSP nonce set in proxy.ts requires.
  await headers();
  const theme = adminThemeCss();
  // After the theme's tokens, so the colour chosen under Settings wins.
  const accent = accentStyles((await loadBranding()).accentColor);
  // The dashboard's interface language on CMS pages, a site page's own language elsewhere.
  const { locale, direction } = await documentLanguage();

  return (
    // The font variables sit on <html>, so the tokens declared on :root can use them.
    <html lang={locale} dir={direction} className={`${geistSans.variable} ${geistMono.variable}`}>
      {(theme || accent) && <head>{theme && <style>{theme}</style>}{accent && <style>{accent}</style>}</head>}
      <body className="cms-root">
        {children}
      </body>
    </html>
  );
}
