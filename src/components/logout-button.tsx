"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogout() {
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        throw new Error("Logout failed");
      }

      window.location.replace("/login");
    } catch {
      setError("Could not sign out. Try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="dashboard-logout">
      <Button className="w-full justify-start" type="button" variant="ghost" onClick={handleLogout} disabled={isSubmitting}>
        <LogOut data-icon="inline-start" aria-hidden="true" />
        {isSubmitting ? "Signing out..." : "Sign out"}
      </Button>
      {error && (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
