import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "@/components/login-form";
import { Wordmark } from "@/components/wordmark";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="sign-in-title">
        <Wordmark />
        <Card size="sm">
          <CardHeader>
            <CardTitle id="sign-in-title" role="heading" aria-level={1}>Sign in</CardTitle>
            <CardDescription>Enter your password to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
