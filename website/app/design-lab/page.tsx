import type { Metadata } from "next";
import { DesignLab } from "../components/DesignLab";

export const metadata: Metadata = {
  title: "统一站点视觉实验",
  description: "Morphz 统一站点的三个视觉方向对照实验。",
};

export default function DesignLabPage() {
  return <DesignLab />;
}
