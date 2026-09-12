"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type ErrorResponse = {
  error?: unknown;
};

async function responseError(response: Response): Promise<string> {
  try {
    const payload: ErrorResponse = await response.json();
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Use the status-specific fallback below when the response cannot be read.
  }

  return response.status === 429
    ? "Too many sign-in attempts. Try again shortly."
    : "Unable to sign in. Check the password and try again.";
}

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const form = new FormData(event.currentTarget);
    const password = form.get("password");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: typeof password === "string" ? password : "" }),
      });

      if (!response.ok) {
        setError(await responseError(response));
        return;
      }

      window.location.replace("/");
    } catch {
      setError("Unable to sign in. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <FieldGroup>
        <Field data-invalid={Boolean(error)} data-disabled={isSubmitting}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            className="min-h-11"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={12}
            maxLength={1024}
            required
            disabled={isSubmitting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          {error && <FieldError id="sign-in-error">{error}</FieldError>}
        </Field>
        <Button className="min-h-11 w-full" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Sign in"}
        </Button>
        <p className="visually-hidden" aria-live="polite">
          {isSubmitting ? "Signing in" : ""}
        </p>
      </FieldGroup>
    </form>
  );
}
