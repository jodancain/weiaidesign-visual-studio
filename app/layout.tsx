import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://weiaidesign.com"),
  title: {
    default: "Youngtuo Visual Studio | AI 视觉生成工作台",
    template: "%s | weiaidesign.com",
  },
  description: "面向内部项目的 GPT 生图、画布挑图、图生视频和跨项目资产 API。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
