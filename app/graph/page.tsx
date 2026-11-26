import { Suspense } from "react";
import { GraphExplorer } from "@/components/graph-explorer";

export default function Page() {
  return (
    <Suspense>
      <GraphExplorer />
    </Suspense>
  );
}
