"use client";

import { Clock3 } from "lucide-react";
import { useRef, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

export function ReadingInfo({
  title,
  observedAt,
  status,
  detail,
}: {
  title: string;
  observedAt: string | null;
  status: "loading" | "available" | "stale" | "unavailable";
  detail: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const description = observedAt
    ? `${status === "stale" ? "Last successful reading" : "Updated"}: ${new Date(observedAt).toLocaleString()}`
    : status === "loading"
      ? "Waiting for the first reading."
      : "No measurement available.";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={trigger}
        openOnHover
        delay={700}
        closeDelay={150}
        className="reading-info-trigger"
        aria-label={`${title} reading details`}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
      >
        <Clock3 aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        initialFocus={false}
        finalFocus={false}
        container={trigger.current?.closest<HTMLElement>("main") ?? undefined}
      >
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>
          {observedAt ? (
            <time dateTime={observedAt}>{description}</time>
          ) : (
            description
          )}
        </PopoverDescription>
        <p>{detail}</p>
      </PopoverContent>
    </Popover>
  );
}
