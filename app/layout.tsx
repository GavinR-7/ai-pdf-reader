import type { Metadata } from "next";
import { Source_Serif_4, Inter } from "next/font/google";
import "./globals.css";

/*
 * Two families, with a clear division of labour:
 *
 *   Source Serif 4 — the document itself. A serif at reading size is easier to
 *   track across long lines, and it signals "this is a text to read" rather
 *   than "this is an app UI".
 *
 *   Inter — controls, labels, and numbers. Kept visually distinct from the
 *   document so the reader never confuses interface with content.
 */
const reading = Source_Serif_4({
  variable: "--font-reading",
  subsets: ["latin"],
  display: "swap",
});

const ui = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PDF Reader",
  description: "Read a PDF aloud, sentence by sentence, with a grounded summary.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${reading.variable} ${ui.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
