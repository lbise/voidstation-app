import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="sign-in-title">
        <div className="dashboard-wordmark">
          <span className="dashboard-mark" aria-hidden="true">V<span>/</span></span>
          voidstation<span className="dashboard-wordmark-dot" aria-hidden="true">.</span>
        </div>
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
